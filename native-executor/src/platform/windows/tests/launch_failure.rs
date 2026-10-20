#[cfg(test)]
mod tests {
    use super::super::*;
    use crate::protocol::{LocalToolchainGrant, RunLimits, ToolchainGrantRole};
    use crate::request_validation::validate_run;
    use launch::test_fault::inject;
    use windows_sys::Win32::Foundation::{ERROR_ACCESS_DENIED, ERROR_ILLEGAL_DLL_RELOCATION};

    struct TestExecutor {
        platform: WindowsPlatform,
        root: PathBuf,
    }

    impl TestExecutor {
        fn new() -> Self {
            let (platform, root) =
                WindowsPlatform::initialize().expect("initialize owned test executor");
            Self { platform, root }
        }

        fn spec(&self, id: &str, role: RunRole) -> RunSpec {
            let workspace = self.root.join("workspaces").join(id);
            fs::create_dir(&workspace).expect("create test workspace");
            fs::copy(
                std::env::current_exe().expect("test binary"),
                workspace.join("probe.exe"),
            )
            .expect("stage harmless test harness binary");
            let executable_id = if role == RunRole::CheckerRuntime {
                let cached = self.root.join("toolchains").join(id);
                fs::create_dir(&cached).unwrap();
                fs::copy(workspace.join("probe.exe"), cached.join("probe.exe")).unwrap();
                format!("toolchains/{id}/probe.exe")
            } else {
                format!("workspaces/{id}/probe.exe")
            };
            RunSpec {
                run_id: format!("run_{id}"),
                role,
                workspace_id: id.into(),
                executable_id,
                args: vec!["--list".into()],
                stdin_file: None,
                stdout_file: "stdout.txt".into(),
                stderr_file: "stderr.txt".into(),
                environment: BTreeMap::new(),
                toolchain: None,
                local_toolchain: None,
                limits: RunLimits {
                    wall_time_ms: 5000,
                    memory_bytes: 128 * 1024 * 1024,
                    process_count: 1,
                    thread_count: 16,
                    output_bytes: 1024 * 1024,
                    total_write_bytes: 4 * 1024 * 1024,
                    open_files: 32,
                    created_files: 32,
                },
            }
        }
    }

    impl Drop for TestExecutor {
        fn drop(&mut self) {
            let root = owned_executor_test_root(&self.root);
            for _ in 0..100 {
                if fs::remove_dir_all(&root).is_ok() || !root.exists() {
                    return;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            assert!(
                !root.exists(),
                "owned test executor must be cleaned: {}",
                root.display()
            );
        }
    }

    #[test]
    fn relocation_failure_never_retries_any_single_run_role() {
        let _lock = TEST_SHARED_INITIALIZATION_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let executor = TestExecutor::new();
        for (index, (role, managed_runtime)) in [
            (RunRole::Submission, false),
            (RunRole::Compiler, false),
            (RunRole::Checker, false),
            (RunRole::CheckerRuntime, false),
            (RunRole::SecurityProbe, false),
            (RunRole::Submission, true),
        ]
        .into_iter()
        .enumerate()
        {
            let mut spec = executor.spec(&format!("relocation_{index}"), role);
            if managed_runtime {
                spec.executable_id = "local-toolchain/probe.exe".into();
                spec.environment
                    .insert("JUDGEDESK_JAVA_ISOLATED".into(), "1".into());
                spec.local_toolchain = Some(LocalToolchainGrant {
                    root_path: executor
                        .root
                        .join("workspaces")
                        .join(&spec.workspace_id)
                        .to_string_lossy()
                        .into_owned(),
                    executable_relative_path: "probe.exe".into(),
                    isolation: LocalToolchainIsolation::Strict,
                    role: ToolchainGrantRole::SubmissionRuntime,
                });
            }
            let paths = validate_run(&executor.root, &spec).unwrap();
            let active = ActiveRuns::default();
            let (result, attempts, children) = inject(1, ERROR_ILLEGAL_DLL_RELOCATION, || {
                executor.platform.run(&spec, &paths, &active)
            });
            assert_eq!(
                attempts, 1,
                "{role:?}: a failed launch must not retry with fewer attributes"
            );
            assert!(children.is_empty(), "{role:?}: no process may have started");
            assert!(matches!(result.reason, RunReason::LaunchError));
            assert!(
                result.diagnostic.as_deref().unwrap().contains("623"),
                "original error is retained"
            );
            assert!(active.lock().unwrap().is_empty());
            assert_eq!(fs::read(&paths.stdout).unwrap(), b"");
            assert_eq!(fs::read(&paths.stderr).unwrap(), b"");
        }
    }

    #[test]
    fn relocation_failure_never_retries_either_interactive_participant() {
        let _lock = TEST_SHARED_INITIALIZATION_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let executor = TestExecutor::new();
        for (index, (fail_at, role, error)) in [
            (1, RunRole::Checker, ERROR_ILLEGAL_DLL_RELOCATION),
            (2, RunRole::Checker, ERROR_ILLEGAL_DLL_RELOCATION),
            (1, RunRole::CheckerRuntime, ERROR_ILLEGAL_DLL_RELOCATION),
            (2, RunRole::CheckerRuntime, ERROR_ILLEGAL_DLL_RELOCATION),
            (1, RunRole::Checker, ERROR_NOT_ENOUGH_MEMORY),
            (2, RunRole::Checker, ERROR_NOT_ENOUGH_MEMORY),
            (2, RunRole::Checker, ERROR_ACCESS_DENIED),
        ]
        .into_iter()
        .enumerate()
        {
            let spec = InteractiveRunSpec {
                run_id: format!("pair_{index}"),
                submission: executor.spec(&format!("submission_{index}"), RunRole::Submission),
                interactor: executor.spec(&format!("interactor_{index}"), role),
            };
            let active = ActiveRuns::default();
            let (result, attempts, children) = inject(fail_at, error, || {
                executor
                    .platform
                    .run_interactive(&executor.root, &spec, &active)
            });
            assert_eq!(
                attempts, fail_at,
                "no retry and no later participant after a failed spawn"
            );
            assert_eq!(
                result.verdict,
                if fail_at == 1 && error == ERROR_NOT_ENOUGH_MEMORY {
                    "MLE"
                } else {
                    "JE"
                }
            );
            if error == ERROR_ILLEGAL_DLL_RELOCATION {
                assert!(
                    result.message.as_deref().unwrap().contains("623"),
                    "original error is retained"
                );
            }
            assert_eq!(children.len(), (fail_at - 1) as usize);
            for child in &children {
                // SAFETY: the duplicate retains the exact first child, not a reusable PID.
                assert_eq!(
                    unsafe { WaitForSingleObject(child.0, 0) },
                    WAIT_OBJECT_0,
                    "the first suspended child must be terminated before returning JE"
                );
            }
            assert!(active.lock().unwrap().is_empty());
            for participant in [&spec.submission, &spec.interactor] {
                let stderr = executor
                    .root
                    .join("workspaces")
                    .join(&participant.workspace_id)
                    .join("stderr.txt");
                assert_eq!(fs::read(stderr).unwrap(), b"");
            }
        }
    }

    #[test]
    fn failed_child_drain_stops_executor() {
        const CHILD_FLAG: &str = "JUDGEDESK_TEST_INVALID_DRAIN";
        if std::env::var_os(CHILD_FLAG).is_some() {
            // No child or Job exists: invalid handles deterministically make verification fail.
            launch::drain_child_or_exit(null_mut(), null_mut(), "test child");
            panic!("unverified drain must never return");
        }
        let child = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "platform::windows::tests::launch_failure::tests::failed_child_drain_stops_executor",
            "--nocapture",
        ])
        .env(CHILD_FLAG, "1")
        .output()
        .unwrap();
        assert_eq!(child.status.code(), Some(1));
        assert!(String::from_utf8_lossy(&child.stderr).contains("executor stopping fail-closed"));
    }

    #[test]
    fn successful_single_launch_still_executes_inside_the_existing_boundary() {
        let _lock = TEST_SHARED_INITIALIZATION_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let executor = TestExecutor::new();
        let spec = executor.spec("successful_launch", RunRole::Submission);
        let paths = validate_run(&executor.root, &spec).unwrap();
        let active = ActiveRuns::default();
        let result = executor.platform.run(&spec, &paths, &active);
        assert!(matches!(result.reason, RunReason::Exited), "{result:?}");
        assert_eq!(result.exit_code, Some(0), "{result:?}");
        assert!(!fs::read(&paths.stdout).unwrap().is_empty());
        assert!(active.lock().unwrap().is_empty());
    }

    #[test]
    fn single_run_creation_errors_keep_memory_and_launch_classification() {
        let _lock = TEST_SHARED_INITIALIZATION_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let executor = TestExecutor::new();
        for (index, error) in [
            ERROR_NOT_ENOUGH_MEMORY,
            ERROR_OUTOFMEMORY,
            ERROR_COMMITMENT_LIMIT,
            ERROR_ACCESS_DENIED,
        ]
        .into_iter()
        .enumerate()
        {
            let spec = executor.spec(&format!("creation_{index}"), RunRole::Submission);
            let paths = validate_run(&executor.root, &spec).unwrap();
            let (result, attempts, children) = inject(1, error, || {
                executor.platform.run(&spec, &paths, &ActiveRuns::default())
            });
            assert_eq!(attempts, 1);
            assert!(children.is_empty());
            if error == ERROR_ACCESS_DENIED {
                assert!(matches!(result.reason, RunReason::LaunchError));
            } else {
                assert!(matches!(result.reason, RunReason::MemoryLimit));
            }
        }
    }

    #[test]
    fn relocation_failure_disables_startup_readiness() {
        let _lock = TEST_SHARED_INITIALIZATION_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let mut executor = TestExecutor::new();
        let (health, attempts, children) = inject(1, ERROR_ILLEGAL_DLL_RELOCATION, || {
            executor.platform.self_test = executor.platform.run_self_test(&executor.root);
            executor.platform.health(&executor.root)
        });
        assert_eq!(attempts, 1);
        assert!(children.is_empty());
        assert!(!health.ready);
        assert!(health
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.contains("623")));
    }
}
