use super::{failure, root_display, ActiveRuns};
use crate::fault_trace::{FaultTrace, FaultTraceEvent, FAULT_EVENT_LOG_ENV, FAULT_GATE_ENV};
use crate::guardian_protocol::{
    generate_nonce, FrameIdentity, LauncherMonitorLimits, LauncherRlimits, LauncherSpec,
};
use crate::protocol::{ExecutorHealth, RunLimits, RunReason, RunResult, RunRole, RunSpec};
use crate::request_validation::{validate_run, ValidatedRun};
use crate::workspace::initialize_root;
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;

const TRUSTED_SUPERVISOR_NPROC_OVERHEAD: u64 = 1;
const OBSERVABLE_PROCESS_LIMIT_OVERFLOW: u64 = 1;
const REAL_USER_PROCESS_DRIFT_ALLOWANCE: u64 = 4;

pub struct MacosPlatform {
    self_test: SelfTest,
}

struct SelfTest {
    ready: bool,
    diagnostics: Vec<String>,
    network_blocked: bool,
    filesystem_isolated: bool,
    process_tree_controlled: bool,
}

impl MacosPlatform {
    pub fn initialize() -> Result<(Self, PathBuf), String> {
        if !Path::new("/usr/bin/sandbox-exec").is_file() {
            return Err("SECURE_RUNNER_UNAVAILABLE: /usr/bin/sandbox-exec was not found".into());
        }
        let root = initialize_root(std::env::temp_dir())?;
        emit_fault_gate_ready()?;
        let mut platform = Self {
            self_test: SelfTest {
                ready: false,
                diagnostics: vec!["security self-test has not run".into()],
                network_blocked: false,
                filesystem_isolated: false,
                process_tree_controlled: false,
            },
        };
        platform.self_test = platform.run_self_test(&root);
        Ok((platform, root))
    }

    pub fn health(&self, root: &Path) -> ExecutorHealth {
        ExecutorHealth {
            ready: self.self_test.ready,
            mode: "macos-seatbelt-native".into(),
            executor_version: env!("CARGO_PKG_VERSION").into(),
            executor_root: root_display(root),
            diagnostics: self.self_test.diagnostics.clone(),
            network_blocked: self.self_test.network_blocked,
            filesystem_isolated: self.self_test.filesystem_isolated,
            process_tree_controlled: self.self_test.process_tree_controlled,
            memory_limit_supported: self.self_test.ready,
        }
    }

    fn run_self_test(&self, root: &Path) -> SelfTest {
        let result = (|| -> Result<SelfTest, String> {
            let workspace_id = "startup_self_test";
            let workspace = root.join("workspaces").join(workspace_id);
            if workspace.exists() {
                fs::remove_dir_all(&workspace)
                    .map_err(|error| format!("cannot reset security probe workspace: {error}"))?;
            }
            fs::create_dir(&workspace)
                .map_err(|error| format!("cannot create security probe workspace: {error}"))?;
            let current_exe = std::env::current_exe()
                .map_err(|error| format!("cannot locate security probe executable: {error}"))?;
            // Keep executable code outside the writable workspace. macOS vnguard can abort
            // executable mappings from a sandbox-writable location before the target reaches
            // main(), even when Seatbelt otherwise permits process-exec for that exact path.
            let staged_exe = root.join("artifacts").join("security-probe");
            fs::copy(&current_exe, &staged_exe)
                .map_err(|error| format!("cannot stage security probe: {error}"))?;
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&staged_exe, fs::Permissions::from_mode(0o500))
                .map_err(|error| format!("cannot make security probe executable: {error}"))?;

            let sentinel = std::env::temp_dir().join(format!(
                "judgedesk-sentinel-{}-{}.txt",
                std::process::id(),
                workspace_id
            ));
            fs::write(&sentinel, b"JUDGEDESK_SENTINEL")
                .map_err(|error| format!("cannot create security sentinel: {error}"))?;
            let spec = RunSpec {
                run_id: "startup_self_test_run".into(),
                role: RunRole::SecurityProbe,
                workspace_id: workspace_id.into(),
                executable_id: "artifacts/security-probe".into(),
                args: vec![
                    "--security-probe-child".into(),
                    sentinel.to_string_lossy().into_owned(),
                ],
                stdin_file: None,
                stdout_file: "probe.stdout".into(),
                stderr_file: "probe.stderr".into(),
                environment: Default::default(),
                toolchain: None,
                limits: RunLimits {
                    wall_time_ms: 5_000,
                    memory_bytes: 128 * 1024 * 1024,
                    // The probe forks short-lived children so each prohibited process-group
                    // operation is tested in isolation without changing the probe parent's PGID.
                    process_count: 4,
                    thread_count: 16,
                    output_bytes: 1024 * 1024,
                    total_write_bytes: 4 * 1024 * 1024,
                    open_files: 32,
                    created_files: 16,
                },
            };
            let active: ActiveRuns =
                Arc::new(std::sync::Mutex::new(std::collections::HashMap::new()));
            let run = self.run_inner(root, &spec, &active)?;
            let output = fs::read_to_string(workspace.join("probe.stdout"))
                .map_err(|error| {
                    format!(
                        "cannot read security probe: {error}; runReason={:?}; runExit={:?}; runSignal={:?}; runDiagnostic={:?}",
                        run.reason, run.exit_code, run.signal_or_status, run.diagnostic
                    )
                })?;
            let probe: serde_json::Value = serde_json::from_str(output.trim()).map_err(|error| {
                let stderr = fs::read_to_string(workspace.join("probe.stderr"))
                    .unwrap_or_default()
                    .chars()
                    .take(1024)
                    .collect::<String>();
                format!(
                    "security probe returned invalid JSON: {error}; reason={:?}; exitCode={:?}; signal={:?}; diagnostic={:?}; stderr={stderr:?}",
                    run.reason, run.exit_code, run.signal_or_status, run.diagnostic
                )
            })?;
            let mut process_limit_spec = spec.clone();
            process_limit_spec.run_id = "startup_process_limit_probe".into();
            process_limit_spec.args =
                vec!["--test-process-bomb".into(), "128".into(), "500".into()];
            process_limit_spec.stdout_file = "process-limit.stdout".into();
            process_limit_spec.stderr_file = "process-limit.stderr".into();
            let process_limit_run = self.run_inner(root, &process_limit_spec, &active)?;
            let sentinel_intact = fs::read(&sentinel)
                .map(|value| value == b"JUDGEDESK_SENTINEL")
                .unwrap_or(false);
            let _ = fs::remove_file(&sentinel);
            let _ = fs::remove_dir_all(&workspace);

            let filesystem = probe["readBlocked"].as_bool() == Some(true)
                && probe["writeBlocked"].as_bool() == Some(true)
                && sentinel_intact;
            let network = probe["networkBlocked"].as_bool() == Some(true);
            // The security profile denies posix_spawn for group containment, so a Command-based
            // probe would pass even if the process-exec allowlist disappeared. The probe uses
            // fork+execve and requires execve itself to return EPERM.
            let exec_boundary = probe["processAttemptStarted"].as_bool() == Some(true)
                && probe["forbiddenExecBlockedWithEperm"].as_bool() == Some(true)
                && matches!(run.reason, RunReason::Exited)
                && run.exit_code == Some(0);
            let process_limit = matches!(process_limit_run.reason, RunReason::ProcessLimit);
            // A generic launch failure is not proof of containment. Every escape primitive must
            // fail specifically with EPERM, and the forked direct-syscall probes also verify that
            // their inherited process group did not change.
            let group_escape = &probe["processGroupEscape"];
            let setpgid_blocked = group_escape["setpgidBlockedWithEperm"].as_bool() == Some(true);
            let setsid_blocked = group_escape["setsidBlockedWithEperm"].as_bool() == Some(true);
            let posix_spawn_group_blocked =
                group_escape["posixSpawnGroupBlockedWithEperm"].as_bool() == Some(true);
            let group_escape_blocked =
                setpgid_blocked && setsid_blocked && posix_spawn_group_blocked;
            let process = exec_boundary && process_limit && group_escape_blocked;
            let ready = filesystem && network && process;
            Ok(SelfTest {
                ready,
                diagnostics: if ready {
                    Vec::new()
                } else {
                    vec![format!(
                        "SECURE_RUNNER_SELF_TEST_FAILED: filesystem={filesystem}, network={network}, execBoundary={exec_boundary}, execDetail={}, processLimit={process_limit}, groupEscape={group_escape_blocked}, setpgid={}, setsid={}, posixSpawnGroup={}, probeReason={:?}, processLimitReason={:?}",
                        probe["forbiddenExecDetail"],
                        group_escape["setpgidDetail"],
                        group_escape["setsidDetail"],
                        group_escape["posixSpawnGroupDetail"],
                        run.reason,
                        process_limit_run.reason
                    )]
                },
                network_blocked: network,
                filesystem_isolated: filesystem,
                process_tree_controlled: process,
            })
        })();

        result.unwrap_or_else(|error| SelfTest {
            ready: false,
            diagnostics: vec![format!("SECURE_RUNNER_SELF_TEST_FAILED: {error}")],
            network_blocked: false,
            filesystem_isolated: false,
            process_tree_controlled: false,
        })
    }

    pub fn run(
        &self,
        root: &Path,
        spec: &RunSpec,
        _paths: &ValidatedRun,
        active: &ActiveRuns,
    ) -> RunResult {
        match self.run_inner(root, spec, active) {
            Ok(result) => result,
            Err(error) => failure(spec, RunReason::LaunchError, error),
        }
    }

    fn run_inner(
        &self,
        root: &Path,
        spec: &RunSpec,
        active: &ActiveRuns,
    ) -> Result<RunResult, String> {
        crate::macos_run_controller::run_with_guardian(root, spec, active)
    }
}

fn emit_fault_gate_ready() -> Result<(), String> {
    if std::env::var_os(FAULT_GATE_ENV).is_none() && std::env::var_os(FAULT_EVENT_LOG_ENV).is_none()
    {
        return Ok(());
    }
    let generation = std::env::var(crate::tree_guard::GENERATION_ENV)
        .map_err(|_| "RUN_GUARDIAN_FAULT_TRACE_TREE_GENERATION_MISSING".to_string())?;
    let trace = FaultTrace::from_environment(&generation)?
        .ok_or_else(|| "RUN_GUARDIAN_FAULT_TRACE_NOT_INITIALIZED".to_string())?;
    trace.emit(
        FaultTraceEvent::FaultGateReady,
        "executor",
        None,
        None,
        None,
    )
}

fn hard_resource_limit(resource: libc::c_int) -> Result<u64, String> {
    let mut limit: libc::rlimit = unsafe { std::mem::zeroed() };
    if unsafe { libc::getrlimit(resource, &mut limit) } != 0 {
        return Err(format!(
            "getrlimit resource={resource}: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(limit.rlim_max)
}

fn launcher_nproc_ceiling(
    user_process_baseline: u64,
    inherited_nproc_max: u64,
    process_count: u32,
) -> Result<u64, String> {
    let required = user_process_baseline
        .saturating_add(TRUSTED_SUPERVISOR_NPROC_OVERHEAD)
        .saturating_add(process_count as u64)
        .saturating_add(OBSERVABLE_PROCESS_LIMIT_OVERFLOW)
        .saturating_add(REAL_USER_PROCESS_DRIFT_ALLOWANCE);
    if required > inherited_nproc_max {
        return Err(format!(
            "RLIMIT_NPROC cannot provide safe launch headroom: baseline={user_process_baseline}, required={required}, hardMax={inherited_nproc_max}"
        ));
    }
    Ok(required)
}

fn minimal_environment(spec: &RunSpec, workspace: &Path) -> BTreeMap<String, String> {
    let mut values = spec.environment.clone();
    // HOME and TMPDIR are containment controls, not contestant-configurable values. PATH may
    // still be supplied by a certified managed toolchain, so only default it when absent.
    values.insert("HOME".into(), workspace.to_string_lossy().into_owned());
    values.insert("TMPDIR".into(), workspace.to_string_lossy().into_owned());
    values
        .entry("PATH".into())
        .or_insert_with(|| "/usr/bin:/bin".into());
    values
}

pub(crate) fn prepare_launcher_spec(
    root: &Path,
    spec: &RunSpec,
    identity: &FrameIdentity,
) -> Result<LauncherSpec, String> {
    identity
        .validate()
        .map_err(|error| format!("invalid run guardian identity: {error}"))?;
    if identity.run_id != spec.run_id {
        return Err("run guardian identity does not match the requested run".into());
    }
    let paths = validate_run(root, spec)?;
    let profile = build_profile(spec, &paths)?;
    let profile_path = write_private_profile(root, &spec.run_id, &profile)?;

    let result = (|| {
        let launch_executable =
            if matches!(spec.role, RunRole::Compiler) && spec.toolchain.is_none() {
                validated_compiler_executable(spec)?
            } else {
                paths.executable.clone()
            };

        let address_space_slack = spec
            .limits
            .memory_bytes
            .saturating_mul(8)
            .max(512 * 1024 * 1024);
        let guardian_virtual_size = process_virtual_memory_bytes(std::process::id() as i32);
        let address_space_bytes = (guardian_virtual_size > 0).then(|| {
            guardian_virtual_size
                .saturating_mul(2)
                .max(guardian_virtual_size.saturating_add(address_space_slack))
        });

        // Seatbelt must allow fork because sandbox-exec itself forks before exec. The guardian
        // takes this real-user snapshot before spawning the trusted supervisor, so reserve that
        // supervisor separately from the untrusted process budget. One observable overflow lets
        // the group monitor classify process_limit before RLIMIT_NPROC clamps the burst. A small,
        // fixed drift allowance absorbs unrelated same-user daemon churn between this snapshot
        // and target forks. RLIMIT_NPROC is per real user rather than per process group: this
        // therefore caps the net increase in that user's process population, while the guardian
        // monitor enforces the exact per-run process limit.
        let user_process_baseline = real_user_process_count()?;
        let inherited_nproc_max = hard_resource_limit(libc::RLIMIT_NPROC)?;
        let nproc_ceiling = launcher_nproc_ceiling(
            user_process_baseline,
            inherited_nproc_max,
            spec.limits.process_count,
        )?;

        Ok(LauncherSpec {
            sandbox_executable: PathBuf::from("/usr/bin/sandbox-exec"),
            sandbox_profile: profile_path.clone(),
            target_executable: launch_executable,
            arguments: spec.args.clone(),
            cwd: paths.workspace.clone(),
            stdin: paths.stdin.unwrap_or_else(|| PathBuf::from("/dev/null")),
            stdout: paths.stdout,
            stderr: paths.stderr,
            environment: minimal_environment(spec, &paths.workspace),
            limits: LauncherRlimits {
                core_bytes: 0,
                file_size_bytes: spec.limits.total_write_bytes,
                open_files: spec.limits.open_files as u64,
                nproc_ceiling,
                address_space_bytes,
            },
            monitor_limits: LauncherMonitorLimits {
                wall_time_ms: spec.limits.wall_time_ms,
                memory_bytes: spec.limits.memory_bytes,
                process_count: spec.limits.process_count,
                thread_count: spec.limits.thread_count,
                output_bytes: spec.limits.output_bytes,
                total_write_bytes: spec.limits.total_write_bytes,
                created_files: spec.limits.created_files,
            },
        })
    })();

    if result.is_err() {
        let _ = fs::remove_file(&profile_path);
    }
    result
}

fn write_private_profile(root: &Path, run_id: &str, contents: &str) -> Result<PathBuf, String> {
    let profile_directory = trusted_profile_directory(root)?;

    let nonce =
        generate_nonce().map_err(|error| format!("cannot generate profile nonce: {error}"))?;
    let profile_path = profile_directory.join(format!("{run_id}-{nonce}.sb"));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
        .open(&profile_path)
        .map_err(|error| format!("cannot create Seatbelt profile: {error}"))?;
    if let Err(error) = file
        .write_all(contents.as_bytes())
        .and_then(|_| file.sync_all())
    {
        drop(file);
        let _ = fs::remove_file(&profile_path);
        return Err(format!("cannot persist Seatbelt profile: {error}"));
    }
    if let Err(error) = fs::set_permissions(&profile_path, fs::Permissions::from_mode(0o600)) {
        drop(file);
        let _ = fs::remove_file(&profile_path);
        return Err(format!("cannot protect Seatbelt profile: {error}"));
    }
    let metadata = match file.metadata() {
        Ok(metadata) => metadata,
        Err(error) => {
            drop(file);
            let _ = fs::remove_file(&profile_path);
            return Err(format!("cannot inspect Seatbelt profile: {error}"));
        }
    };
    if !metadata.file_type().is_file()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.permissions().mode() & 0o777 != 0o600
        || metadata.nlink() != 1
    {
        let _ = fs::remove_file(&profile_path);
        return Err("Seatbelt profile file is not trusted".into());
    }
    Ok(profile_path)
}

pub(crate) fn cleanup_run_profiles(root: &Path, run_id: &str) -> Result<(), String> {
    if run_id.is_empty()
        || !run_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("cannot clean profiles for an invalid run ID".into());
    }
    let directory = trusted_profile_directory(root)?;
    let prefix = format!("{run_id}-");
    for entry in fs::read_dir(&directory)
        .map_err(|error| format!("cannot enumerate Seatbelt profile cache: {error}"))?
    {
        let entry =
            entry.map_err(|error| format!("cannot enumerate Seatbelt profile entry: {error}"))?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| "Seatbelt profile cache contains a non-Unicode entry".to_string())?;
        let Some(nonce) = name
            .strip_prefix(&prefix)
            .and_then(|value| value.strip_suffix(".sb"))
        else {
            continue;
        };
        if nonce.len() != 64
            || !nonce
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err("Seatbelt profile cache contains a malformed run artifact".into());
        }
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| format!("cannot inspect Seatbelt profile artifact: {error}"))?;
        if !metadata.file_type().is_file()
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.permissions().mode() & 0o777 != 0o600
            || metadata.nlink() != 1
        {
            return Err("Seatbelt profile artifact is not trusted".into());
        }
        fs::remove_file(&path)
            .map_err(|error| format!("cannot remove Seatbelt profile artifact: {error}"))?;
    }
    Ok(())
}

fn trusted_profile_directory(root: &Path) -> Result<PathBuf, String> {
    let canonical_root =
        fs::canonicalize(root).map_err(|error| format!("executor root unavailable: {error}"))?;
    let profile_directory = fs::canonicalize(canonical_root.join("profiles"))
        .map_err(|error| format!("Seatbelt profile cache unavailable: {error}"))?;
    if profile_directory.parent() != Some(canonical_root.as_path()) {
        return Err("Seatbelt profile cache escaped the executor root".into());
    }
    let directory_metadata = fs::metadata(&profile_directory)
        .map_err(|error| format!("cannot inspect Seatbelt profile cache: {error}"))?;
    if !directory_metadata.is_dir()
        || directory_metadata.uid() != unsafe { libc::geteuid() }
        || directory_metadata.permissions().mode() & 0o777 != 0o700
    {
        return Err("Seatbelt profile cache is not owner-private".into());
    }
    Ok(profile_directory)
}

fn build_profile(spec: &RunSpec, paths: &ValidatedRun) -> Result<String, String> {
    let canonical_workspace =
        fs::canonicalize(&paths.workspace).map_err(|error| error.to_string())?;
    let canonical_executable =
        fs::canonicalize(&paths.executable).map_err(|error| error.to_string())?;
    let workspace = seatbelt_literal(&canonical_workspace.to_string_lossy());
    let executable = seatbelt_literal(&canonical_executable.to_string_lossy());
    let mut read_rules = vec![
        format!("(literal \"{executable}\")"),
        format!("(subpath \"{workspace}\")"),
        "(literal \"/\")".into(),
        "(subpath \"/Library/Apple\")".into(),
        "(subpath \"/System\")".into(),
        "(subpath \"/System/Library\")".into(),
        // Modern macOS stores the dyld shared cache and other sealed OS content in Cryptexes.
        // Without these read-only roots, dyld aborts in CacheFinder before the target reaches
        // main(). Keep the allowance limited to sealed system Cryptex content.
        "(subpath \"/System/Cryptexes\")".into(),
        "(subpath \"/System/Volumes/Preboot/Cryptexes\")".into(),
        "(subpath \"/System/iOSSupport/System/Library\")".into(),
        "(subpath \"/usr/lib\")".into(),
        "(subpath \"/usr/share\")".into(),
        "(literal \"/usr/bin/sandbox-exec\")".into(),
        "(literal \"/dev/null\")".into(),
        "(literal \"/dev/random\")".into(),
        "(literal \"/dev/urandom\")".into(),
    ];
    let mut process_exec_rules = vec![
        format!("(literal \"{executable}\")"),
        "(literal \"/usr/bin/sandbox-exec\")".into(),
    ];
    // Some managed hosts (notably dotnet) resolve their own executable before loading the
    // runtime. Seatbelt's subpath read grant does not implicitly grant metadata traversal on
    // lexical ancestors such as /Users and /Users/<name>. Permit only exact, already-known
    // ancestors; directory contents and sibling file data remain inaccessible.
    let mut metadata_rules = std::collections::BTreeSet::from([
        "(literal \"/\")".to_string(),
        "(literal \"/etc\")".to_string(),
        "(literal \"/tmp\")".to_string(),
        "(literal \"/var\")".to_string(),
        "(subpath \"/private/var\")".to_string(),
        "(literal \"/System/Volumes\")".to_string(),
        "(literal \"/System/Volumes/Data\")".to_string(),
        "(literal \"/System/Volumes/Data/Users\")".to_string(),
        "(literal \"/System/Volumes/Preboot\")".to_string(),
        "(literal \"/System/Volumes/Preboot/Cryptexes\")".to_string(),
        "(literal \"/System/Cryptexes\")".to_string(),
        "(literal \"/dev\")".to_string(),
        "(regex \"^/dev/.*$\")".to_string(),
    ]);
    add_metadata_ancestor_rules(&mut metadata_rules, &canonical_workspace);
    add_metadata_ancestor_rules(&mut metadata_rules, &canonical_executable);
    let toolchain_package_root = paths.toolchain_package_root.as_deref().or_else(|| {
        paths.executable.ancestors().find(|path| {
            path.parent()
                .and_then(Path::file_name)
                .is_some_and(|name| name == "toolchains")
        })
    });
    if let Some(toolchain_package_root) = toolchain_package_root {
        add_metadata_ancestor_rules(&mut metadata_rules, toolchain_package_root);
        read_rules.push(format!(
            "(subpath \"{}\")",
            seatbelt_literal(&toolchain_package_root.to_string_lossy())
        ));
        if matches!(spec.role, RunRole::Compiler) {
            process_exec_rules.push(format!(
                "(subpath \"{}\")",
                seatbelt_literal(&toolchain_package_root.to_string_lossy())
            ));
        }
    }
    if matches!(spec.role, RunRole::Compiler) {
        let platform_support_requested = [
            "JUDGEDESK_COMPILER_TOOLCHAIN_ROOT",
            "JUDGEDESK_COMPILER_DEVELOPER_ROOT",
            "JUDGEDESK_COMPILER_EXECUTABLE",
        ]
        .iter()
        .any(|key| spec.environment.contains_key(*key));
        if spec.toolchain.is_none() || platform_support_requested {
            let (toolchain_root, developer_root) = validated_compiler_roots(spec)?;
            for root in [&toolchain_root, &developer_root] {
                // Apple developer tools can resolve paths lexically (for example,
                // /Applications/Xcode.app/...) before opening files below the already
                // approved read-only root. Grant metadata traversal only on those exact
                // ancestors; this does not expose sibling directory contents.
                add_metadata_ancestor_rules(&mut metadata_rules, root);
                read_rules.push(format!(
                    "(subpath \"{}\")",
                    seatbelt_literal(&root.to_string_lossy())
                ));
            }
            process_exec_rules.push(format!(
                "(subpath \"{}\")",
                seatbelt_literal(&toolchain_root.to_string_lossy())
            ));
            process_exec_rules.push("(literal \"/usr/bin/ld\")".into());
            process_exec_rules.push("(literal \"/usr/bin/as\")".into());
        }
        if is_managed_fpc_compiler(spec) {
            // FPC 3.2.2 generates a workspace-local ppas.sh for its Darwin link phase.
            // The script uses only these immutable system utilities plus /usr/bin/ld,
            // which is already granted above. Seatbelt still confines every read/write
            // performed by the shell and keeps network access denied.
            for executable in ["/bin/sh", "/bin/cat", "/bin/rm"] {
                read_rules.push(format!("(literal \"{executable}\")"));
                process_exec_rules.push(format!("(literal \"{executable}\")"));
            }
        }
    }
    let process_group_escape_denials = match spec.role {
        // Apple Clang is a trusted launcher and requires posix_spawn for cc1, as, and ld.
        // Its children inherit the compiler process group; direct attempts to move the compiler
        // or one of those children to another group/session remain prohibited.
        RunRole::Compiler => "(deny syscall-unix (syscall-number SYS_setpgid SYS_setsid))",
        // Submission/checker code is not trusted. posix_spawn can apply SETPGROUP/SETSID inside
        // the kernel and bypass separate setpgid/setsid syscall denials, so deny all three.
        RunRole::Submission
        | RunRole::Checker
        | RunRole::CheckerRuntime
        | RunRole::SecurityProbe => {
            "(deny syscall-unix (syscall-number SYS_setpgid SYS_setsid SYS_posix_spawn))"
        }
    };
    Ok(format!(
        r#"(version 1)
(deny default)
{process_group_escape_denials}
(allow process-exec {})
(allow process-fork)
(allow signal (target same-sandbox))
(allow process-info* (target same-sandbox))
(allow syscall-unix
  (syscall-number
    SYS_shared_region_check_np
    SYS_shared_region_map_and_slide_2_np))
(deny network*)
(allow file-read* file-test-existence {})
(allow file-map-executable {})
(allow file-read-metadata file-test-existence {})
(allow file-write* (subpath "{workspace}"))
(allow sysctl-read)
(allow mach-lookup)
(allow iokit-open (iokit-registry-entry-class "RootDomainUserClient"))
(allow ipc-posix-sem)
(allow ipc-posix-shm-read* (ipc-posix-name-prefix "apple.cfprefs."))
(allow user-preference-read)
(allow system-mac-syscall (mac-policy-name "vnguard"))
(allow system-mac-syscall
  (require-all
    (mac-policy-name "Sandbox")
    (mac-syscall-number 67)))
"#,
        process_exec_rules.join(" "),
        read_rules.join(" "),
        read_rules.join(" "),
        metadata_rules.into_iter().collect::<Vec<_>>().join(" ")
    ))
}

fn add_metadata_ancestor_rules(rules: &mut std::collections::BTreeSet<String>, path: &Path) {
    for ancestor in path.ancestors().skip(1) {
        rules.insert(format!(
            "(literal \"{}\")",
            seatbelt_literal(&ancestor.to_string_lossy())
        ));
    }
}

fn is_managed_fpc_compiler(spec: &RunSpec) -> bool {
    matches!(spec.role, RunRole::Compiler)
        && spec.toolchain.as_ref().is_some_and(|grant| {
            grant.package_id == "fpc-macos-arm64"
                && grant.component_id == "fpc.compiler"
                && matches!(grant.role, crate::protocol::ToolchainGrantRole::Compiler)
        })
}

fn validated_compiler_roots(spec: &RunSpec) -> Result<(PathBuf, PathBuf), String> {
    let toolchain_value = spec
        .environment
        .get("JUDGEDESK_COMPILER_TOOLCHAIN_ROOT")
        .ok_or_else(|| "compiler toolchain root was not provided".to_string())?;
    let developer_value = spec
        .environment
        .get("JUDGEDESK_COMPILER_DEVELOPER_ROOT")
        .ok_or_else(|| "compiler developer root was not provided".to_string())?;
    let toolchain_root = fs::canonicalize(toolchain_value)
        .map_err(|error| format!("compiler toolchain root unavailable: {error}"))?;
    let developer_root = fs::canonicalize(developer_value)
        .map_err(|error| format!("compiler developer root unavailable: {error}"))?;

    let command_line_tools = Path::new("/Library/Developer/CommandLineTools");
    let approved_developer = developer_root == command_line_tools
        || (developer_root
            .file_name()
            .is_some_and(|name| name == "Developer")
            && developer_root
                .parent()
                .and_then(Path::file_name)
                .is_some_and(|name| name == "Contents")
            && developer_root
                .parent()
                .and_then(Path::parent)
                .and_then(Path::extension)
                .is_some_and(|extension| extension == "app")
            && developer_root.starts_with("/Applications"));
    let approved_toolchain = toolchain_root == developer_root
        || (toolchain_root.starts_with(developer_root.join("Toolchains"))
            && toolchain_root
                .file_name()
                .is_some_and(|name| name.to_string_lossy().ends_with(".xctoolchain")));
    if !approved_developer || !approved_toolchain {
        return Err("compiler support roots are outside approved Apple developer locations".into());
    }
    Ok((toolchain_root, developer_root))
}

fn validated_compiler_executable(spec: &RunSpec) -> Result<PathBuf, String> {
    let (toolchain_root, _) = validated_compiler_roots(spec)?;
    let executable_value = spec
        .environment
        .get("JUDGEDESK_COMPILER_EXECUTABLE")
        .ok_or_else(|| "compiler executable was not provided".to_string())?;
    let executable = fs::canonicalize(executable_value)
        .map_err(|error| format!("compiler executable unavailable: {error}"))?;
    let expected = fs::canonicalize(toolchain_root.join("usr").join("bin").join("clang"))
        .map_err(|error| format!("approved Apple Clang unavailable: {error}"))?;
    if executable != expected || !executable.is_file() {
        return Err("compiler executable is not the approved Apple Clang driver".into());
    }
    Ok(executable)
}

fn seatbelt_literal(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

#[repr(C)]
#[derive(Default)]
struct ProcTaskInfo {
    virtual_size: u64,
    resident_size: u64,
    total_user: u64,
    total_system: u64,
    threads_user: u64,
    threads_system: u64,
    policy: i32,
    faults: i32,
    pageins: i32,
    cow_faults: i32,
    messages_sent: i32,
    messages_received: i32,
    syscalls_mach: i32,
    syscalls_unix: i32,
    context_switches: i32,
    thread_count: i32,
    running_threads: i32,
    priority: i32,
}

#[link(name = "proc")]
extern "C" {
    fn proc_listpids(
        list_type: u32,
        type_info: u32,
        buffer: *mut libc::c_void,
        buffer_size: i32,
    ) -> i32;
    fn proc_pidinfo(pid: i32, flavor: i32, arg: u64, buffer: *mut libc::c_void, size: i32) -> i32;
}

fn real_user_process_count() -> Result<u64, String> {
    const PROC_RUID_ONLY: u32 = 5;
    // This is deliberately bounded and fail-closed. A healthy macOS desktop is far below this
    // inventory size; reaching it means it is unsafe to launch more untrusted processes.
    let mut pids = vec![0_i32; 8192];
    let buffer_size = std::mem::size_of_val(pids.as_slice()) as i32;
    let bytes = unsafe {
        proc_listpids(
            PROC_RUID_ONLY,
            libc::getuid(),
            pids.as_mut_ptr().cast(),
            buffer_size,
        )
    };
    if bytes < 0 {
        return Err(format!(
            "cannot inventory real-user processes: {}",
            std::io::Error::last_os_error()
        ));
    }
    if bytes as usize >= buffer_size as usize {
        return Err("real-user process inventory reached its 8192-PID safety ceiling".into());
    }
    let count = (bytes as usize / std::mem::size_of::<i32>()).min(pids.len());
    let live = pids[..count].iter().filter(|pid| **pid > 0).count() as u64;
    if live == 0 {
        return Err("real-user process inventory unexpectedly returned no processes".into());
    }
    Ok(live)
}

fn process_virtual_memory_bytes(pid: i32) -> u64 {
    const PROC_PIDTASKINFO: i32 = 4;
    let mut task = ProcTaskInfo::default();
    let task_size = std::mem::size_of::<ProcTaskInfo>() as i32;
    if unsafe {
        proc_pidinfo(
            pid,
            PROC_PIDTASKINFO,
            0,
            (&mut task as *mut ProcTaskInfo).cast(),
            task_size,
        )
    } == task_size
    {
        task.virtual_size
    } else {
        0
    }
}

#[cfg(test)]
mod launcher_spec_tests {
    use super::{
        add_metadata_ancestor_rules, cleanup_run_profiles, is_managed_fpc_compiler,
        launcher_nproc_ceiling, minimal_environment, write_private_profile, RunLimits, RunRole,
        RunSpec,
    };
    use crate::protocol::{ToolchainGrant, ToolchainGrantRole};
    use crate::workspace::initialize_root;
    use std::collections::BTreeMap;
    use std::fs;
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_DIRECTORY: AtomicU64 = AtomicU64::new(0);

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let suffix = NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "judgedesk-launcher-spec-test-{}-{suffix}",
                std::process::id()
            ));
            fs::create_dir(&path).expect("create launcher-spec test directory");
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn nproc_ceiling_reserves_supervisor_overflow_and_bounded_drift() {
        assert_eq!(
            launcher_nproc_ceiling(100, 1_000, 1).expect("minimum process budget"),
            107
        );
        assert_eq!(
            launcher_nproc_ceiling(100, 1_000, 32).expect("maximum process budget"),
            138
        );
        let error = launcher_nproc_ceiling(100, 137, 32)
            .expect_err("insufficient inherited hard limit must fail closed");
        assert!(error.contains("required=138"), "{error}");
        assert!(error.contains("hardMax=137"), "{error}");
    }

    #[test]
    fn target_environment_forces_private_home_and_tmp_but_preserves_certified_path() {
        let mut spec = sample_spec("environment");
        spec.environment = BTreeMap::from([
            ("HOME".into(), "/attacker/home".into()),
            ("TMPDIR".into(), "/attacker/tmp".into()),
            ("PATH".into(), "/managed/python/bin:/usr/bin:/bin".into()),
            ("PYTHONNOUSERSITE".into(), "1".into()),
        ]);
        let workspace = PathBuf::from("/private/workspace");
        let environment = minimal_environment(&spec, &workspace);
        assert_eq!(environment["HOME"], "/private/workspace");
        assert_eq!(environment["TMPDIR"], "/private/workspace");
        assert_eq!(environment["PATH"], "/managed/python/bin:/usr/bin:/bin");
        assert_eq!(environment["PYTHONNOUSERSITE"], "1");
    }

    #[test]
    fn metadata_traversal_grants_only_exact_known_ancestors() {
        let mut rules = std::collections::BTreeSet::new();
        add_metadata_ancestor_rules(
            &mut rules,
            std::path::Path::new("/Users/teacher/JudgeDesk/toolchains/dotnet/dotnet"),
        );
        assert!(rules.contains("(literal \"/Users\")"));
        assert!(rules.contains("(literal \"/Users/teacher\")"));
        assert!(rules.contains("(literal \"/Users/teacher/JudgeDesk/toolchains/dotnet\")"));
        assert!(!rules.contains("(subpath \"/Users\")"));
        assert!(!rules.contains("(literal \"/Users/student\")"));
    }

    #[test]
    fn fpc_link_script_tools_require_the_exact_managed_compiler_grant() {
        let mut spec = sample_spec("fpc-link-script");
        spec.role = RunRole::Compiler;
        spec.toolchain = Some(ToolchainGrant {
            package_id: "fpc-macos-arm64".into(),
            package_digest: "a".repeat(64),
            component_id: "fpc.compiler".into(),
            role: ToolchainGrantRole::Compiler,
        });
        assert!(is_managed_fpc_compiler(&spec));

        spec.toolchain.as_mut().unwrap().component_id = "other.compiler".into();
        assert!(!is_managed_fpc_compiler(&spec));
        spec.toolchain.as_mut().unwrap().component_id = "fpc.compiler".into();
        spec.toolchain.as_mut().unwrap().package_id = "untrusted-fpc".into();
        assert!(!is_managed_fpc_compiler(&spec));
    }

    #[test]
    fn profiles_are_private_unique_and_removed_only_for_the_exact_run() {
        let directory = TestDirectory::new();
        let root = initialize_root(directory.0.clone()).expect("initialize executor root");
        let first = write_private_profile(&root, "run_one", "(version 1)").expect("first profile");
        let second =
            write_private_profile(&root, "run_one", "(version 1)").expect("second profile");
        let other = write_private_profile(&root, "run_two", "(version 1)").expect("other profile");
        assert_ne!(first, second);
        for profile in [&first, &second, &other] {
            let metadata = fs::metadata(profile).expect("profile metadata");
            assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
            assert_eq!(metadata.nlink(), 1);
        }

        cleanup_run_profiles(&root, "run_one").expect("cleanup exact run");
        assert!(!first.exists());
        assert!(!second.exists());
        assert!(other.exists());
    }

    fn sample_spec(run_id: &str) -> RunSpec {
        RunSpec {
            run_id: run_id.into(),
            role: RunRole::Submission,
            workspace_id: "workspace".into(),
            executable_id: "workspaces/workspace/program".into(),
            args: Vec::new(),
            stdin_file: None,
            stdout_file: "stdout.txt".into(),
            stderr_file: "stderr.txt".into(),
            environment: BTreeMap::new(),
            toolchain: None,
            limits: RunLimits {
                wall_time_ms: 1_000,
                memory_bytes: 64 * 1024 * 1024,
                process_count: 1,
                thread_count: 16,
                output_bytes: 1024,
                total_write_bytes: 2048,
                open_files: 32,
                created_files: 16,
            },
        }
    }
}
