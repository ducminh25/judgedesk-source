use crate::checkers::{run_standard_checker, CheckerVerdict};
use crate::executor_client::ExecutorClient;
use judgedesk_native_executor::protocol::{RunLimits, RunReason, RunRole, RunSpec};
use judgedesk_native_executor::request_validation::validate_run;
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

static RUN_COUNTER: AtomicU64 = AtomicU64::new(1);

fn preview_text(output: &str, limit: usize) -> String {
    if output.len() > limit {
        format!("{}...", &output[..limit])
    } else {
        output.to_string()
    }
}

#[derive(Debug, Clone)]
pub struct TestRunOutput {
    pub status: String,
    pub execution_time_ms: u64,
    pub memory_used_kb: u64,
    pub score_multiplier: f64,
    pub message: Option<String>,
    pub expected_output_preview: Option<String>,
    pub actual_output_preview: Option<String>,
    pub error_detail: Option<String>,
}

pub struct TestCaseExecutionConfig<'a> {
    pub executable_path: &'a Path,
    pub input_path: &'a Path,
    pub expected_output_path: &'a Path,
    pub input_file_name: &'a str,
    pub output_file_name: &'a str,
    pub time_limit_ms: u64,
    pub memory_limit_mb: u64,
    pub checker_type: &'a str,
    pub custom_checker_path: Option<&'a Path>,
    pub workspace_dir: &'a Path,
    pub platform: &'a ExecutorClient,
}

pub fn run_test_case(config: TestCaseExecutionConfig) -> TestRunOutput {
    let count = RUN_COUNTER.fetch_add(1, Ordering::Relaxed);
    let workspace_id = format!("run_{}_{}", std::process::id(), count);
    let run_id = format!("exec_{}_{}", std::process::id(), count);

    let workspaces_root = config.platform.root().join("workspaces");
    let workspace_dir = workspaces_root.join(&workspace_id);
    if let Err(e) = fs::create_dir_all(&workspace_dir) {
        return TestRunOutput {
            status: "JE".to_string(),
            execution_time_ms: 0,
            memory_used_kb: 0,
            score_multiplier: 0.0,
            message: Some(format!("Failed to create workspace: {e}")),
            expected_output_preview: None,
            actual_output_preview: None,
            error_detail: None,
        };
    }

    let exe_name = if cfg!(windows) { "prog.exe" } else { "prog" };
    let staged_exe = workspace_dir.join(exe_name);
    if let Err(e) = fs::copy(config.executable_path, &staged_exe) {
        let _ = fs::remove_dir_all(&workspace_dir);
        return TestRunOutput {
            status: "JE".to_string(),
            execution_time_ms: 0,
            memory_used_kb: 0,
            score_multiplier: 0.0,
            message: Some(format!("Failed to stage executable: {e}")),
            expected_output_preview: None,
            actual_output_preview: None,
            error_detail: None,
        };
    }

    let stdin_path = workspace_dir.join("stdin.txt");
    let stdout_path = workspace_dir.join("stdout.txt");
    let stderr_path = workspace_dir.join("stderr.txt");

    // Copy input to stdin.txt
    if let Err(e) = fs::copy(config.input_path, &stdin_path) {
        let _ = fs::remove_dir_all(&workspace_dir);
        return TestRunOutput {
            status: "JE".to_string(),
            execution_time_ms: 0,
            memory_used_kb: 0,
            score_multiplier: 0.0,
            message: Some(format!("Failed to copy input file to workspace: {e}")),
            expected_output_preview: None,
            actual_output_preview: None,
            error_detail: None,
        };
    }

    // Also copy to problem-specific input filename if non-empty (for freopen)
    if !config.input_file_name.is_empty() {
        let problem_inp = workspace_dir.join(config.input_file_name);
        let _ = fs::copy(config.input_path, &problem_inp);
    }

    let spec = RunSpec {
        run_id: run_id.clone(),
        role: RunRole::Submission,
        workspace_id: workspace_id.clone(),
        executable_id: format!("workspaces/{}/{}", workspace_id, exe_name),
        args: Vec::new(),
        stdin_file: Some("stdin.txt".to_string()),
        stdout_file: "stdout.txt".to_string(),
        stderr_file: "stderr.txt".to_string(),
        environment: BTreeMap::new(),
        toolchain: None,
        local_toolchain: None,
        limits: RunLimits {
            wall_time_ms: config.time_limit_ms,
            memory_bytes: config.memory_limit_mb * 1024 * 1024,
            process_count: 1,
            thread_count: 64,
            output_bytes: 10 * 1024 * 1024,
            total_write_bytes: 100 * 1024 * 1024,
            open_files: 64,
            created_files: 256,
        },
    };

    let validated = match validate_run(config.platform.root().as_path(), &spec) {
        Ok(v) => v,
        Err(err) => {
            let _ = fs::remove_dir_all(&workspace_dir);
            return TestRunOutput {
                status: "JE".to_string(),
                execution_time_ms: 0,
                memory_used_kb: 0,
                score_multiplier: 0.0,
                message: Some(format!("Validation error: {err}")),
                expected_output_preview: None,
                actual_output_preview: None,
                error_detail: None,
            };
        }
    };

    let run_result = config.platform.run_sync(Box::new(spec)).expect("run");

    let execution_time_ms = if matches!(run_result.reason, RunReason::WallTimeLimit) {
        config.time_limit_ms
    } else {
        (run_result.wall_time_us / 1000).max(1)
    };

    let memory_used_kb = run_result.peak_memory_bytes.unwrap_or(0) / 1024;

    // Check verdict mapping
    let preliminary_verdict = match run_result.reason {
        RunReason::Cancelled => Some("FAIL"),
        RunReason::MemoryLimit => Some("MLE"),
        RunReason::WallTimeLimit => Some("TLE"),
        RunReason::OutputLimit | RunReason::WriteLimit => Some("OLE"),
        RunReason::ProcessLimit | RunReason::ThreadLimit => Some("RE"),
        RunReason::SandboxDenied | RunReason::LaunchError | RunReason::InternalError => Some("JE"),
        RunReason::Exited => {
            if run_result.exit_code == Some(0) {
                None
            } else {
                Some("RE")
            }
        }
    };

    let expected_bytes = fs::read(config.expected_output_path).unwrap_or_default();
    let expected_preview = preview_text(&String::from_utf8_lossy(&expected_bytes), 500);

    if let Some(verdict) = preliminary_verdict {
        let stderr_msg = if stderr_path.is_file() {
            fs::read_to_string(&stderr_path)
                .ok()
                .filter(|s| !s.trim().is_empty())
        } else {
            None
        };
        let _ = fs::remove_dir_all(&workspace_dir);
        return TestRunOutput {
            status: verdict.to_string(),
            execution_time_ms,
            memory_used_kb,
            score_multiplier: 0.0,
            message: run_result
                .diagnostic
                .or(stderr_msg)
                .or(run_result.signal_or_status.clone()),
            expected_output_preview: Some(expected_preview),
            actual_output_preview: None,
            error_detail: run_result.signal_or_status,
        };
    }

    // Process exited with 0: check output
    let problem_out = if !config.output_file_name.is_empty() {
        workspace_dir.join(config.output_file_name)
    } else {
        PathBuf::new()
    };

    let actual_bytes =
        if problem_out.is_file() && fs::metadata(&problem_out).map(|m| m.len()).unwrap_or(0) > 0 {
            fs::read(&problem_out).unwrap_or_default()
        } else if stdout_path.is_file() {
            fs::read(&stdout_path).unwrap_or_default()
        } else {
            Vec::new()
        };

    let actual_preview = preview_text(&String::from_utf8_lossy(&actual_bytes), 500);

    let (final_status, score_mult, final_msg) = if let Some(checker_exe) =
        config.custom_checker_path
    {
        // Run custom checker!
        let actual_file = workspace_dir.join("actual.txt");
        let expected_file = workspace_dir.join("expected.txt");
        let _ = fs::write(&actual_file, &actual_bytes);
        let _ = fs::write(&expected_file, &expected_bytes);

        // Also setup Themis folder hierarchy: test/ and work/
        let test_dir = workspace_dir.join("test");
        let work_dir = workspace_dir.join("work");
        let _ = fs::create_dir_all(&test_dir);
        let _ = fs::create_dir_all(&work_dir);

        let default_inp = "problem.INP";
        let default_out = "problem.OUT";
        let custom_inp = if !config.input_file_name.is_empty() {
            config.input_file_name
        } else {
            default_inp
        };
        let custom_out = if !config.output_file_name.is_empty() {
            config.output_file_name
        } else {
            default_out
        };

        let _ = fs::copy(config.input_path, test_dir.join(default_inp));
        let _ = fs::copy(config.input_path, test_dir.join(custom_inp));
        let _ = fs::copy(config.expected_output_path, test_dir.join(default_out));
        let _ = fs::copy(config.expected_output_path, test_dir.join(custom_out));
        let _ = fs::write(work_dir.join(default_out), &actual_bytes);
        let _ = fs::write(work_dir.join(custom_out), &actual_bytes);

        let themis_stdin_content = format!("{}\n{}\n", test_dir.display(), work_dir.display());
        let themis_stdin_file = workspace_dir.join("themis.stdin");
        let _ = fs::write(&themis_stdin_file, themis_stdin_content.as_bytes());

        let mut cmd = if checker_exe
            .to_string_lossy()
            .to_lowercase()
            .ends_with(".py")
        {
            let mut c = std::process::Command::new("python");
            c.arg("-u").arg(checker_exe);
            c
        } else {
            std::process::Command::new(checker_exe)
        };

        cmd.arg(&stdin_path).arg(&actual_file).arg(&expected_file);

        cmd.current_dir(&workspace_dir);
        if let Ok(stdin_handle) = fs::File::open(&themis_stdin_file) {
            cmd.stdin(stdin_handle);
        }

        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());

        let spawn_res = cmd.spawn();
        match spawn_res {
            Ok(child) => {
                let (tx, rx) = std::sync::mpsc::channel();
                std::thread::spawn(move || {
                    let out = child.wait_with_output();
                    let _ = tx.send(out);
                });
                match rx.recv_timeout(std::time::Duration::from_secs(5)) {
                    Ok(Ok(output)) => {
                        let code = output.status.code().unwrap_or(-1);
                        let stdout_str = String::from_utf8_lossy(&output.stdout).to_string();
                        let stderr_str = String::from_utf8_lossy(&output.stderr).to_string();
                        let combined_msg = format!("{stderr_str} {stdout_str}").trim().to_string();

                        let custom_res = crate::checkers::custom::parse_custom_checker_exit(
                            code,
                            &combined_msg,
                            &stdout_str,
                            1.0,
                        );

                        let st = match custom_res.status {
                            CheckerVerdict::AC => {
                                if custom_res.score_multiplier < 1.0
                                    && custom_res.score_multiplier > 0.0
                                {
                                    "PARTIAL"
                                } else {
                                    "AC"
                                }
                            }
                            CheckerVerdict::WA => "WA",
                            CheckerVerdict::PE => "PE",
                            CheckerVerdict::FAIL => "FAIL",
                        };

                        (
                            st.to_string(),
                            custom_res.score_multiplier,
                            Some(custom_res.message),
                        )
                    }
                    Ok(Err(e)) => (
                        "FAIL".to_string(),
                        0.0,
                        Some(format!("Failed to execute custom checker: {e}")),
                    ),
                    Err(_) => (
                        "FAIL".to_string(),
                        0.0,
                        Some("Custom checker timed out after 5s".to_string()),
                    ),
                }
            }
            Err(e) => (
                "FAIL".to_string(),
                0.0,
                Some(format!("Failed to spawn custom checker: {e}")),
            ),
        }
    } else {
        let check = run_standard_checker(config.checker_type, &expected_bytes, &actual_bytes);
        let (st, mult) = match check.status {
            CheckerVerdict::AC => ("AC", 1.0),
            CheckerVerdict::WA => ("WA", 0.0),
            CheckerVerdict::PE => ("PE", 0.0),
            CheckerVerdict::FAIL => ("FAIL", 0.0),
        };
        (st.to_string(), mult, Some(check.message))
    };

    let _ = fs::remove_dir_all(&workspace_dir);

    TestRunOutput {
        status: final_status,
        execution_time_ms,
        memory_used_kb,
        score_multiplier: score_mult,
        message: final_msg,
        expected_output_preview: Some(expected_preview),
        actual_output_preview: Some(actual_preview),
        error_detail: None,
    }
}
