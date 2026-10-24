use crate::checkers::{run_standard_checker, CheckerVerdict};
use crate::executor_client::ExecutorClient;
use crate::rational::{parse_rational_f64, Rational};
use crate::scoring::TestExecutionDiagnostics;
use crate::toolchains::discovery::{
    clean_canonical_path, compute_binary_sha256_hex, ensure_cached_managed_toolchain,
    managed_cache_id, read_package_receipt, resolve_macos_framework_python_executable,
    resolve_toolchain_for_profile, ResolvedToolchain,
};
use judgedesk_native_executor::protocol::{
    LocalToolchainGrant, LocalToolchainIsolation, RunLimits, RunReason, RunResult, RunRole,
    RunSpec, ToolchainGrant, ToolchainGrantRole,
};
use judgedesk_native_executor::request_validation::validate_run;
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::UNIX_EPOCH;

static RUN_COUNTER: AtomicU64 = AtomicU64::new(1);
const MAX_STDERR_DIAGNOSTIC_BYTES: usize = 4096;

type ArtifactCacheKey = (PathBuf, PathBuf);
type ArtifactCacheEntry = (u64, u128, String);

fn artifact_cache() -> &'static Mutex<HashMap<ArtifactCacheKey, ArtifactCacheEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<ArtifactCacheKey, ArtifactCacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn import_executor_artifact(
    executor_root: &Path,
    executable_path: &Path,
) -> Result<String, String> {
    let meta = fs::metadata(executable_path).map_err(|e| {
        format!(
            "Failed to inspect executable {}: {e}",
            executable_path.display()
        )
    })?;
    let file_len = meta.len();
    let mtime_ns = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);

    let cache_key = (executor_root.to_path_buf(), executable_path.to_path_buf());
    if let Ok(guard) = artifact_cache().lock() {
        if let Some((cached_len, cached_mtime, ref rel_id)) = guard.get(&cache_key) {
            if *cached_len == file_len
                && *cached_mtime == mtime_ns
                && executor_root.join(rel_id).is_file()
            {
                return Ok(rel_id.clone());
            }
        }
    }

    let sha256 = compute_binary_sha256_hex(executable_path)?;
    let ext = executable_path
        .extension()
        .and_then(|e| e.to_str())
        .filter(|e| !e.is_empty())
        .map(|e| format!(".{}", e.to_ascii_lowercase()))
        .unwrap_or_else(|| {
            if cfg!(windows) {
                ".exe".to_string()
            } else {
                String::new()
            }
        });

    let artifact_dir = executor_root.join("artifacts");
    fs::create_dir_all(&artifact_dir)
        .map_err(|e| format!("Failed to create executor artifact cache dir: {e}"))?;

    let file_name = format!("{sha256}{ext}");
    let target_path = artifact_dir.join(&file_name);
    if !target_path.is_file() {
        let nonce = RUN_COUNTER.fetch_add(1, Ordering::Relaxed);
        let temp_path =
            artifact_dir.join(format!("{sha256}.{}.{nonce}.tmp{ext}", std::process::id()));
        fs::copy(executable_path, &temp_path)
            .map_err(|e| format!("Failed to stage executable into artifact cache: {e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Ok(m) = fs::metadata(&temp_path) {
                let mut perms = m.permissions();
                perms.set_mode(0o755);
                let _ = fs::set_permissions(&temp_path, perms);
            }
        }
        if let Err(e) = fs::rename(&temp_path, &target_path) {
            let _ = fs::remove_file(&temp_path);
            if !target_path.is_file() {
                return Err(format!("Failed to finalize staged artifact: {e}"));
            }
        }
    }

    let rel_id = format!("artifacts/{file_name}");
    if let Ok(mut guard) = artifact_cache().lock() {
        if guard.len() >= 256 {
            guard.clear();
        }
        guard.insert(cache_key, (file_len, mtime_ns, rel_id.clone()));
    }
    Ok(rel_id)
}

fn read_bounded_utf8(path: &Path, max_bytes: usize) -> String {
    let Ok(file) = fs::File::open(path) else {
        return String::new();
    };
    let mut buf = Vec::with_capacity(max_bytes.min(8192));
    if file.take(max_bytes as u64).read_to_end(&mut buf).is_err() {
        return String::new();
    }
    String::from_utf8_lossy(&buf).into_owned()
}

fn run_reason_str(reason: &RunReason) -> &'static str {
    match reason {
        RunReason::Exited => "exited",
        RunReason::WallTimeLimit => "wall_time_limit",
        RunReason::MemoryLimit => "memory_limit",
        RunReason::ProcessLimit => "process_limit",
        RunReason::ThreadLimit => "thread_limit",
        RunReason::OutputLimit => "output_limit",
        RunReason::WriteLimit => "write_limit",
        RunReason::Cancelled => "cancelled",
        RunReason::SandboxDenied => "sandbox_denied",
        RunReason::LaunchError => "launch_error",
        RunReason::InternalError => "internal_error",
    }
}

fn to_execution_diagnostics(
    run_result: &RunResult,
    memory_limit_mb: u64,
) -> TestExecutionDiagnostics {
    let clamped_mb = if memory_limit_mb == 0 {
        256
    } else {
        memory_limit_mb.clamp(8, 1024)
    };
    let limit_bytes = clamped_mb * 1024 * 1024;
    TestExecutionDiagnostics {
        reason: run_reason_str(&run_result.reason).to_string(),
        exit_code: run_result.exit_code,
        signal_or_status: run_result.signal_or_status.clone(),
        security_setup_time_us: run_result.security_setup_time_us,
        wall_time_us: run_result.wall_time_us,
        result_collection_time_us: run_result.result_collection_time_us,
        user_cpu_time_us: run_result.user_cpu_time_us,
        kernel_cpu_time_us: run_result.kernel_cpu_time_us,
        peak_memory_bytes: run_result.peak_memory_bytes,
        configured_memory_limit_bytes: Some(limit_bytes),
        effective_memory_limit_bytes: Some(limit_bytes),
        stdout_bytes: run_result.stdout_bytes,
        stderr_bytes: run_result.stderr_bytes,
        created_files: run_result.created_files,
        diagnostic: run_result.diagnostic.clone(),
    }
}

fn executor_diagnostic(run_result: &RunResult, stderr_path: &Path) -> Option<String> {
    if matches!(
        run_result.reason,
        RunReason::WallTimeLimit
            | RunReason::MemoryLimit
            | RunReason::OutputLimit
            | RunReason::WriteLimit
    ) {
        return None;
    }
    let mut parts = Vec::with_capacity(4);
    if let Some(ref diag) = run_result.diagnostic {
        let trimmed = diag.trim();
        if !trimmed.is_empty() {
            parts.push(trimmed.to_string());
        }
    }
    if let Some(ref sig) = run_result.signal_or_status {
        let trimmed = sig.trim();
        if !trimmed.is_empty() {
            parts.push(trimmed.to_string());
        }
    }
    if let Some(code) = run_result.exit_code {
        if code != 0 {
            parts.push(format!("Exit code {code}"));
        }
    }
    let stderr = read_bounded_utf8(stderr_path, MAX_STDERR_DIAGNOSTIC_BYTES);
    let trimmed = stderr.trim();
    if !trimmed.is_empty() {
        parts.push(trimmed.to_string());
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(". "))
    }
}

fn preview_text(output: &str, limit: usize) -> String {
    if output.len() > limit {
        let mut end = limit;
        while end > 0 && !output.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}...", &output[..end])
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
    pub score_multiplier_exact: Rational,
    pub message: Option<String>,
    pub expected_output_preview: Option<String>,
    pub actual_output_preview: Option<String>,
    pub error_detail: Option<String>,
    pub execution: Option<TestExecutionDiagnostics>,
}

impl TestRunOutput {
    fn judge_error(message: impl Into<String>) -> Self {
        let msg = message.into();
        Self {
            status: "JE".to_string(),
            execution_time_ms: 0,
            memory_used_kb: 0,
            score_multiplier: 0.0,
            score_multiplier_exact: Rational::ZERO,
            message: Some(msg.clone()),
            expected_output_preview: None,
            actual_output_preview: None,
            error_detail: Some(msg),
            execution: None,
        }
    }
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

#[allow(clippy::type_complexity)]
fn prepare_python_runtime_launch(
    platform_root: &Path,
    toolchain: &ResolvedToolchain,
    role: ToolchainGrantRole,
) -> Result<
    (
        String,
        Option<ToolchainGrant>,
        Option<LocalToolchainGrant>,
        BTreeMap<String, String>,
    ),
    String,
> {
    let receipt = toolchain
        .package_root
        .as_ref()
        .and_then(|p| read_package_receipt(p));

    if let (Some(pkg_root), Some(rec)) = (&toolchain.package_root, receipt) {
        let cached_root = ensure_cached_managed_toolchain(platform_root, pkg_root, &rec)?;
        let cache_id = managed_cache_id(&rec.package_id, &rec.version, &rec.archive_sha256);
        let role_str = match role {
            ToolchainGrantRole::Compiler => "compiler",
            ToolchainGrantRole::SubmissionRuntime => "submission-runtime",
            ToolchainGrantRole::CheckerRuntime => "checker-runtime",
        };
        let comp = rec
            .components
            .iter()
            .find(|c| c.roles.iter().any(|r| r == role_str))
            .or_else(|| {
                rec.components
                    .iter()
                    .find(|c| c.id == rec.entrypoint_component_id)
            });
        let relative_exe = comp
            .map(|c| c.relative_path.as_str())
            .unwrap_or(if cfg!(windows) {
                "python.exe"
            } else {
                "bin/python3"
            });
        let component_id = comp
            .map(|c| c.id.clone())
            .unwrap_or_else(|| rec.entrypoint_component_id.clone());
        let exe_dir = cached_root
            .join(relative_exe)
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| cached_root.clone());

        let mut env = BTreeMap::new();
        env.insert("JUDGEDESK_PYTHON_ISOLATED".to_string(), "1".to_string());
        env.insert("PYTHONNOUSERSITE".to_string(), "1".to_string());
        env.insert("PYTHONDONTWRITEBYTECODE".to_string(), "1".to_string());
        env.insert("PYTHONHASHSEED".to_string(), "0".to_string());
        env.insert("PYTHONIOENCODING".to_string(), "utf-8".to_string());
        env.insert(
            "PYTHONHOME".to_string(),
            cached_root.to_string_lossy().into_owned(),
        );
        env.insert("PATH".to_string(), exe_dir.to_string_lossy().into_owned());

        return Ok((
            format!("toolchains/{cache_id}/{relative_exe}"),
            Some(ToolchainGrant {
                package_id: rec.package_id,
                package_digest: rec.archive_sha256,
                component_id,
                role,
            }),
            None,
            env,
        ));
    }

    let (exe_canon, mut python_root) = resolve_macos_framework_python_executable(
        &toolchain.executable_path,
    )
    .unwrap_or_else(|| {
        let canon = clean_canonical_path(&toolchain.executable_path);
        let root = toolchain
            .package_root
            .as_ref()
            .map(|p| clean_canonical_path(p))
            .or_else(|| canon.parent().map(Path::to_path_buf))
            .unwrap_or_else(|| PathBuf::from("."));
        (canon, root)
    });
    if let Some(ref pkg_root) = toolchain.package_root {
        let pkg_canon = clean_canonical_path(pkg_root);
        if exe_canon.starts_with(&pkg_canon) {
            python_root = pkg_canon;
        }
    }
    let mut rel_exe = exe_canon
        .strip_prefix(&python_root)
        .ok()
        .filter(|rel| !rel.as_os_str().is_empty())
        .map(|rel| rel.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();
    if rel_exe.is_empty() {
        if let Some(parent) = exe_canon.parent() {
            python_root = parent.to_path_buf();
        }
        rel_exe = exe_canon
            .file_name()
            .and_then(|f| f.to_str())
            .unwrap_or(if cfg!(windows) {
                "python.exe"
            } else {
                "python3"
            })
            .to_string();
    }
    let exe_dir = exe_canon
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| python_root.clone());

    let mut env = BTreeMap::new();
    env.insert("JUDGEDESK_PYTHON_ISOLATED".to_string(), "1".to_string());
    env.insert("PYTHONNOUSERSITE".to_string(), "1".to_string());
    env.insert("PYTHONDONTWRITEBYTECODE".to_string(), "1".to_string());
    env.insert("PYTHONHASHSEED".to_string(), "0".to_string());
    env.insert("PYTHONIOENCODING".to_string(), "utf-8".to_string());
    env.insert(
        "PYTHONHOME".to_string(),
        python_root.to_string_lossy().into_owned(),
    );
    env.insert("PATH".to_string(), exe_dir.to_string_lossy().into_owned());

    let isolation = if cfg!(target_os = "linux") {
        LocalToolchainIsolation::Strict
    } else {
        LocalToolchainIsolation::ResourceOnly
    };

    Ok((
        format!("local-toolchain/{rel_exe}"),
        None,
        Some(LocalToolchainGrant {
            root_path: python_root.to_string_lossy().into_owned(),
            executable_relative_path: rel_exe,
            isolation,
            role,
        }),
        env,
    ))
}

fn build_submission_spec(
    config: &TestCaseExecutionConfig<'_>,
    workspace: &crate::storage::OwnedWorkspace,
    workspace_id: &str,
    run_id: &str,
) -> Result<RunSpec, String> {
    let ext_lower = config
        .executable_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();

    if config.executable_path.is_dir() {
        // Java compiled class bundle directory
        let entrypoint = fs::read_to_string(config.executable_path.join(".judgedesk-entrypoint"))
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "Main".to_string());

        let entries = fs::read_dir(config.executable_path)
            .map_err(|e| format!("Failed to read Java class directory: {e}"))?;
        let mut copied_any = false;
        for entry in entries.flatten() {
            let p = entry.path();
            if !p.is_file() {
                continue;
            }
            let Some(file_name) = p.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if !file_name.ends_with(".class") {
                continue;
            }
            let staged_class = workspace.resolve_contained_path(Path::new(file_name))?;
            fs::copy(&p, &staged_class)
                .map_err(|e| format!("Failed to stage Java class {file_name}: {e}"))?;
            copied_any = true;
        }
        if !copied_any {
            return Err(
                "JAVA_CLASSES_MISSING: no .class files found in artifact directory".to_string(),
            );
        }

        let toolchain = resolve_toolchain_for_profile("java", None, None);
        if !toolchain.ready {
            return Err(toolchain
                .diagnostic
                .unwrap_or_else(|| "JAVA_TOOLCHAIN_UNAVAILABLE".to_string()));
        }

        let receipt = toolchain
            .package_root
            .as_ref()
            .and_then(|p| read_package_receipt(p));

        let max_ram_bytes = (config.memory_limit_mb.max(64) * 1024 * 1024).max(256 * 1024 * 1024);
        let job_mem_bytes = (config.memory_limit_mb * 1024 * 1024).max(512 * 1024 * 1024);
        let args = vec![
            "-XX:+UseSerialGC".to_string(),
            "-XX:ActiveProcessorCount=1".to_string(),
            "-XX:TieredStopAtLevel=1".to_string(),
            "-Xshare:auto".to_string(),
            "-XX:-UsePerfData".to_string(),
            "-XX:+ExitOnOutOfMemoryError".to_string(),
            format!("-XX:MaxRAM={max_ram_bytes}"),
            "-XX:MaxRAMPercentage=65.0".to_string(),
            "-Dfile.encoding=UTF-8".to_string(),
            "-Duser.language=en".to_string(),
            "-Duser.country=US".to_string(),
            "-Djava.io.tmpdir=.".to_string(),
            "-Duser.home=.".to_string(),
            "-cp".to_string(),
            ".".to_string(),
            entrypoint,
        ];
        let limits = RunLimits {
            wall_time_ms: config.time_limit_ms,
            memory_bytes: job_mem_bytes,
            process_count: 1,
            thread_count: 64,
            output_bytes: 10 * 1024 * 1024,
            total_write_bytes: 100 * 1024 * 1024,
            open_files: 64,
            created_files: 256,
        };

        if let (Some(pkg_root), Some(rec)) = (&toolchain.package_root, receipt) {
            let cached_root =
                ensure_cached_managed_toolchain(&config.platform.root(), pkg_root, &rec)?;
            let cache_id = managed_cache_id(&rec.package_id, &rec.version, &rec.archive_sha256);
            let runtime_comp = rec.components.iter().find(|c| {
                c.id == "java.runtime" || c.roles.iter().any(|r| r == "submission-runtime")
            });
            let relative_exe =
                runtime_comp
                    .map(|c| c.relative_path.as_str())
                    .unwrap_or(if cfg!(windows) {
                        "bin/java.exe"
                    } else {
                        "bin/java"
                    });
            let component_id = runtime_comp
                .map(|c| c.id.clone())
                .unwrap_or_else(|| "java.runtime".to_string());

            let mut env = BTreeMap::new();
            env.insert("JUDGEDESK_JAVA_ISOLATED".to_string(), "1".to_string());
            env.insert(
                "JAVA_HOME".to_string(),
                cached_root.to_string_lossy().into_owned(),
            );
            env.insert(
                "PATH".to_string(),
                cached_root.join("bin").to_string_lossy().into_owned(),
            );

            return Ok(RunSpec {
                run_id: run_id.to_string(),
                role: RunRole::Submission,
                workspace_id: workspace_id.to_string(),
                executable_id: format!("toolchains/{cache_id}/{relative_exe}"),
                args,
                stdin_file: Some("stdin.txt".to_string()),
                stdout_file: "stdout.txt".to_string(),
                stderr_file: "stderr.txt".to_string(),
                environment: env,
                toolchain: Some(ToolchainGrant {
                    package_id: rec.package_id,
                    package_digest: rec.archive_sha256,
                    component_id,
                    role: ToolchainGrantRole::SubmissionRuntime,
                }),
                local_toolchain: None,
                limits,
            });
        }

        let java_exe = toolchain
            .runtime_executable_path
            .as_ref()
            .unwrap_or(&toolchain.executable_path);
        let java_root = toolchain
            .package_root
            .as_ref()
            .map(|p| clean_canonical_path(p))
            .or_else(|| {
                java_exe
                    .parent()
                    .and_then(|p| p.parent())
                    .map(clean_canonical_path)
            })
            .unwrap_or_else(|| PathBuf::from("."));

        let relative_exe = if cfg!(windows) {
            "bin/java.exe"
        } else {
            "bin/java"
        };

        let mut env = BTreeMap::new();
        env.insert("JUDGEDESK_JAVA_ISOLATED".to_string(), "1".to_string());
        env.insert(
            "JAVA_HOME".to_string(),
            java_root.to_string_lossy().into_owned(),
        );
        env.insert(
            "PATH".to_string(),
            java_root.join("bin").to_string_lossy().into_owned(),
        );

        let isolation = if cfg!(target_os = "linux") {
            LocalToolchainIsolation::Strict
        } else {
            LocalToolchainIsolation::ResourceOnly
        };

        return Ok(RunSpec {
            run_id: run_id.to_string(),
            role: RunRole::Submission,
            workspace_id: workspace_id.to_string(),
            executable_id: format!("local-toolchain/{relative_exe}"),
            args,
            stdin_file: Some("stdin.txt".to_string()),
            stdout_file: "stdout.txt".to_string(),
            stderr_file: "stderr.txt".to_string(),
            environment: env,
            toolchain: None,
            local_toolchain: Some(LocalToolchainGrant {
                root_path: java_root.to_string_lossy().into_owned(),
                executable_relative_path: relative_exe.to_string(),
                isolation,
                role: ToolchainGrantRole::SubmissionRuntime,
            }),
            limits,
        });
    }

    if ext_lower == "py" {
        let staged_script = workspace.resolve_contained_path(Path::new("main.py"))?;
        fs::copy(config.executable_path, &staged_script)
            .map_err(|e| format!("Failed to stage Python script: {e}"))?;

        let toolchain = resolve_toolchain_for_profile("python", None, None);
        if !toolchain.ready || !toolchain.executable_path.is_file() {
            return Err(toolchain
                .diagnostic
                .unwrap_or_else(|| "PYTHON_TOOLCHAIN_UNAVAILABLE".to_string()));
        }

        let limits = RunLimits {
            wall_time_ms: config.time_limit_ms,
            memory_bytes: config.memory_limit_mb * 1024 * 1024,
            process_count: 1,
            thread_count: 32,
            output_bytes: 10 * 1024 * 1024,
            total_write_bytes: 100 * 1024 * 1024,
            open_files: 64,
            created_files: 256,
        };

        let (executable_id, tc_grant, local_grant, env) = prepare_python_runtime_launch(
            config.platform.root().as_path(),
            &toolchain,
            ToolchainGrantRole::SubmissionRuntime,
        )?;

        return Ok(RunSpec {
            run_id: run_id.to_string(),
            role: RunRole::Submission,
            workspace_id: workspace_id.to_string(),
            executable_id,
            args: vec!["-I".to_string(), "-B".to_string(), "main.py".to_string()],
            stdin_file: Some("stdin.txt".to_string()),
            stdout_file: "stdout.txt".to_string(),
            stderr_file: "stderr.txt".to_string(),
            environment: env,
            toolchain: tc_grant,
            local_toolchain: local_grant,
            limits,
        });
    }

    if matches!(ext_lower.as_str(), "sb3" | "sb2" | "json") {
        let project_name = format!("project.{ext_lower}");
        let staged_proj = workspace.resolve_contained_path(Path::new(&project_name))?;
        fs::copy(config.executable_path, &staged_proj)
            .map_err(|e| format!("Failed to stage Scratch project: {e}"))?;

        let toolchain = resolve_toolchain_for_profile("scratch", None, None);
        if !toolchain.ready || !toolchain.executable_path.is_file() {
            return Err(toolchain
                .diagnostic
                .unwrap_or_else(|| "SCRATCH_TOOLCHAIN_UNAVAILABLE".to_string()));
        }

        let receipt = toolchain
            .package_root
            .as_ref()
            .and_then(|p| read_package_receipt(p));

        let limits = RunLimits {
            wall_time_ms: config.time_limit_ms,
            memory_bytes: (config.memory_limit_mb * 1024 * 1024).max(512 * 1024 * 1024),
            process_count: 1,
            thread_count: 64,
            output_bytes: 10 * 1024 * 1024,
            total_write_bytes: 100 * 1024 * 1024,
            open_files: 64,
            created_files: 256,
        };

        if let (Some(pkg_root), Some(rec)) = (&toolchain.package_root, receipt) {
            let cached_root =
                ensure_cached_managed_toolchain(&config.platform.root(), pkg_root, &rec)?;
            let cache_id = managed_cache_id(&rec.package_id, &rec.version, &rec.archive_sha256);
            let relative_exe = rec
                .components
                .iter()
                .find(|c| c.id == rec.entrypoint_component_id)
                .map(|c| c.relative_path.as_str())
                .unwrap_or(if cfg!(windows) {
                    "scratch-run.exe"
                } else {
                    "scratch-run"
                });

            let mut env = BTreeMap::new();
            env.insert("JUDGEDESK_SCRATCH_ISOLATED".to_string(), "1".to_string());
            env.insert("TURBO_MODE".to_string(), "1".to_string());
            env.insert(
                "PATH".to_string(),
                cached_root.to_string_lossy().into_owned(),
            );

            return Ok(RunSpec {
                run_id: run_id.to_string(),
                role: RunRole::Submission,
                workspace_id: workspace_id.to_string(),
                executable_id: format!("toolchains/{cache_id}/{relative_exe}"),
                args: vec![project_name],
                stdin_file: Some("stdin.txt".to_string()),
                stdout_file: "stdout.txt".to_string(),
                stderr_file: "stderr.txt".to_string(),
                environment: env,
                toolchain: Some(ToolchainGrant {
                    package_id: rec.package_id,
                    package_digest: rec.archive_sha256,
                    component_id: rec.entrypoint_component_id,
                    role: ToolchainGrantRole::SubmissionRuntime,
                }),
                local_toolchain: None,
                limits,
            });
        }

        let exe_canon = clean_canonical_path(&toolchain.executable_path);
        let scratch_root = toolchain
            .package_root
            .as_ref()
            .map(|p| clean_canonical_path(p))
            .or_else(|| exe_canon.parent().map(Path::to_path_buf))
            .unwrap_or_else(|| PathBuf::from("."));
        let rel_exe = exe_canon
            .file_name()
            .and_then(|f| f.to_str())
            .unwrap_or(if cfg!(windows) {
                "scratch-run.exe"
            } else {
                "scratch-run"
            })
            .to_string();

        let mut env = BTreeMap::new();
        env.insert("JUDGEDESK_SCRATCH_ISOLATED".to_string(), "1".to_string());
        env.insert("TURBO_MODE".to_string(), "1".to_string());
        env.insert(
            "PATH".to_string(),
            scratch_root.to_string_lossy().into_owned(),
        );

        return Ok(RunSpec {
            run_id: run_id.to_string(),
            role: RunRole::Submission,
            workspace_id: workspace_id.to_string(),
            executable_id: format!("local-toolchain/{rel_exe}"),
            args: vec![project_name],
            stdin_file: Some("stdin.txt".to_string()),
            stdout_file: "stdout.txt".to_string(),
            stderr_file: "stderr.txt".to_string(),
            environment: env,
            toolchain: None,
            local_toolchain: Some(LocalToolchainGrant {
                root_path: scratch_root.to_string_lossy().into_owned(),
                executable_relative_path: rel_exe,
                isolation: LocalToolchainIsolation::ResourceOnly,
                role: ToolchainGrantRole::SubmissionRuntime,
            }),
            limits,
        });
    }

    // Default: Native binary (C++, C, Pascal) — stage once into executor artifact cache
    let executable_id =
        import_executor_artifact(config.platform.root().as_path(), config.executable_path)?;

    Ok(RunSpec {
        run_id: run_id.to_string(),
        role: RunRole::Submission,
        workspace_id: workspace_id.to_string(),
        executable_id,
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
    })
}

fn run_sandboxed_custom_checker(
    checker_exe: &Path,
    config: &TestCaseExecutionConfig<'_>,
    actual_bytes: &[u8],
    expected_bytes: &[u8],
    count: u64,
    max_score: Rational,
) -> (String, f64, Rational, Option<String>) {
    let chk_ws_id = format!("chk_{}_{}", std::process::id(), count);
    let chk_run_id = format!("chkrun_{}_{}", std::process::id(), count);
    let workspaces_root = config.platform.root().join("workspaces");
    let chk_ws = match crate::storage::OwnedWorkspace::create_with_id(&workspaces_root, &chk_ws_id)
    {
        Ok(ws) => ws,
        Err(e) => {
            return (
                "JE".to_string(),
                0.0,
                Rational::ZERO,
                Some(format!("Failed to create checker workspace: {e}")),
            );
        }
    };
    let chk_dir = chk_ws.root();

    let stdin_file = chk_dir.join("stdin.txt");
    let actual_file = chk_dir.join("actual.txt");
    let expected_file = chk_dir.join("expected.txt");
    let _ = fs::copy(config.input_path, &stdin_file);
    let _ = fs::write(&actual_file, actual_bytes);
    let _ = fs::write(&expected_file, expected_bytes);

    // Setup Themis folder hierarchy inside checker workspace: test/ and work/
    let test_dir = chk_dir.join("test");
    let work_dir = chk_dir.join("work");
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
    if let Ok(contained_inp) = chk_ws.resolve_contained_path(&Path::new("test").join(custom_inp)) {
        let _ = fs::copy(config.input_path, contained_inp);
    }
    let _ = fs::write(test_dir.join(default_out), expected_bytes);
    if let Ok(contained_test_out) =
        chk_ws.resolve_contained_path(&Path::new("test").join(custom_out))
    {
        let _ = fs::write(contained_test_out, expected_bytes);
    }
    let _ = fs::write(work_dir.join(default_out), actual_bytes);
    if let Ok(contained_work_out) =
        chk_ws.resolve_contained_path(&Path::new("work").join(custom_out))
    {
        let _ = fs::write(contained_work_out, actual_bytes);
    }

    let themis_stdin_file = chk_dir.join("themis.stdin");
    let _ = fs::write(&themis_stdin_file, b"test\nwork\n");

    let is_py = checker_exe
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("py"));

    let limits = RunLimits {
        wall_time_ms: 10_000,
        memory_bytes: 512 * 1024 * 1024,
        process_count: 1,
        thread_count: 32,
        output_bytes: 10 * 1024 * 1024,
        total_write_bytes: 50 * 1024 * 1024,
        open_files: 64,
        created_files: 128,
    };

    let chk_spec = if is_py {
        if let Err(e) = fs::copy(checker_exe, chk_dir.join("checker.py")) {
            return (
                "JE".to_string(),
                0.0,
                Rational::ZERO,
                Some(format!("Failed to stage Python checker: {e}")),
            );
        }
        let toolchain = resolve_toolchain_for_profile("python", None, None);
        if !toolchain.ready || !toolchain.executable_path.is_file() {
            return (
                "JE".to_string(),
                0.0,
                Rational::ZERO,
                Some("Python toolchain unavailable for custom checker".to_string()),
            );
        }
        let (executable_id, tc_grant, local_grant, env) = match prepare_python_runtime_launch(
            config.platform.root().as_path(),
            &toolchain,
            ToolchainGrantRole::CheckerRuntime,
        ) {
            Ok(prepared) => prepared,
            Err(e) => {
                return (
                    "JE".to_string(),
                    0.0,
                    Rational::ZERO,
                    Some(format!(
                        "Failed to prepare Python runtime for custom checker: {e}"
                    )),
                );
            }
        };
        RunSpec {
            run_id: chk_run_id,
            role: RunRole::CheckerRuntime,
            workspace_id: chk_ws_id,
            executable_id,
            args: vec![
                "-I".to_string(),
                "-B".to_string(),
                "-u".to_string(),
                "checker.py".to_string(),
                "stdin.txt".to_string(),
                "actual.txt".to_string(),
                "expected.txt".to_string(),
            ],
            stdin_file: Some("themis.stdin".to_string()),
            stdout_file: "stdout.txt".to_string(),
            stderr_file: "stderr.txt".to_string(),
            environment: env,
            toolchain: tc_grant,
            local_toolchain: local_grant,
            limits,
        }
    } else {
        let executable_id =
            match import_executor_artifact(config.platform.root().as_path(), checker_exe) {
                Ok(id) => id,
                Err(e) => {
                    return (
                        "JE".to_string(),
                        0.0,
                        Rational::ZERO,
                        Some(format!("Failed to stage custom checker binary: {e}")),
                    );
                }
            };
        RunSpec {
            run_id: chk_run_id,
            role: RunRole::Checker,
            workspace_id: chk_ws_id.clone(),
            executable_id,
            args: vec![
                "stdin.txt".to_string(),
                "actual.txt".to_string(),
                "expected.txt".to_string(),
            ],
            stdin_file: Some("themis.stdin".to_string()),
            stdout_file: "stdout.txt".to_string(),
            stderr_file: "stderr.txt".to_string(),
            environment: BTreeMap::new(),
            toolchain: None,
            local_toolchain: None,
            limits,
        }
    };

    if let Err(err) = validate_run(config.platform.root().as_path(), &chk_spec) {
        return (
            "JE".to_string(),
            0.0,
            Rational::ZERO,
            Some(format!("Checker validation error: {err}")),
        );
    }

    match config.platform.run_sync(Box::new(chk_spec)) {
        Ok(res) => {
            if !matches!(res.reason, RunReason::Exited) {
                return (
                    "JE".to_string(),
                    0.0,
                    Rational::ZERO,
                    Some(format!(
                        "Custom checker terminated abnormally: {:?}",
                        res.reason
                    )),
                );
            }
            let code = res.exit_code.unwrap_or(-1);
            let stdout_str = read_bounded_utf8(&chk_dir.join("stdout.txt"), 64 * 1024);
            let stderr_str = read_bounded_utf8(&chk_dir.join("stderr.txt"), 64 * 1024);
            let combined_msg = format!("{stderr_str} {stdout_str}").trim().to_string();

            let custom_res = crate::checkers::custom::parse_custom_checker_exit_rational(
                code,
                &combined_msg,
                &stdout_str,
                max_score,
            );

            let st = match custom_res.status {
                CheckerVerdict::AC => {
                    if custom_res.score_multiplier_exact < Rational::ONE
                        && custom_res.score_multiplier_exact > Rational::ZERO
                    {
                        "PARTIAL"
                    } else {
                        "AC"
                    }
                }
                CheckerVerdict::WA => "WA",
                CheckerVerdict::PE => "PE",
                CheckerVerdict::FAIL => "JE",
            };

            (
                st.to_string(),
                custom_res.score_multiplier,
                custom_res.score_multiplier_exact,
                Some(custom_res.message),
            )
        }
        Err(e) => (
            "JE".to_string(),
            0.0,
            Rational::ZERO,
            Some(format!("Failed to execute custom checker in sandbox: {e}")),
        ),
    }
}

pub fn run_interactive_test_case(
    config: TestCaseExecutionConfig,
    interactor_exe: &Path,
) -> TestRunOutput {
    run_interactive_test_case_with_max_score(config, interactor_exe, Rational::ONE)
}

pub fn run_interactive_test_case_with_max_score(
    config: TestCaseExecutionConfig,
    interactor_exe: &Path,
    max_score: Rational,
) -> TestRunOutput {
    let count = RUN_COUNTER.fetch_add(1, Ordering::Relaxed);
    let interactive_run_id = format!("exec_inter_{}_{}", std::process::id(), count);
    let sub_ws_id = format!("isub_{}_{}", std::process::id(), count);
    let sub_run_id = format!("isubrun_{}_{}", std::process::id(), count);
    let chk_ws_id = format!("ichk_{}_{}", std::process::id(), count);
    let chk_run_id = format!("ichkrun_{}_{}", std::process::id(), count);

    let workspaces_root = config.platform.root().join("workspaces");
    let sub_ws = match crate::storage::OwnedWorkspace::create_with_id(&workspaces_root, &sub_ws_id)
    {
        Ok(ws) => ws,
        Err(e) => {
            return TestRunOutput::judge_error(format!("Failed to create sub workspace: {e}"))
        }
    };
    let chk_ws = match crate::storage::OwnedWorkspace::create_with_id(&workspaces_root, &chk_ws_id)
    {
        Ok(ws) => ws,
        Err(e) => {
            return TestRunOutput::judge_error(format!("Failed to create chk workspace: {e}"))
        }
    };

    let mut sub_spec = match build_submission_spec(&config, &sub_ws, &sub_ws_id, &sub_run_id) {
        Ok(s) => s,
        Err(err) => return TestRunOutput::judge_error(err),
    };
    sub_spec.stdin_file = None;

    let chk_dir = chk_ws.root();
    if let Err(e) = fs::copy(config.input_path, chk_dir.join("input.txt")) {
        return TestRunOutput::judge_error(format!("Failed to stage interactive input: {e}"));
    }
    let expected_bytes = if config.expected_output_path.is_file() {
        fs::read(config.expected_output_path).unwrap_or_default()
    } else {
        Vec::new()
    };
    let _ = fs::write(chk_dir.join("answer.txt"), &expected_bytes);
    let _ = fs::write(chk_dir.join("tout.txt"), b"");

    let is_py_inter = interactor_exe
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("py"));

    let inter_limits = RunLimits {
        wall_time_ms: config.time_limit_ms.saturating_add(2_000).max(5_000),
        memory_bytes: 512 * 1024 * 1024,
        process_count: 1,
        thread_count: 32,
        output_bytes: 10 * 1024 * 1024,
        total_write_bytes: 50 * 1024 * 1024,
        open_files: 64,
        created_files: 128,
    };

    let interactor_spec = if is_py_inter {
        if let Err(e) = fs::copy(interactor_exe, chk_dir.join("interactor.py")) {
            return TestRunOutput::judge_error(format!("Failed to stage Python interactor: {e}"));
        }
        let toolchain = resolve_toolchain_for_profile("python", None, None);
        if !toolchain.ready || !toolchain.executable_path.is_file() {
            return TestRunOutput::judge_error(
                "Python toolchain unavailable for interactive problem",
            );
        }
        let (executable_id, tc_grant, local_grant, env) = match prepare_python_runtime_launch(
            config.platform.root().as_path(),
            &toolchain,
            ToolchainGrantRole::CheckerRuntime,
        ) {
            Ok(prepared) => prepared,
            Err(e) => {
                return TestRunOutput::judge_error(format!(
                    "Failed to prepare Python runtime for interactor: {e}"
                ))
            }
        };
        RunSpec {
            run_id: chk_run_id,
            role: RunRole::CheckerRuntime,
            workspace_id: chk_ws_id.clone(),
            executable_id,
            args: vec![
                "-I".to_string(),
                "-B".to_string(),
                "-u".to_string(),
                "interactor.py".to_string(),
                "input.txt".to_string(),
                "tout.txt".to_string(),
                "answer.txt".to_string(),
            ],
            stdin_file: None,
            stdout_file: "stdout.txt".to_string(),
            stderr_file: "stderr.txt".to_string(),
            environment: env,
            toolchain: tc_grant,
            local_toolchain: local_grant,
            limits: inter_limits,
        }
    } else {
        let executable_id =
            match import_executor_artifact(config.platform.root().as_path(), interactor_exe) {
                Ok(id) => id,
                Err(e) => {
                    return TestRunOutput::judge_error(format!(
                        "Failed to stage interactor binary: {e}"
                    ));
                }
            };

        RunSpec {
            run_id: chk_run_id,
            role: RunRole::Checker,
            workspace_id: chk_ws_id.clone(),
            executable_id,
            args: vec![
                "input.txt".to_string(),
                "tout.txt".to_string(),
                "answer.txt".to_string(),
            ],
            stdin_file: None,
            stdout_file: "stdout.txt".to_string(),
            stderr_file: "stderr.txt".to_string(),
            environment: BTreeMap::new(),
            toolchain: None,
            local_toolchain: None,
            limits: inter_limits,
        }
    };

    let pair_spec = judgedesk_native_executor::protocol::InteractiveRunSpec {
        run_id: interactive_run_id,
        submission: sub_spec,
        interactor: interactor_spec,
    };

    let expected_preview = preview_text(&String::from_utf8_lossy(&expected_bytes), 500);

    match config.platform.run_interactive_sync(Box::new(pair_spec)) {
        Ok(res) => {
            let execution_time_ms = res.execution_time_ms.max(1);
            let memory_used_kb = res.peak_memory_bytes.unwrap_or(0) / 1024;
            let actual_preview = res.transcript.as_deref().map(|t| preview_text(t, 500));

            let mut status = match res.verdict.as_str() {
                "CANCELLED" => "FAIL".to_string(),
                "RTE" => "RE".to_string(),
                other => other.to_string(),
            };
            let mut score_multiplier =
                res.score_multiplier
                    .unwrap_or(if status == "AC" { 1.0 } else { 0.0 });
            let mut score_multiplier_exact = if let Some(code) = res.interactor_result.exit_code {
                if (16..=116).contains(&code) && status == "PARTIAL" {
                    Rational::new(i64::from(code - 16), 100)
                } else if let Some(mult) = res.score_multiplier {
                    parse_rational_f64(mult)
                } else if status == "AC" {
                    Rational::ONE
                } else {
                    Rational::ZERO
                }
            } else if let Some(mult) = res.score_multiplier {
                parse_rational_f64(mult)
            } else if status == "AC" {
                Rational::ONE
            } else {
                Rational::ZERO
            };
            let mut message = res.message;

            if matches!(status.as_str(), "PARTIAL" | "AC" | "WA" | "PE") {
                if let Some(code) = res.interactor_result.exit_code {
                    let stderr_str = read_bounded_utf8(&chk_dir.join("stderr.txt"), 64 * 1024);
                    let parsed = crate::checkers::custom::parse_custom_checker_exit_rational(
                        code,
                        &stderr_str,
                        "",
                        max_score,
                    );
                    if res.score_multiplier.is_none()
                        || (parsed.score_multiplier_exact > Rational::ZERO
                            && parsed.score_multiplier_exact < Rational::ONE)
                    {
                        score_multiplier = parsed.score_multiplier;
                        score_multiplier_exact = parsed.score_multiplier_exact;
                        if message.is_none() || !parsed.message.is_empty() {
                            message = Some(parsed.message);
                        }
                        status = match parsed.status {
                            CheckerVerdict::AC => {
                                if score_multiplier_exact < Rational::ONE
                                    && score_multiplier_exact > Rational::ZERO
                                {
                                    "PARTIAL".to_string()
                                } else {
                                    "AC".to_string()
                                }
                            }
                            CheckerVerdict::WA => "WA".to_string(),
                            CheckerVerdict::PE => "PE".to_string(),
                            CheckerVerdict::FAIL => "JE".to_string(),
                        };
                    }
                }
            }

            let execution_telemetry =
                to_execution_diagnostics(&res.submission_result, config.memory_limit_mb);
            let error_detail =
                executor_diagnostic(&res.submission_result, &sub_ws.root().join("stderr.txt"));
            let checker_msg = if matches!(status.as_str(), "AC" | "WA" | "PE" | "PARTIAL" | "JE") {
                message
            } else {
                None
            };

            TestRunOutput {
                status,
                execution_time_ms,
                memory_used_kb,
                score_multiplier,
                score_multiplier_exact,
                message: checker_msg,
                expected_output_preview: Some(expected_preview),
                actual_output_preview: actual_preview,
                error_detail,
                execution: Some(execution_telemetry),
            }
        }
        Err(err) => TestRunOutput::judge_error(format!("Interactive executor error: {err}")),
    }
}

pub fn run_test_case(config: TestCaseExecutionConfig) -> TestRunOutput {
    run_test_case_with_max_score(config, Rational::ONE)
}

pub fn run_test_case_with_max_score(
    config: TestCaseExecutionConfig,
    max_score: Rational,
) -> TestRunOutput {
    let count = RUN_COUNTER.fetch_add(1, Ordering::Relaxed);
    let workspace_id = format!("run_{}_{}", std::process::id(), count);
    let run_id = format!("exec_{}_{}", std::process::id(), count);

    let workspaces_root = config.platform.root().join("workspaces");
    let workspace =
        match crate::storage::OwnedWorkspace::create_with_id(&workspaces_root, &workspace_id) {
            Ok(ws) => ws,
            Err(e) => {
                return TestRunOutput::judge_error(format!("Failed to create workspace: {e}"));
            }
        };
    let workspace_dir = workspace.root().to_path_buf();

    let stdin_path = workspace_dir.join("stdin.txt");
    let stdout_path = workspace_dir.join("stdout.txt");
    let stderr_path = workspace_dir.join("stderr.txt");

    // Stage input according to configured I/O mode:
    // - StdIn mode (input_file_name is empty): copy input to stdin.txt
    // - File I/O mode (input_file_name is non-empty): create empty stdin.txt and stage input ONLY to input_file_name
    if config.input_file_name.is_empty() {
        if let Err(e) = fs::copy(config.input_path, &stdin_path) {
            return TestRunOutput::judge_error(format!(
                "Failed to copy input file to workspace: {e}"
            ));
        }
    } else {
        if let Err(e) = fs::write(&stdin_path, b"") {
            return TestRunOutput::judge_error(format!(
                "Failed to initialize empty stdin file in workspace: {e}"
            ));
        }
        match workspace.resolve_contained_path(Path::new(config.input_file_name)) {
            Ok(problem_inp) => {
                if let Err(e) = fs::copy(config.input_path, &problem_inp) {
                    return TestRunOutput::judge_error(format!(
                        "Failed to copy input file to {}: {e}",
                        config.input_file_name
                    ));
                }
            }
            Err(e) => {
                return TestRunOutput::judge_error(format!(
                    "Invalid problem input file name '{}': {e}",
                    config.input_file_name
                ));
            }
        }
    }

    let spec = match build_submission_spec(&config, &workspace, &workspace_id, &run_id) {
        Ok(s) => s,
        Err(err) => {
            return TestRunOutput::judge_error(err);
        }
    };

    let _validated = match validate_run(config.platform.root().as_path(), &spec) {
        Ok(v) => v,
        Err(err) => {
            return TestRunOutput::judge_error(format!("Validation error: {err}"));
        }
    };

    let run_result = match config.platform.run_sync(Box::new(spec)) {
        Ok(res) => res,
        Err(err) => {
            return TestRunOutput::judge_error(format!("Executor error: {err}"));
        }
    };

    let execution_time_ms = if matches!(run_result.reason, RunReason::WallTimeLimit) {
        config.time_limit_ms
    } else {
        (run_result.wall_time_us / 1000).max(1)
    };

    let memory_used_kb = run_result.peak_memory_bytes.unwrap_or(0) / 1024;
    let execution_telemetry = to_execution_diagnostics(&run_result, config.memory_limit_mb);

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

    if let Some(verdict) = preliminary_verdict {
        let expected_preview =
            preview_text(&read_bounded_utf8(config.expected_output_path, 2048), 500);
        let error_detail = executor_diagnostic(&run_result, &stderr_path);
        return TestRunOutput {
            status: verdict.to_string(),
            execution_time_ms,
            memory_used_kb,
            score_multiplier: 0.0,
            score_multiplier_exact: Rational::ZERO,
            message: None,
            expected_output_preview: Some(expected_preview),
            actual_output_preview: None,
            error_detail,
            execution: Some(execution_telemetry),
        };
    }

    let expected_bytes = fs::read(config.expected_output_path).unwrap_or_default();
    let expected_preview = preview_text(&String::from_utf8_lossy(&expected_bytes), 500);

    // Process exited with 0: check output strictly according to configured I/O mode.
    // Never fall back to stdout when a named output file is required.
    let actual_bytes = if !config.output_file_name.is_empty() {
        workspace
            .resolve_contained_path(Path::new(config.output_file_name))
            .ok()
            .filter(|p| p.is_file())
            .and_then(|p| fs::read(p).ok())
            .unwrap_or_default()
    } else if stdout_path.is_file() {
        fs::read(&stdout_path).unwrap_or_default()
    } else {
        Vec::new()
    };

    let actual_preview = preview_text(&String::from_utf8_lossy(&actual_bytes), 500);

    let (final_status, score_mult, score_mult_exact, final_msg) =
        if let Some(checker_exe) = config.custom_checker_path {
            run_sandboxed_custom_checker(
                checker_exe,
                &config,
                &actual_bytes,
                &expected_bytes,
                count,
                max_score,
            )
        } else {
            let check = run_standard_checker(config.checker_type, &expected_bytes, &actual_bytes);
            let (st, mult, mult_exact) = match check.status {
                CheckerVerdict::AC => ("AC", 1.0, Rational::ONE),
                CheckerVerdict::WA => ("WA", 0.0, Rational::ZERO),
                CheckerVerdict::PE => ("PE", 0.0, Rational::ZERO),
                CheckerVerdict::FAIL => ("FAIL", 0.0, Rational::ZERO),
            };
            (st.to_string(), mult, mult_exact, Some(check.message))
        };

    let error_detail = if final_status == "JE" {
        final_msg.clone()
    } else {
        None
    };

    TestRunOutput {
        status: final_status,
        execution_time_ms,
        memory_used_kb,
        score_multiplier: score_mult,
        score_multiplier_exact: score_mult_exact,
        message: final_msg,
        expected_output_preview: Some(expected_preview),
        actual_output_preview: Some(actual_preview),
        error_detail,
        execution: Some(execution_telemetry),
    }
}
