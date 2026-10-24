use super::{failure, reported_peak_memory_bytes, root_display, ActiveRuns, Cancellation};
use crate::protocol::{
    ExecutorHealth, ExecutorStartupTimings, InteractiveRunResult, InteractiveRunSpec,
    LocalToolchainIsolation, RunLimits, RunReason, RunResult, RunRole, RunSpec,
};
use crate::request_validation::{validate_interactive_pair, validate_run, ValidatedRun};
use crate::workspace::{file_size, initialize_root, inspect_workspace};
use std::collections::BTreeMap;
use std::ffi::CString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

const BWRAP_PATH: &str = "/usr/bin/bwrap";
const BUSCTL_PATH: &str = "/usr/bin/busctl";
const CGROUP_ROOT: &str = "/sys/fs/cgroup";
const BWRAP_TASK_OVERHEAD: u64 = 2;
const SANDBOX_TMPDIR: &str = "/tmp/.judgedesk-tmp";

static NEXT_JOB_COUNTER: AtomicU64 = AtomicU64::new(1);

pub struct LinuxPlatform {
    cgroup_base: PathBuf,
    self_test: SelfTest,
    startup_timings: ExecutorStartupTimings,
}

struct SelfTest {
    ready: bool,
    diagnostics: Vec<String>,
    network_blocked: bool,
    filesystem_isolated: bool,
    process_tree_controlled: bool,
}

struct LinuxCancellation {
    job_cgroup: PathBuf,
    cancelled: Arc<AtomicBool>,
}

impl Cancellation for LinuxCancellation {
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        kill_cgroup_tree(&self.job_cgroup);
    }
}

struct InteractiveLinuxCancellation {
    sub_cgroup: PathBuf,
    inter_cgroup: PathBuf,
    cancelled: Arc<AtomicBool>,
}

impl Cancellation for InteractiveLinuxCancellation {
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        kill_cgroup_tree(&self.sub_cgroup);
        kill_cgroup_tree(&self.inter_cgroup);
    }
}

struct JobCgroup {
    path: PathBuf,
}

impl JobCgroup {
    fn create(
        base: &Path,
        run_id: &str,
        limits: &RunLimits,
        strict_isolation: bool,
    ) -> Result<Self, String> {
        let seq = NEXT_JOB_COUNTER.fetch_add(1, Ordering::Relaxed);
        let safe_id: String = run_id
            .chars()
            .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_')
            .take(48)
            .collect();
        let path = base.join(format!("job-{safe_id}-{seq}"));
        fs::create_dir(&path)
            .map_err(|error| format!("create job cgroup {}: {error}", path.display()))?;

        let setup = (|| -> Result<(), String> {
            fs::write(path.join("memory.max"), limits.memory_bytes.to_string())
                .map_err(|error| format!("write memory.max: {error}"))?;
            if let Err(error) = fs::write(path.join("memory.swap.max"), "0") {
                if error.kind() != io::ErrorKind::NotFound {
                    return Err(format!("write memory.swap.max: {error}"));
                }
            }
            let overhead = if strict_isolation {
                BWRAP_TASK_OVERHEAD
            } else {
                0
            };
            let pids_max = if limits.process_count == 1 && strict_isolation {
                overhead.saturating_add(limits.thread_count as u64)
            } else {
                overhead
                    .saturating_add(limits.process_count.max(limits.thread_count) as u64)
                    .saturating_add(1)
            };
            fs::write(path.join("pids.max"), pids_max.to_string())
                .map_err(|error| format!("write pids.max: {error}"))?;
            Ok(())
        })();

        if let Err(error) = setup {
            let _ = fs::remove_dir(&path);
            return Err(error);
        }
        Ok(Self { path })
    }

    fn drain_and_remove(&self, timeout: Duration) -> bool {
        kill_cgroup_tree(&self.path);
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if cgroup_line_count(&self.path.join("cgroup.procs")) == 0
                && (fs::remove_dir(&self.path).is_ok() || !self.path.exists())
            {
                return true;
            }
            kill_cgroup_tree(&self.path);
            std::thread::sleep(Duration::from_millis(2));
        }
        let _ = fs::remove_dir(&self.path);
        !self.path.exists()
    }
}

impl Drop for JobCgroup {
    fn drop(&mut self) {
        if self.path.exists() {
            let _ = self.drain_and_remove(Duration::from_secs(2));
        }
    }
}

impl LinuxPlatform {
    pub fn initialize() -> Result<(Self, PathBuf), String> {
        let startup_started = Instant::now();
        let mut phases = BTreeMap::new();

        let phase_started = Instant::now();
        if !Path::new(BWRAP_PATH).is_file() {
            return Err(format!(
                "SECURE_RUNNER_UNAVAILABLE: {BWRAP_PATH} was not found"
            ));
        }
        if !Path::new("/sys/fs/cgroup/cgroup.controllers").is_file() {
            return Err("SECURE_RUNNER_UNAVAILABLE: cgroup v2 unified hierarchy (/sys/fs/cgroup/cgroup.controllers) is not available".into());
        }
        let cgroup_base = ensure_delegated_cgroup_root()?;
        phases.insert("platformCheck".into(), elapsed_us(phase_started));

        let phase_started = Instant::now();
        let root = initialize_root(std::env::temp_dir())?;
        phases.insert("root".into(), elapsed_us(phase_started));

        let mut platform = Self {
            cgroup_base,
            self_test: SelfTest {
                ready: false,
                diagnostics: vec!["security self-test has not run".into()],
                network_blocked: false,
                filesystem_isolated: false,
                process_tree_controlled: false,
            },
            startup_timings: ExecutorStartupTimings {
                total_time_us: 0,
                phases,
            },
        };

        let phase_started = Instant::now();
        platform.self_test = platform.run_self_test(&root);
        platform
            .startup_timings
            .phases
            .insert("selfTest".into(), elapsed_us(phase_started));
        platform.startup_timings.total_time_us = elapsed_us(startup_started);
        Ok((platform, root))
    }

    pub fn health(&self, root: &Path) -> ExecutorHealth {
        ExecutorHealth {
            ready: self.self_test.ready,
            mode: "linux-bwrap-cgroup-seccomp".into(),
            executor_version: env!("CARGO_PKG_VERSION").into(),
            executor_root: root_display(root),
            diagnostics: self.self_test.diagnostics.clone(),
            network_blocked: self.self_test.network_blocked,
            filesystem_isolated: self.self_test.filesystem_isolated,
            process_tree_controlled: self.self_test.process_tree_controlled,
            memory_limit_supported: self.self_test.ready,
            startup_timings: Some(self.startup_timings.clone()),
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
            fs::create_dir_all(&workspace)
                .map_err(|error| format!("cannot create security probe workspace: {error}"))?;

            let current_exe = locate_security_probe_executable()?;
            let staged_exe = root.join("artifacts").join("security-probe");
            let need_copy = match (fs::metadata(&current_exe), fs::metadata(&staged_exe)) {
                (Ok(src_meta), Ok(dst_meta)) => src_meta.len() != dst_meta.len(),
                _ => true,
            };
            if need_copy {
                let _ = fs::remove_file(&staged_exe);
                fs::copy(&current_exe, &staged_exe)
                    .map_err(|error| format!("cannot stage security probe: {error}"))?;
                fs::set_permissions(&staged_exe, fs::Permissions::from_mode(0o500))
                    .map_err(|error| format!("cannot make security probe executable: {error}"))?;
            }

            let sentinel = std::env::temp_dir().join(format!(
                "judgedesk-sentinel-{}-{}.txt",
                std::process::id(),
                workspace_id
            ));
            let _ = fs::remove_file(&sentinel);
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
                environment: BTreeMap::new(),
                toolchain: None,
                local_toolchain: None,
                limits: RunLimits {
                    wall_time_ms: 20_000,
                    memory_bytes: 128 * 1024 * 1024,
                    process_count: 1,
                    thread_count: 16,
                    output_bytes: 1024 * 1024,
                    total_write_bytes: 4 * 1024 * 1024,
                    open_files: 32,
                    created_files: 16,
                },
            };

            let validated = validate_run(root, &spec)?;
            let active: ActiveRuns =
                Arc::new(std::sync::Mutex::new(std::collections::HashMap::new()));
            let run = self.run_inner(root, &spec, &validated, &active)?;
            let output = fs::read_to_string(workspace.join("probe.stdout")).map_err(|error| {
                format!(
                    "cannot read security probe: {error}; reason={:?}; exit={:?}; diagnostic={:?}",
                    run.reason, run.exit_code, run.diagnostic
                )
            })?;
            let probe: serde_json::Value = serde_json::from_str(output.trim()).map_err(|error| {
                let stderr = fs::read_to_string(workspace.join("probe.stderr")).unwrap_or_default();
                format!(
                    "security probe returned invalid JSON: {error}; reason={:?}; exit={:?}; stderr={}",
                    run.reason,
                    run.exit_code,
                    stderr.trim()
                )
            })?;

            let sentinel_intact = fs::read(&sentinel)
                .map(|value| value == b"JUDGEDESK_SENTINEL")
                .unwrap_or(false);
            let _ = fs::remove_file(&sentinel);
            let _ = fs::remove_dir_all(&workspace);

            let filesystem = probe["readBlocked"].as_bool() == Some(true)
                && probe["writeBlocked"].as_bool() == Some(true)
                && sentinel_intact;
            let network = probe["networkBlocked"].as_bool() == Some(true);
            let process = probe["processAttemptStarted"].as_bool() == Some(true)
                && (matches!(run.reason, RunReason::ProcessLimit)
                    || (matches!(run.reason, RunReason::Exited) && run.exit_code == Some(0)));
            let ready = filesystem && network && process;
            let diagnostics = if ready {
                Vec::new()
            } else {
                vec![format!(
                    "SECURE_RUNNER_SELF_TEST_FAILED: probe={probe}, reason={:?}, exit={:?}",
                    run.reason, run.exit_code
                )]
            };
            Ok(SelfTest {
                ready,
                diagnostics,
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
        validated: &ValidatedRun,
        active: &ActiveRuns,
    ) -> RunResult {
        match self.run_inner(root, spec, validated, active) {
            Ok(result) => result,
            Err(error) => failure(spec, RunReason::LaunchError, error),
        }
    }

    fn run_inner(
        &self,
        root: &Path,
        spec: &RunSpec,
        paths: &ValidatedRun,
        active: &ActiveRuns,
    ) -> Result<RunResult, String> {
        let setup_started = Instant::now();
        let strict_isolation = matches!(paths.isolation, LocalToolchainIsolation::Strict);
        let (baseline_bytes, baseline_files) = inspect_workspace(&paths.workspace);

        let stdin_file = match &paths.stdin {
            Some(path) => OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_NOFOLLOW)
                .open(path)
                .map_err(|error| format!("open stdin {}: {error}", path.display()))?,
            None => OpenOptions::new()
                .read(true)
                .open("/dev/null")
                .map_err(|error| format!("open /dev/null: {error}"))?,
        };
        let stdout_file = open_output_file(&paths.stdout)?;
        let stderr_file = open_output_file(&paths.stderr)?;

        let job_cgroup = JobCgroup::create(
            &self.cgroup_base,
            &spec.run_id,
            &spec.limits,
            strict_isolation,
        )?;
        let cgroup_procs_file = OpenOptions::new()
            .write(true)
            .custom_flags(libc::O_CLOEXEC)
            .open(job_cgroup.path.join("cgroup.procs"))
            .map_err(|error| format!("open job cgroup.procs: {error}"))?;

        let (status_read_fd, status_write_fd) = if strict_isolation {
            let (r, w) = create_status_pipe()?;
            (Some(r), Some(w))
        } else {
            (None, None)
        };
        let seccomp_fd = if strict_isolation {
            Some(create_seccomp_memfd(spec.limits.process_count == 1)?)
        } else {
            None
        };

        let mut command = if strict_isolation {
            let status_fd_num = status_write_fd
                .as_ref()
                .map(AsRawFd::as_raw_fd)
                .ok_or_else(|| "missing bwrap status pipe".to_string())?;
            let seccomp_fd_num = seccomp_fd
                .as_ref()
                .map(AsRawFd::as_raw_fd)
                .ok_or_else(|| "missing seccomp memfd".to_string())?;
            build_bwrap_command(root, spec, paths, status_fd_num, seccomp_fd_num)?
        } else {
            build_resource_only_command(spec, paths)
        };

        command
            .stdin(Stdio::from(stdin_file))
            .stdout(Stdio::from(stdout_file))
            .stderr(Stdio::from(stderr_file));

        let cgroup_procs_raw_fd = cgroup_procs_file.as_raw_fd();
        let fsize_limit = spec.limits.total_write_bytes;
        let nofile_limit = (spec.limits.open_files as u64).max(64);
        unsafe {
            command.pre_exec(move || {
                let written = libc::write(cgroup_procs_raw_fd, b"0\n".as_ptr().cast(), 2);
                if written != 2 {
                    return Err(io::Error::last_os_error());
                }
                let zero_rlim = libc::rlimit {
                    rlim_cur: 0,
                    rlim_max: 0,
                };
                let _ = libc::setrlimit(libc::RLIMIT_CORE, &zero_rlim);
                let fsize_rlim = libc::rlimit {
                    rlim_cur: fsize_limit,
                    rlim_max: fsize_limit,
                };
                if libc::setrlimit(libc::RLIMIT_FSIZE, &fsize_rlim) != 0 {
                    return Err(io::Error::last_os_error());
                }
                let nofile_rlim = libc::rlimit {
                    rlim_cur: nofile_limit,
                    rlim_max: nofile_limit,
                };
                let _ = libc::setrlimit(libc::RLIMIT_NOFILE, &nofile_rlim);
                Ok(())
            });
        }

        let cancelled = Arc::new(AtomicBool::new(false));
        let cancellation: Arc<dyn Cancellation> = Arc::new(LinuxCancellation {
            job_cgroup: job_cgroup.path.clone(),
            cancelled: Arc::clone(&cancelled),
        });
        {
            let mut runs = active.lock().unwrap_or_else(|p| p.into_inner());
            if runs.contains_key(&spec.run_id) {
                return Err("duplicate active runId".into());
            }
            runs.insert(spec.run_id.clone(), cancellation);
        }

        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                active
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .remove(&spec.run_id);
                return Err(format!("spawn sandboxed process: {error}"));
            }
        };
        drop(cgroup_procs_file);
        drop(status_write_fd);
        drop(seccomp_fd);

        let security_setup_time_us = elapsed_us(setup_started);
        let started = Instant::now();
        let deadline = started + Duration::from_millis(spec.limits.wall_time_ms);
        let mut next_resource_check = started;
        let mut reason = RunReason::Exited;
        let mut diagnostic: Option<String> = None;
        let mut terminated = false;
        let mut max_observed_memory: u64 = 0;
        let mut max_observed_procs: u32 = 0;
        let mut exit_status: Option<std::process::ExitStatus> = None;

        loop {
            if let Some(current_mem) = read_u64_file(&job_cgroup.path.join("memory.current")) {
                max_observed_memory = max_observed_memory.max(current_mem);
            }

            if cancelled.load(Ordering::Acquire) {
                reason = RunReason::Cancelled;
            } else if cgroup_has_oom(&job_cgroup.path) {
                reason = RunReason::MemoryLimit;
            } else if matches!(
                reason,
                RunReason::MemoryLimit | RunReason::ProcessLimit | RunReason::ThreadLimit
            ) {
                // Preserve sticky kernel resource-limit classification.
            } else if cgroup_pids_max_reached(&job_cgroup.path) {
                if spec.limits.process_count == 1 && strict_isolation {
                    reason = RunReason::ThreadLimit;
                } else {
                    let live_procs = live_user_processes(&job_cgroup.path, strict_isolation);
                    max_observed_procs = max_observed_procs.max(live_procs);
                    if max_observed_procs >= spec.limits.process_count {
                        reason = RunReason::ProcessLimit;
                    } else {
                        reason = RunReason::ThreadLimit;
                    }
                }
            } else if started.elapsed() >= Duration::from_millis(spec.limits.wall_time_ms) {
                reason = RunReason::WallTimeLimit;
            } else if file_size(&paths.stdout).saturating_add(file_size(&paths.stderr))
                > spec.limits.output_bytes
            {
                reason = RunReason::OutputLimit;
            } else if Instant::now() >= next_resource_check
                && deadline.saturating_duration_since(Instant::now()) > Duration::from_millis(20)
            {
                let live_procs = live_user_processes(&job_cgroup.path, strict_isolation);
                let live_threads = live_user_threads(&job_cgroup.path, strict_isolation);
                max_observed_procs = max_observed_procs.max(live_procs);
                if live_procs > spec.limits.process_count {
                    reason = RunReason::ProcessLimit;
                } else if live_threads > spec.limits.thread_count {
                    reason = RunReason::ThreadLimit;
                } else {
                    let (workspace_bytes, workspace_files) = inspect_workspace(&paths.workspace);
                    if workspace_bytes.saturating_sub(baseline_bytes)
                        > spec.limits.total_write_bytes
                    {
                        reason = RunReason::WriteLimit;
                    } else if workspace_files.saturating_sub(baseline_files)
                        > spec.limits.created_files
                    {
                        reason = RunReason::WriteLimit;
                        diagnostic = Some("created-file limit exceeded".into());
                    }
                }
                next_resource_check = Instant::now() + Duration::from_millis(15);
            }

            if !matches!(reason, RunReason::Exited) && !terminated {
                kill_cgroup_tree(&job_cgroup.path);
                terminated = true;
            }

            match child.try_wait() {
                Ok(Some(status)) => {
                    exit_status = Some(status);
                    break;
                }
                Ok(None) => {
                    std::thread::sleep(Duration::from_millis(2));
                }
                Err(error) => {
                    reason = RunReason::InternalError;
                    diagnostic = Some(format!("waitpid failed: {error}"));
                    kill_cgroup_tree(&job_cgroup.path);
                    break;
                }
            }
        }

        let wall_time_us = elapsed_us(started);
        let collection_started = Instant::now();

        if exit_status.is_none() {
            kill_cgroup_tree(&job_cgroup.path);
            exit_status = child.wait().ok();
        }

        if cgroup_has_oom(&job_cgroup.path) && !matches!(reason, RunReason::Cancelled) {
            reason = RunReason::MemoryLimit;
        } else if matches!(reason, RunReason::Exited) && cgroup_pids_max_reached(&job_cgroup.path) {
            if spec.limits.process_count == 1 && strict_isolation {
                reason = RunReason::ThreadLimit;
            } else if max_observed_procs >= spec.limits.process_count {
                reason = RunReason::ProcessLimit;
            } else {
                reason = RunReason::ThreadLimit;
            }
        }

        let peak_from_cgroup = read_u64_file(&job_cgroup.path.join("memory.peak"))
            .or_else(|| (max_observed_memory > 0).then_some(max_observed_memory));
        let (user_cpu, kernel_cpu) = read_cgroup_cpu_times(&job_cgroup.path);

        let drained = job_cgroup.drain_and_remove(Duration::from_secs(5));
        active
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&spec.run_id);
        if !drained {
            reason = RunReason::InternalError;
            diagnostic = Some("Linux cgroup did not become empty during teardown".into());
        }

        let payload_exit_code = status_read_fd
            .and_then(read_bwrap_status)
            .and_then(|status| status.payload_exit_code());
        if strict_isolation && matches!(reason, RunReason::Exited) && payload_exit_code.is_none() {
            let stderr_preview = fs::read_to_string(&paths.stderr).unwrap_or_default();
            return Err(format!(
                "bwrap failed before launching target executable: {}",
                stderr_preview.trim()
            ));
        }

        let raw_exit_code = payload_exit_code
            .or_else(|| exit_status.and_then(|status| status.code()))
            .or_else(|| {
                exit_status
                    .and_then(|status| status.signal())
                    .map(|sig| 128 + sig)
            });

        if matches!(reason, RunReason::Exited) {
            if spec.limits.process_count == 1
                && strict_isolation
                && raw_exit_code == Some(128 + libc::SIGSYS)
            {
                reason = RunReason::ProcessLimit;
            } else if raw_exit_code == Some(128 + libc::SIGXFSZ) {
                reason = RunReason::WriteLimit;
            }
        }

        let stdout_bytes = file_size(&paths.stdout);
        let stderr_bytes = file_size(&paths.stderr);
        let (workspace_bytes, created_files) = inspect_workspace(&paths.workspace);
        if matches!(reason, RunReason::Exited) {
            if stdout_bytes.saturating_add(stderr_bytes) > spec.limits.output_bytes {
                reason = RunReason::OutputLimit;
            } else if workspace_bytes.saturating_sub(baseline_bytes) > spec.limits.total_write_bytes
            {
                reason = RunReason::WriteLimit;
            } else if created_files.saturating_sub(baseline_files) > spec.limits.created_files {
                reason = RunReason::WriteLimit;
                diagnostic = Some("created-file limit exceeded".into());
            }
        }

        let (exit_code, signal_or_status) = classify_exit_code_and_signal(raw_exit_code, &reason);
        let peak_memory_bytes =
            reported_peak_memory_bytes(&reason, peak_from_cgroup, spec.limits.memory_bytes);
        let result_collection_time_us = elapsed_us(collection_started);

        Ok(RunResult {
            run_id: spec.run_id.clone(),
            reason,
            exit_code,
            signal_or_status,
            security_setup_time_us,
            wall_time_us,
            result_collection_time_us,
            user_cpu_time_us: user_cpu,
            kernel_cpu_time_us: kernel_cpu,
            peak_memory_bytes,
            stdout_bytes,
            stderr_bytes,
            created_files: Some(created_files),
            diagnostic,
        })
    }

    pub fn run_interactive(
        &self,
        root: &Path,
        spec: &InteractiveRunSpec,
        active: &ActiveRuns,
    ) -> InteractiveRunResult {
        match self.run_interactive_inner(root, spec, active) {
            Ok(result) => result,
            Err(diagnostic) => crate::platform::interactive_failure(spec, diagnostic),
        }
    }

    fn run_interactive_inner(
        &self,
        root: &Path,
        spec: &InteractiveRunSpec,
        active: &ActiveRuns,
    ) -> Result<InteractiveRunResult, String> {
        let setup_started = Instant::now();
        let sub_paths = validate_run(root, &spec.submission)?;
        let inter_paths = validate_run(root, &spec.interactor)?;
        validate_interactive_pair(spec, &sub_paths, &inter_paths)?;

        // Pipe 1: Interactor STDOUT -> Submission STDIN
        let (sub_stdin_r, inter_stdout_w) = create_io_pipe()?;
        // Pipe 2: Submission STDOUT -> Interactor STDIN
        let (inter_stdin_r, sub_stdout_w) = create_io_pipe()?;

        let sub_stderr = open_output_file(&sub_paths.stderr)?;
        let inter_stderr = open_output_file(&inter_paths.stderr)?;
        let _ = open_output_file(&sub_paths.stdout)?;
        let _ = open_output_file(&inter_paths.stdout)?;

        let sub_cgroup = JobCgroup::create(
            &self.cgroup_base,
            &spec.submission.run_id,
            &spec.submission.limits,
            true,
        )?;
        let inter_cgroup = JobCgroup::create(
            &self.cgroup_base,
            &spec.interactor.run_id,
            &spec.interactor.limits,
            true,
        )?;

        let cancelled = Arc::new(AtomicBool::new(false));
        let cancellation: Arc<dyn Cancellation> = Arc::new(InteractiveLinuxCancellation {
            sub_cgroup: sub_cgroup.path.clone(),
            inter_cgroup: inter_cgroup.path.clone(),
            cancelled: Arc::clone(&cancelled),
        });
        {
            let mut runs = active.lock().unwrap_or_else(|p| p.into_inner());
            if runs.contains_key(&spec.run_id) {
                return Err("duplicate active runId".into());
            }
            runs.insert(spec.run_id.clone(), cancellation);
        }

        let spawn_participant = |participant: &RunSpec,
                                 paths: &ValidatedRun,
                                 cgroup: &JobCgroup,
                                 stdin_fd: OwnedFd,
                                 stdout_fd: OwnedFd,
                                 stderr_file: File|
         -> Result<(Child, OwnedFd), String> {
            let cgroup_procs = OpenOptions::new()
                .write(true)
                .custom_flags(libc::O_CLOEXEC)
                .open(cgroup.path.join("cgroup.procs"))
                .map_err(|error| format!("open interactive cgroup.procs: {error}"))?;
            let (status_r, status_w) = create_status_pipe()?;
            let seccomp_fd = create_seccomp_memfd(participant.limits.process_count == 1)?;
            let mut cmd = build_bwrap_command(
                root,
                participant,
                paths,
                status_w.as_raw_fd(),
                seccomp_fd.as_raw_fd(),
            )?;
            cmd.stdin(Stdio::from(File::from(stdin_fd)))
                .stdout(Stdio::from(File::from(stdout_fd)))
                .stderr(Stdio::from(stderr_file));

            let cg_fd = cgroup_procs.as_raw_fd();
            let fsize_limit = participant.limits.total_write_bytes;
            let nofile_limit = (participant.limits.open_files as u64).max(64);
            unsafe {
                cmd.pre_exec(move || {
                    if libc::write(cg_fd, b"0\n".as_ptr().cast(), 2) != 2 {
                        return Err(io::Error::last_os_error());
                    }
                    let zero_rlim = libc::rlimit {
                        rlim_cur: 0,
                        rlim_max: 0,
                    };
                    let _ = libc::setrlimit(libc::RLIMIT_CORE, &zero_rlim);
                    let fsize_rlim = libc::rlimit {
                        rlim_cur: fsize_limit,
                        rlim_max: fsize_limit,
                    };
                    if libc::setrlimit(libc::RLIMIT_FSIZE, &fsize_rlim) != 0 {
                        return Err(io::Error::last_os_error());
                    }
                    let nofile_rlim = libc::rlimit {
                        rlim_cur: nofile_limit,
                        rlim_max: nofile_limit,
                    };
                    let _ = libc::setrlimit(libc::RLIMIT_NOFILE, &nofile_rlim);
                    Ok(())
                });
            }
            let child = cmd
                .spawn()
                .map_err(|error| format!("spawn interactive participant: {error}"))?;
            drop(cgroup_procs);
            drop(status_w);
            drop(seccomp_fd);
            Ok((child, status_r))
        };

        let (mut sub_child, sub_status_fd) = match spawn_participant(
            &spec.submission,
            &sub_paths,
            &sub_cgroup,
            sub_stdin_r,
            sub_stdout_w,
            sub_stderr,
        ) {
            Ok(pair) => pair,
            Err(error) => {
                active
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .remove(&spec.run_id);
                return Err(error);
            }
        };

        let (mut inter_child, inter_status_fd) = match spawn_participant(
            &spec.interactor,
            &inter_paths,
            &inter_cgroup,
            inter_stdin_r,
            inter_stdout_w,
            inter_stderr,
        ) {
            Ok(pair) => pair,
            Err(error) => {
                let _ = sub_cgroup.drain_and_remove(Duration::from_secs(2));
                let _ = sub_child.wait();
                active
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .remove(&spec.run_id);
                return Err(error);
            }
        };

        let security_setup_time_us = elapsed_us(setup_started);
        let started = Instant::now();
        let sub_limit_ms = spec.submission.limits.wall_time_ms;
        let watchdog_deadline =
            started + Duration::from_millis((sub_limit_ms * 2).max(sub_limit_ms + 2000));
        let mut sub_reason = RunReason::Exited;
        let mut sub_status: Option<std::process::ExitStatus> = None;
        let mut inter_status: Option<std::process::ExitStatus> = None;
        let mut sub_stopped_by_peer = false;
        let mut inter_stopped_by_peer = false;
        let mut max_sub_memory: u64 = 0;

        loop {
            if let Some(current_mem) = read_u64_file(&sub_cgroup.path.join("memory.current")) {
                max_sub_memory = max_sub_memory.max(current_mem);
            }

            if cancelled.load(Ordering::Acquire) {
                sub_reason = RunReason::Cancelled;
                kill_cgroup_tree(&sub_cgroup.path);
                kill_cgroup_tree(&inter_cgroup.path);
                break;
            }

            if cgroup_has_oom(&sub_cgroup.path) {
                sub_reason = RunReason::MemoryLimit;
                kill_cgroup_tree(&sub_cgroup.path);
                kill_cgroup_tree(&inter_cgroup.path);
                break;
            }

            if cgroup_pids_max_reached(&sub_cgroup.path) {
                sub_reason = RunReason::ThreadLimit;
                kill_cgroup_tree(&sub_cgroup.path);
                kill_cgroup_tree(&inter_cgroup.path);
                break;
            }

            if Instant::now() >= watchdog_deadline {
                sub_reason = RunReason::WallTimeLimit;
                kill_cgroup_tree(&sub_cgroup.path);
                kill_cgroup_tree(&inter_cgroup.path);
                break;
            }

            if inter_status.is_none() {
                if let Ok(Some(status)) = inter_child.try_wait() {
                    inter_status = Some(status);
                }
            }
            if sub_status.is_none() {
                if let Ok(Some(status)) = sub_child.try_wait() {
                    sub_status = Some(status);
                }
            }

            if inter_status.is_some() {
                std::thread::sleep(Duration::from_millis(50));
                if sub_status.is_none() {
                    sub_status = sub_child.try_wait().ok().flatten();
                }
                sub_stopped_by_peer = sub_status.is_none();
                kill_cgroup_tree(&sub_cgroup.path);
                break;
            }

            if sub_status.is_some() {
                let wait_deadline = Instant::now() + Duration::from_millis(200);
                while inter_status.is_none() && Instant::now() < wait_deadline {
                    if let Ok(Some(status)) = inter_child.try_wait() {
                        inter_status = Some(status);
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(5));
                }
                inter_stopped_by_peer = inter_status.is_none();
                kill_cgroup_tree(&inter_cgroup.path);
                break;
            }

            std::thread::sleep(Duration::from_millis(2));
        }

        let wall_time_us = elapsed_us(started);
        let collection_started = Instant::now();

        if cgroup_has_oom(&sub_cgroup.path) && !matches!(sub_reason, RunReason::Cancelled) {
            sub_reason = RunReason::MemoryLimit;
        }
        let sub_peak_raw = read_u64_file(&sub_cgroup.path.join("memory.peak"))
            .or_else(|| (max_sub_memory > 0).then_some(max_sub_memory));
        let (sub_user_cpu, sub_kernel_cpu) = read_cgroup_cpu_times(&sub_cgroup.path);

        let sub_drained = sub_cgroup.drain_and_remove(Duration::from_secs(2));
        let inter_drained = inter_cgroup.drain_and_remove(Duration::from_secs(2));
        if sub_status.is_none() {
            sub_status = sub_child.wait().ok();
        }
        if inter_status.is_none() {
            inter_status = inter_child.wait().ok();
        }
        active
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&spec.run_id);

        if !sub_drained || !inter_drained {
            return Err(format!(
                "interactive cgroup teardown timed out: submissionDrained={sub_drained}, interactorDrained={inter_drained}"
            ));
        }

        let sub_payload_exit =
            read_bwrap_status(sub_status_fd).and_then(|status| status.payload_exit_code());
        let inter_payload_exit =
            read_bwrap_status(inter_status_fd).and_then(|status| status.payload_exit_code());
        let sub_raw_exit = sub_payload_exit.or_else(|| sub_status.and_then(|s| s.code()));
        let inter_raw_exit = inter_payload_exit.or_else(|| inter_status.and_then(|s| s.code()));

        if matches!(sub_reason, RunReason::Exited)
            && sub_raw_exit == Some(128 + libc::SIGSYS)
            && spec.submission.limits.process_count == 1
        {
            sub_reason = RunReason::ProcessLimit;
        }

        let sub_cpu_us = sub_user_cpu.unwrap_or(0) + sub_kernel_cpu.unwrap_or(0);
        let execution_time_ms = sub_cpu_us / 1000;
        if execution_time_ms > spec.submission.limits.wall_time_ms
            && matches!(sub_reason, RunReason::Exited)
        {
            sub_reason = RunReason::WallTimeLimit;
        }

        // A child PID is emitted before exec. Only Bubblewrap's final payload
        // status proves an exit belongs to the program, rather than the wrapper.
        // Explicit limits/cancel and participants stopped for their peer retain
        // their existing classification even when teardown interrupts that status.
        if matches!(sub_reason, RunReason::Exited) {
            for (name, exit, stopped, stderr_path) in [
                (
                    "submission",
                    sub_payload_exit,
                    sub_stopped_by_peer,
                    &sub_paths.stderr,
                ),
                (
                    "interactor",
                    inter_payload_exit,
                    inter_stopped_by_peer,
                    &inter_paths.stderr,
                ),
            ] {
                if exit.is_none() && !stopped {
                    return Err(format!(
                        "interactive {name} failed before launching target executable: {}",
                        fs::read_to_string(stderr_path).unwrap_or_default().trim()
                    ));
                }
            }
        }
        let peak_memory_bytes = reported_peak_memory_bytes(
            &sub_reason,
            sub_peak_raw,
            spec.submission.limits.memory_bytes,
        );
        let inter_stderr_str = fs::read_to_string(&inter_paths.stderr).unwrap_or_default();
        let transcript = spec.interactor.args.get(1).and_then(|arg| {
            let path = inter_paths.workspace.join(arg);
            fs::read_to_string(path).ok()
        });

        let (verdict, score_multiplier, message) = match sub_reason {
            RunReason::MemoryLimit => (
                "MLE".to_string(),
                Some(0.0),
                Some("Memory limit exceeded".into()),
            ),
            RunReason::WallTimeLimit => (
                "TLE".to_string(),
                Some(0.0),
                Some("Time limit exceeded".into()),
            ),
            RunReason::OutputLimit | RunReason::WriteLimit => (
                "OLE".to_string(),
                Some(0.0),
                Some("Output limit exceeded".into()),
            ),
            RunReason::ProcessLimit | RunReason::ThreadLimit => (
                "RTE".to_string(),
                Some(0.0),
                Some("Process or thread limit exceeded".into()),
            ),
            RunReason::Cancelled => ("CANCELLED".to_string(), Some(0.0), Some("Cancelled".into())),
            _ => match inter_raw_exit {
                Some(0) => ("AC".to_string(), Some(1.0), Some(inter_stderr_str)),
                Some(1) => ("WA".to_string(), Some(0.0), Some(inter_stderr_str)),
                Some(2) => ("PE".to_string(), Some(0.0), Some(inter_stderr_str)),
                Some(7) => ("PARTIAL".to_string(), None, Some(inter_stderr_str)),
                Some(code) if (16..128).contains(&code) => {
                    let mult = ((code - 16) as f64) / 100.0;
                    (
                        "PARTIAL".to_string(),
                        Some(mult.clamp(0.0, 1.0)),
                        Some(inter_stderr_str),
                    )
                }
                Some(3) => (
                    "JE".to_string(),
                    Some(0.0),
                    Some(format!("Interactor failed: {inter_stderr_str}")),
                ),
                _ => {
                    if let Some(code) = sub_raw_exit {
                        if code != 0 {
                            (
                                "RTE".to_string(),
                                Some(0.0),
                                Some(format!("Runtime error (exit code {code})")),
                            )
                        } else {
                            (
                                "JE".to_string(),
                                Some(0.0),
                                Some(format!(
                                    "Unknown interaction outcome. Interactor exit: {inter_raw_exit:?}"
                                )),
                            )
                        }
                    } else {
                        (
                            "JE".to_string(),
                            Some(0.0),
                            Some("Process execution error".into()),
                        )
                    }
                }
            },
        };

        let (sub_exit_code, sub_signal) = classify_exit_code_and_signal(sub_raw_exit, &sub_reason);
        let (inter_exit_code, inter_signal) =
            classify_exit_code_and_signal(inter_raw_exit, &RunReason::Exited);
        let result_collection_time_us = elapsed_us(collection_started);

        let sub_result = RunResult {
            run_id: spec.submission.run_id.clone(),
            reason: sub_reason,
            exit_code: sub_exit_code,
            signal_or_status: sub_signal,
            security_setup_time_us,
            wall_time_us,
            result_collection_time_us,
            user_cpu_time_us: sub_user_cpu,
            kernel_cpu_time_us: sub_kernel_cpu,
            peak_memory_bytes,
            stdout_bytes: file_size(&sub_paths.stdout),
            stderr_bytes: file_size(&sub_paths.stderr),
            created_files: None,
            diagnostic: message.clone(),
        };

        let inter_result = RunResult {
            run_id: spec.interactor.run_id.clone(),
            reason: RunReason::Exited,
            exit_code: inter_exit_code,
            signal_or_status: inter_signal,
            security_setup_time_us: 0,
            wall_time_us,
            result_collection_time_us,
            user_cpu_time_us: None,
            kernel_cpu_time_us: None,
            peak_memory_bytes: None,
            stdout_bytes: file_size(&inter_paths.stdout),
            stderr_bytes: file_size(&inter_paths.stderr),
            created_files: None,
            diagnostic: None,
        };

        Ok(InteractiveRunResult {
            run_id: spec.run_id.clone(),
            verdict,
            score_multiplier,
            execution_time_ms,
            peak_memory_bytes,
            message,
            transcript,
            submission_result: sub_result,
            interactor_result: inter_result,
        })
    }
}

fn ensure_delegated_cgroup_root() -> Result<PathBuf, String> {
    if let Ok(current_cg) = read_self_cgroup_path() {
        if current_cg
            .file_name()
            .is_some_and(|name| name == "supervisor")
        {
            if let Some(parent) = current_cg.parent() {
                if has_required_controllers(parent) {
                    return Ok(parent.to_path_buf());
                }
            }
        }
    }

    let pid = std::process::id();
    let uid = unsafe { libc::geteuid() };
    let nonce = NEXT_JOB_COUNTER.fetch_add(1, Ordering::Relaxed);
    let unit_name = format!("judgedesk-executor-{pid}-{nonce}.scope");

    if Path::new(BUSCTL_PATH).is_file() {
        let mut busctl = Command::new(BUSCTL_PATH);
        let runtime_dir = format!("/run/user/{uid}");
        if std::env::var_os("XDG_RUNTIME_DIR").is_none() && Path::new(&runtime_dir).is_dir() {
            busctl.env("XDG_RUNTIME_DIR", &runtime_dir);
        }
        let bus_path = format!("{runtime_dir}/bus");
        if std::env::var_os("DBUS_SESSION_BUS_ADDRESS").is_none() && Path::new(&bus_path).exists() {
            busctl.env("DBUS_SESSION_BUS_ADDRESS", format!("unix:path={bus_path}"));
        }
        let pid_str = pid.to_string();
        let output = busctl
            .args([
                "--user",
                "call",
                "org.freedesktop.systemd1",
                "/org/freedesktop/systemd1",
                "org.freedesktop.systemd1.Manager",
                "StartTransientUnit",
                "ssa(sv)a(sa(sv))",
                &unit_name,
                "fail",
                "3",
                "Description",
                "s",
                "JudgeDesk Executor Delegated Cgroup Scope",
                "Delegate",
                "b",
                "1",
                "PIDs",
                "au",
                "1",
                &pid_str,
                "0",
            ])
            .output();

        if let Ok(output) = output {
            if output.status.success() {
                let wait_deadline = Instant::now() + Duration::from_millis(1_000);
                while Instant::now() < wait_deadline {
                    if let Ok(cg) = read_self_cgroup_path() {
                        if cg.to_string_lossy().contains(&unit_name) {
                            break;
                        }
                    }
                    std::thread::sleep(Duration::from_millis(5));
                }
            }
        }
    }

    let base_cg = read_self_cgroup_path()?;
    let supervisor_cg = base_cg.join("supervisor");
    if !supervisor_cg.exists() {
        fs::create_dir(&supervisor_cg).map_err(|error| {
            format!(
                "SECURE_RUNNER_UNAVAILABLE: cannot create delegated supervisor cgroup at {}: {error}",
                supervisor_cg.display()
            )
        })?;
    }
    fs::write(supervisor_cg.join("cgroup.procs"), pid.to_string()).map_err(|error| {
        format!(
            "SECURE_RUNNER_UNAVAILABLE: cannot move executor into supervisor cgroup {}: {error}",
            supervisor_cg.display()
        )
    })?;
    fs::write(base_cg.join("cgroup.subtree_control"), "+cpu +memory +pids").map_err(|error| {
        format!(
            "SECURE_RUNNER_UNAVAILABLE: cannot enable +cpu +memory +pids in {}: {error}",
            base_cg.display()
        )
    })?;
    if !has_required_controllers(&base_cg) {
        return Err(format!(
            "SECURE_RUNNER_UNAVAILABLE: cgroup {} is missing required controllers (cpu, memory, pids)",
            base_cg.display()
        ));
    }
    Ok(base_cg)
}

fn read_self_cgroup_path() -> Result<PathBuf, String> {
    let contents = fs::read_to_string("/proc/self/cgroup")
        .map_err(|error| format!("read /proc/self/cgroup: {error}"))?;
    for line in contents.lines() {
        if let Some(rel) = line.strip_prefix("0::") {
            let trimmed = rel.trim().trim_start_matches('/');
            return Ok(Path::new(CGROUP_ROOT).join(trimmed));
        }
    }
    Err("unified cgroup v2 entry (0::) not found in /proc/self/cgroup".into())
}

fn has_required_controllers(cgroup: &Path) -> bool {
    let Ok(controllers) = fs::read_to_string(cgroup.join("cgroup.subtree_control")) else {
        return false;
    };
    let present: std::collections::HashSet<&str> = controllers.split_whitespace().collect();
    present.contains("cpu") && present.contains("memory") && present.contains("pids")
}

fn build_bwrap_command(
    root: &Path,
    spec: &RunSpec,
    paths: &ValidatedRun,
    status_fd: i32,
    seccomp_fd: i32,
) -> Result<Command, String> {
    use crate::protocol::linux_sandbox_paths::{COMPILER_WORKSPACE, TOOLCHAIN_ROOT};
    let managed_compiler = matches!(spec.role, RunRole::Compiler) && spec.toolchain.is_some();
    let mut cmd = Command::new(BWRAP_PATH);
    cmd.args([
        "--unshare-all",
        "--die-with-parent",
        "--new-session",
        "--cap-drop",
        "ALL",
        "--hostname",
        "judgedesk",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--tmpfs",
        "/tmp",
        "--size",
        &spec.limits.total_write_bytes.max(65_536).to_string(),
        "--tmpfs",
        SANDBOX_TMPDIR,
    ]);

    if matches!(spec.role, RunRole::Compiler) {
        cmd.args(["--ro-bind", "/usr", "/usr"]);
        for dir in [
            "/bin",
            "/lib",
            "/lib64",
            "/etc/alternatives",
            "/etc/ld.so.cache",
            "/etc/fpc.cfg",
        ] {
            if Path::new(dir).exists() {
                cmd.args(["--ro-bind-try", dir, dir]);
            }
        }
    } else {
        for dir in [
            "/usr/lib",
            "/usr/lib64",
            "/usr/share",
            "/lib",
            "/lib64",
            "/etc/ld.so.cache",
            "/etc/alternatives",
        ] {
            if Path::new(dir).exists() {
                cmd.args(["--ro-bind-try", dir, dir]);
            }
        }
        if !paths.executable.starts_with(&paths.workspace)
            && !paths.executable.starts_with(root.join("artifacts"))
            && !paths.executable.starts_with("/usr/lib")
            && !paths.executable.starts_with("/usr/lib64")
        {
            let exe_str = paths.executable.to_string_lossy().into_owned();
            cmd.args(["--ro-bind", &exe_str, &exe_str]);
        }
    }

    // A validated explicit installation must also be visible to compiler runs.
    // Bind only its granted root, never the containing home or /opt directory.
    if let Some(pkg_root) = &paths.toolchain_package_root {
        if managed_compiler {
            cmd.args(["--ro-bind", &pkg_root.to_string_lossy(), TOOLCHAIN_ROOT]);
        }
        if pkg_root != Path::new("/")
            && pkg_root != Path::new("/usr")
            && pkg_root != Path::new("/bin")
            && pkg_root != Path::new("/usr/bin")
            && !pkg_root.starts_with("/usr/lib")
            && !pkg_root.starts_with("/usr/lib64")
        {
            let pkg_str = pkg_root.to_string_lossy().into_owned();
            cmd.args(["--ro-bind", &pkg_str, &pkg_str]);
        }
    }

    if let Ok(etc_entries) = fs::read_dir("/etc") {
        for entry in etc_entries.flatten() {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if name_str.starts_with("java-") || name_str.starts_with("fpc") {
                let path_str = entry.path().to_string_lossy().into_owned();
                cmd.args(["--ro-bind-try", &path_str, &path_str]);
            }
        }
    }

    let artifacts_dir = root.join("artifacts");
    if paths.executable.starts_with(&artifacts_dir) && artifacts_dir.is_dir() {
        let artifacts_str = artifacts_dir.to_string_lossy().into_owned();
        cmd.args(["--ro-bind", &artifacts_str, &artifacts_str]);
    }

    let workspace_str = paths.workspace.to_string_lossy().into_owned();
    cmd.args(["--bind", &workspace_str, &workspace_str]);
    if managed_compiler {
        cmd.args(["--bind", &workspace_str, COMPILER_WORKSPACE]);
    }

    // Synthetic parents are never submission storage. Protect them regardless
    // of the host cache location; the workspace and bounded temp child mounts
    // remain writable. In particular, a home-based cache must not leave a
    // writable synthetic home or an unbounded /tmp inside the namespace.
    cmd.args(["--remount-ro", "/tmp", "--remount-ro", "/"]);

    let working_directory = if managed_compiler {
        COMPILER_WORKSPACE
    } else {
        &workspace_str
    };
    cmd.args(["--chdir", working_directory, "--clearenv"]);

    let mut env = spec.environment.clone();
    env.insert("HOME".into(), working_directory.into());
    env.insert("TMPDIR".into(), SANDBOX_TMPDIR.into());
    env.insert("TEMP".into(), SANDBOX_TMPDIR.into());
    env.insert("TMP".into(), SANDBOX_TMPDIR.into());
    // Clearing the host environment must not turn UTF-8 installation paths
    // into '?' in runtimes such as Java. C.UTF-8 keeps deterministic messages
    // and numeric formatting; explicitly supplied locale settings still win.
    env.entry("LANG".into()).or_insert_with(|| "C.UTF-8".into());
    env.entry("PATH".into())
        .or_insert_with(|| "/usr/bin:/bin".into());
    for (key, value) in &env {
        cmd.args(["--setenv", key, value]);
    }

    cmd.args([
        "--json-status-fd",
        &status_fd.to_string(),
        "--seccomp",
        &seccomp_fd.to_string(),
        "--",
    ]);
    if managed_compiler {
        let package = paths
            .toolchain_package_root
            .as_ref()
            .ok_or("Managed compiler is missing its granted package")?;
        let relative = paths
            .executable
            .strip_prefix(package)
            .map_err(|_| "Managed compiler executable escapes its package")?;
        cmd.arg(Path::new(TOOLCHAIN_ROOT).join(relative));
    } else {
        cmd.arg(&paths.executable);
    }
    cmd.args(&spec.args);
    Ok(cmd)
}

fn build_resource_only_command(spec: &RunSpec, paths: &ValidatedRun) -> Command {
    let mut cmd = Command::new(&paths.executable);
    cmd.args(&spec.args)
        .current_dir(&paths.workspace)
        .env_clear();
    let workspace_str = paths.workspace.to_string_lossy().into_owned();
    let mut env = spec.environment.clone();
    env.insert("HOME".into(), workspace_str.clone());
    env.insert("TMPDIR".into(), workspace_str);
    env.entry("PATH".into())
        .or_insert_with(|| "/usr/bin:/bin".into());
    cmd.envs(env);
    cmd
}

#[repr(C)]
#[derive(Clone, Copy)]
struct SockFilter {
    code: u16,
    jt: u8,
    jf: u8,
    k: u32,
}

fn build_seccomp_bpf_bytes(single_process_limit: bool) -> Vec<u8> {
    const BPF_LD_W_ABS: u16 = 0x20;
    const BPF_JMP_JEQ_K: u16 = 0x15;
    const BPF_JMP_JSET_K: u16 = 0x45;
    const BPF_RET_K: u16 = 0x06;

    const SECCOMP_RET_KILL_PROCESS: u32 = 0x8000_0000;
    const SECCOMP_RET_ERRNO: u32 = 0x0005_0000;
    const SECCOMP_RET_ALLOW: u32 = 0x7fff_0000;

    let ret_eperm = SECCOMP_RET_ERRNO | (libc::EPERM as u32);
    let ret_enosys = SECCOMP_RET_ERRNO | (libc::ENOSYS as u32);

    #[cfg(target_arch = "x86_64")]
    const EXPECTED_ARCH: u32 = 0xc000_003e;
    #[cfg(target_arch = "aarch64")]
    const EXPECTED_ARCH: u32 = 0xc000_00b7;

    const CLONE_THREAD: u32 = 0x0001_0000;
    const FORBIDDEN_CLONE_NAMESPACE_FLAGS: u32 = 0x7e02_0000;

    let mut filters = vec![
        // Verify seccomp_data.arch (offset 4)
        SockFilter {
            code: BPF_LD_W_ABS,
            jt: 0,
            jf: 0,
            k: 4,
        },
        SockFilter {
            code: BPF_JMP_JEQ_K,
            jt: 1,
            jf: 0,
            k: EXPECTED_ARCH,
        },
        SockFilter {
            code: BPF_RET_K,
            jt: 0,
            jf: 0,
            k: SECCOMP_RET_KILL_PROCESS,
        },
        // Load seccomp_data.nr (offset 0)
        SockFilter {
            code: BPF_LD_W_ABS,
            jt: 0,
            jf: 0,
            k: 0,
        },
        // Force clone3 -> ENOSYS so glibc falls back to clone where flags are inspectable
        SockFilter {
            code: BPF_JMP_JEQ_K,
            jt: 0,
            jf: 1,
            k: libc::SYS_clone3 as u32,
        },
        SockFilter {
            code: BPF_RET_K,
            jt: 0,
            jf: 0,
            k: ret_enosys,
        },
    ];

    let deny_eperm_syscalls: &[i64] = &[
        libc::SYS_socket,
        libc::SYS_connect,
        libc::SYS_bind,
        libc::SYS_listen,
        libc::SYS_accept,
        libc::SYS_accept4,
        libc::SYS_sendto,
        libc::SYS_recvfrom,
        libc::SYS_sendmsg,
        libc::SYS_recvmsg,
        libc::SYS_sendmmsg,
        libc::SYS_recvmmsg,
        libc::SYS_setsockopt,
        libc::SYS_getsockopt,
        libc::SYS_shutdown,
        libc::SYS_mount,
        libc::SYS_umount2,
        libc::SYS_pivot_root,
        libc::SYS_chroot,
        libc::SYS_unshare,
        libc::SYS_setns,
        libc::SYS_ptrace,
        libc::SYS_process_vm_readv,
        libc::SYS_process_vm_writev,
        libc::SYS_kcmp,
        libc::SYS_bpf,
        libc::SYS_perf_event_open,
        libc::SYS_userfaultfd,
        libc::SYS_io_uring_setup,
        libc::SYS_io_uring_enter,
        libc::SYS_io_uring_register,
        libc::SYS_open_by_handle_at,
        libc::SYS_name_to_handle_at,
        libc::SYS_keyctl,
        libc::SYS_add_key,
        libc::SYS_request_key,
        libc::SYS_kexec_load,
        libc::SYS_reboot,
        libc::SYS_swapon,
        libc::SYS_swapoff,
        libc::SYS_init_module,
        libc::SYS_finit_module,
        libc::SYS_delete_module,
        libc::SYS_acct,
        libc::SYS_quotactl,
        libc::SYS_settimeofday,
        libc::SYS_clock_settime,
        libc::SYS_adjtimex,
        libc::SYS_clock_adjtime,
        libc::SYS_sethostname,
        libc::SYS_setdomainname,
        libc::SYS_syslog,
        libc::SYS_vhangup,
    ];

    for &nr in deny_eperm_syscalls {
        filters.push(SockFilter {
            code: BPF_JMP_JEQ_K,
            jt: 0,
            jf: 1,
            k: nr as u32,
        });
        filters.push(SockFilter {
            code: BPF_RET_K,
            jt: 0,
            jf: 0,
            k: ret_eperm,
        });
    }

    // socketpair: allow AF_UNIX (1) only
    filters.extend([
        SockFilter {
            code: BPF_JMP_JEQ_K,
            jt: 0,
            jf: 3,
            k: libc::SYS_socketpair as u32,
        },
        SockFilter {
            code: BPF_LD_W_ABS,
            jt: 0,
            jf: 0,
            k: 16,
        },
        SockFilter {
            code: BPF_JMP_JEQ_K,
            jt: 1,
            jf: 0,
            k: libc::AF_UNIX as u32,
        },
        SockFilter {
            code: BPF_RET_K,
            jt: 0,
            jf: 0,
            k: ret_eperm,
        },
        SockFilter {
            code: BPF_LD_W_ABS,
            jt: 0,
            jf: 0,
            k: 0,
        },
    ]);

    if single_process_limit {
        #[cfg(target_arch = "x86_64")]
        for nr in [libc::SYS_fork, libc::SYS_vfork] {
            filters.push(SockFilter {
                code: BPF_JMP_JEQ_K,
                jt: 0,
                jf: 1,
                k: nr as u32,
            });
            filters.push(SockFilter {
                code: BPF_RET_K,
                jt: 0,
                jf: 0,
                k: SECCOMP_RET_KILL_PROCESS,
            });
        }
        filters.extend([
            SockFilter {
                code: BPF_JMP_JEQ_K,
                jt: 0,
                jf: 5,
                k: libc::SYS_clone as u32,
            },
            SockFilter {
                code: BPF_LD_W_ABS,
                jt: 0,
                jf: 0,
                k: 16,
            },
            SockFilter {
                code: BPF_JMP_JSET_K,
                jt: 1,
                jf: 0,
                k: CLONE_THREAD,
            },
            SockFilter {
                code: BPF_RET_K,
                jt: 0,
                jf: 0,
                k: SECCOMP_RET_KILL_PROCESS,
            },
            SockFilter {
                code: BPF_JMP_JSET_K,
                jt: 0,
                jf: 1,
                k: FORBIDDEN_CLONE_NAMESPACE_FLAGS,
            },
            SockFilter {
                code: BPF_RET_K,
                jt: 0,
                jf: 0,
                k: ret_eperm,
            },
            SockFilter {
                code: BPF_RET_K,
                jt: 0,
                jf: 0,
                k: SECCOMP_RET_ALLOW,
            },
        ]);
    } else {
        filters.extend([
            SockFilter {
                code: BPF_JMP_JEQ_K,
                jt: 0,
                jf: 3,
                k: libc::SYS_clone as u32,
            },
            SockFilter {
                code: BPF_LD_W_ABS,
                jt: 0,
                jf: 0,
                k: 16,
            },
            SockFilter {
                code: BPF_JMP_JSET_K,
                jt: 0,
                jf: 1,
                k: FORBIDDEN_CLONE_NAMESPACE_FLAGS,
            },
            SockFilter {
                code: BPF_RET_K,
                jt: 0,
                jf: 0,
                k: ret_eperm,
            },
            SockFilter {
                code: BPF_RET_K,
                jt: 0,
                jf: 0,
                k: SECCOMP_RET_ALLOW,
            },
        ]);
    }

    filters.push(SockFilter {
        code: BPF_RET_K,
        jt: 0,
        jf: 0,
        k: SECCOMP_RET_ALLOW,
    });

    let mut bytes = Vec::with_capacity(filters.len() * 8);
    for insn in filters {
        bytes.extend_from_slice(&insn.code.to_le_bytes());
        bytes.push(insn.jt);
        bytes.push(insn.jf);
        bytes.extend_from_slice(&insn.k.to_le_bytes());
    }
    bytes
}

fn create_seccomp_memfd(single_process_limit: bool) -> Result<OwnedFd, String> {
    let name = CString::new("judgedesk-seccomp").map_err(|error| error.to_string())?;
    let raw_fd = unsafe { libc::memfd_create(name.as_ptr(), 0) };
    if raw_fd < 0 {
        return Err(format!("memfd_create: {}", io::Error::last_os_error()));
    }
    let fd = unsafe { OwnedFd::from_raw_fd(raw_fd) };
    let bpf_bytes = build_seccomp_bpf_bytes(single_process_limit);
    let mut file = File::from(fd);
    file.write_all(&bpf_bytes)
        .map_err(|error| format!("write seccomp memfd: {error}"))?;
    use std::io::{Seek, SeekFrom};
    file.seek(SeekFrom::Start(0))
        .map_err(|error| format!("seek seccomp memfd: {error}"))?;
    Ok(OwnedFd::from(file))
}

fn create_status_pipe() -> Result<(OwnedFd, OwnedFd), String> {
    let mut fds = [0_i32; 2];
    if unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) } != 0 {
        return Err(format!("pipe2: {}", io::Error::last_os_error()));
    }
    let read_fd = unsafe { OwnedFd::from_raw_fd(fds[0]) };
    let write_fd = unsafe { OwnedFd::from_raw_fd(fds[1]) };
    // Clear FD_CLOEXEC on write_fd so bwrap inherits it across exec.
    let flags = unsafe { libc::fcntl(write_fd.as_raw_fd(), libc::F_GETFD) };
    if flags < 0
        || unsafe {
            libc::fcntl(
                write_fd.as_raw_fd(),
                libc::F_SETFD,
                flags & !libc::FD_CLOEXEC,
            )
        } < 0
    {
        return Err(format!(
            "fcntl clear FD_CLOEXEC: {}",
            io::Error::last_os_error()
        ));
    }
    Ok((read_fd, write_fd))
}

fn create_io_pipe() -> Result<(OwnedFd, OwnedFd), String> {
    let mut fds = [0_i32; 2];
    if unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) } != 0 {
        return Err(format!("pipe2: {}", io::Error::last_os_error()));
    }
    Ok(unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) })
}

struct BwrapStatus {
    child_started: bool,
    exit_code: Option<i32>,
}

impl BwrapStatus {
    fn payload_exit_code(&self) -> Option<i32> {
        self.exit_code.filter(|_| self.child_started)
    }
}

fn read_bwrap_status(fd: OwnedFd) -> Option<BwrapStatus> {
    let mut file = File::from(fd);
    let mut contents = String::new();
    let _ = std::io::Read::by_ref(&mut file)
        .take(16 * 1024)
        .read_to_string(&mut contents);
    if contents.trim().is_empty() {
        return None;
    }
    let mut child_started = false;
    let mut exit_code = None;
    for line in contents.lines() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if value
            .get("child-pid")
            .and_then(serde_json::Value::as_u64)
            .is_some_and(|pid| pid > 0 && pid <= i32::MAX as u64)
        {
            child_started = true;
        }
        if let Some(code) = value
            .get("exit-code")
            .and_then(serde_json::Value::as_i64)
            .filter(|code| (0..=255).contains(code))
        {
            exit_code = Some(code as i32);
        }
    }
    Some(BwrapStatus {
        child_started,
        exit_code,
    })
}

fn open_output_file(path: &Path) -> Result<File, String> {
    OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|error| format!("open output {}: {error}", path.display()))
}

fn kill_cgroup_tree(cgroup: &Path) {
    if fs::write(cgroup.join("cgroup.kill"), "1").is_ok() {
        return;
    }
    if let Ok(procs) = fs::read_to_string(cgroup.join("cgroup.procs")) {
        for line in procs.lines() {
            if let Ok(pid) = line.trim().parse::<i32>() {
                if pid > 1 {
                    unsafe {
                        libc::kill(pid, libc::SIGKILL);
                    }
                }
            }
        }
    }
}

fn cgroup_line_count(path: &Path) -> u32 {
    fs::read_to_string(path)
        .map(|contents| {
            contents
                .lines()
                .filter(|line| !line.trim().is_empty())
                .count() as u32
        })
        .unwrap_or(0)
}

fn live_user_processes(cgroup: &Path, strict_isolation: bool) -> u32 {
    let total = cgroup_line_count(&cgroup.join("cgroup.procs"));
    if strict_isolation {
        total.saturating_sub(BWRAP_TASK_OVERHEAD as u32)
    } else {
        total
    }
}

fn live_user_threads(cgroup: &Path, strict_isolation: bool) -> u32 {
    let total = cgroup_line_count(&cgroup.join("cgroup.threads"));
    if strict_isolation {
        total.saturating_sub(BWRAP_TASK_OVERHEAD as u32)
    } else {
        total
    }
}

fn cgroup_has_oom(cgroup: &Path) -> bool {
    let Ok(events) = fs::read_to_string(cgroup.join("memory.events")) else {
        return false;
    };
    for line in events.lines() {
        let mut parts = line.split_whitespace();
        let Some(key) = parts.next() else {
            continue;
        };
        let Some(val) = parts.next().and_then(|v| v.parse::<u64>().ok()) else {
            continue;
        };
        if (key == "oom_kill" || key == "oom") && val > 0 {
            return true;
        }
    }
    false
}

fn cgroup_pids_max_reached(cgroup: &Path) -> bool {
    let Ok(events) = fs::read_to_string(cgroup.join("pids.events")) else {
        return false;
    };
    for line in events.lines() {
        let mut parts = line.split_whitespace();
        if parts.next() == Some("max")
            && parts
                .next()
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(0)
                > 0
        {
            return true;
        }
    }
    false
}

fn read_u64_file(path: &Path) -> Option<u64> {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok())
}

fn read_cgroup_cpu_times(cgroup: &Path) -> (Option<u64>, Option<u64>) {
    let Ok(stat) = fs::read_to_string(cgroup.join("cpu.stat")) else {
        return (None, None);
    };
    let mut user_usec = None;
    let mut system_usec = None;
    for line in stat.lines() {
        let mut parts = line.split_whitespace();
        let Some(key) = parts.next() else {
            continue;
        };
        let Some(val) = parts.next().and_then(|v| v.parse::<u64>().ok()) else {
            continue;
        };
        match key {
            "user_usec" => user_usec = Some(val),
            "system_usec" => system_usec = Some(val),
            _ => {}
        }
    }
    (user_usec, system_usec)
}

fn classify_exit_code_and_signal(
    raw_exit_code: Option<i32>,
    reason: &RunReason,
) -> (Option<i32>, Option<String>) {
    if !matches!(reason, RunReason::Exited) {
        let sig_str = raw_exit_code
            .filter(|code| *code > 128)
            .map(|code| signal_name(code - 128));
        return (raw_exit_code, sig_str);
    }
    match raw_exit_code {
        Some(code) if code > 128 && code <= 192 => {
            let sig = code - 128;
            (Some(code), Some(signal_name(sig)))
        }
        Some(code) if code != 0 => (Some(code), Some(format!("EXIT_{code}"))),
        Some(0) => (Some(0), None),
        other => (other, None),
    }
}

fn signal_name(sig: i32) -> String {
    match sig {
        libc::SIGHUP => "SIGHUP".into(),
        libc::SIGINT => "SIGINT".into(),
        libc::SIGQUIT => "SIGQUIT".into(),
        libc::SIGILL => "SIGILL".into(),
        libc::SIGTRAP => "SIGTRAP".into(),
        libc::SIGABRT => "SIGABRT".into(),
        libc::SIGBUS => "SIGBUS".into(),
        libc::SIGFPE => "SIGFPE".into(),
        libc::SIGKILL => "SIGKILL".into(),
        libc::SIGSEGV => "SIGSEGV".into(),
        libc::SIGPIPE => "SIGPIPE".into(),
        libc::SIGALRM => "SIGALRM".into(),
        libc::SIGTERM => "SIGTERM".into(),
        libc::SIGXCPU => "SIGXCPU".into(),
        libc::SIGXFSZ => "SIGXFSZ".into(),
        libc::SIGSYS => "SIGSYS".into(),
        other => format!("SIG{other}"),
    }
}

fn elapsed_us(started: Instant) -> u64 {
    started.elapsed().as_micros().min(u64::MAX as u128) as u64
}

fn locate_security_probe_executable() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("JUDGEDESK_EXECUTOR_PATH")
        .map(PathBuf::from)
        .filter(|path| path.is_file())
    {
        return Ok(path);
    }
    let current = std::env::current_exe()
        .map_err(|error| format!("cannot locate security probe executable: {error}"))?;
    if current
        .parent()
        .and_then(|parent| parent.file_name())
        .is_some_and(|name| name == "deps")
    {
        if let Some(bin_candidate) = current
            .parent()
            .and_then(|deps| deps.parent())
            .map(|target_dir| target_dir.join("judgedesk-native-executor"))
            .filter(|candidate| candidate.is_file())
        {
            return Ok(bin_candidate);
        }
    }
    Ok(current)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{LocalToolchainGrant, ToolchainGrantRole};
    use std::collections::HashMap;
    use std::sync::Mutex;

    #[test]
    fn managed_compilers_use_short_views_of_only_the_granted_directories() {
        use crate::protocol::{
            linux_sandbox_paths::{COMPILER_WORKSPACE, TOOLCHAIN_ROOT},
            ToolchainGrant, ToolchainGrantRole,
        };
        let root = PathBuf::from("/home/qa/long data root/executor");
        let workspace = root.join("workspaces/job");
        let package = root.join("toolchains/fpc-release-digest");
        let spec = RunSpec {
            run_id: "job".into(),
            role: RunRole::Compiler,
            workspace_id: "job".into(),
            executable_id: "toolchains/fpc-release-digest/bin/ppcx64".into(),
            args: vec![],
            stdin_file: None,
            stdout_file: "stdout".into(),
            stderr_file: "stderr".into(),
            environment: BTreeMap::new(),
            toolchain: Some(ToolchainGrant {
                package_id: "fpc-linux-x64".into(),
                package_digest: "a".repeat(64),
                component_id: "fpc.compiler".into(),
                role: ToolchainGrantRole::Compiler,
            }),
            local_toolchain: None,
            limits: default_limits(),
        };
        let paths = ValidatedRun {
            executable: package.join("bin/ppcx64"),
            toolchain_package_root: Some(package.clone()),
            isolation: LocalToolchainIsolation::Strict,
            workspace: workspace.clone(),
            stdin: None,
            stdout: workspace.join("stdout"),
            stderr: workspace.join("stderr"),
        };
        let command = build_bwrap_command(&root, &spec, &paths, 9, 10).unwrap();
        let args: Vec<_> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert!(args
            .windows(3)
            .any(|part| part == ["--ro-bind", package.to_str().unwrap(), TOOLCHAIN_ROOT]));
        assert!(args
            .windows(3)
            .any(|part| part == ["--bind", workspace.to_str().unwrap(), COMPILER_WORKSPACE]));
        assert!(args
            .windows(2)
            .any(|part| part == ["--chdir", COMPILER_WORKSPACE]));
        assert!(args
            .windows(3)
            .any(|part| part == ["--setenv", "LANG", "C.UTF-8"]));
        assert_eq!(
            args.last().unwrap(),
            &format!("{TOOLCHAIN_ROOT}/bin/ppcx64")
        );
        let mut explicit = spec.clone();
        explicit.environment.insert("LANG".into(), "C".into());
        let command = build_bwrap_command(&root, &explicit, &paths, 9, 10).unwrap();
        let args: Vec<_> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert!(args
            .windows(3)
            .any(|part| part == ["--setenv", "LANG", "C"]));
    }

    #[test]
    fn sandbox_keeps_synthetic_parents_readonly_for_roots_outside_tmp() {
        let root = PathBuf::from("/home/qa/Full package/executor");
        let workspace = root.join("workspaces/job");
        let spec = RunSpec {
            run_id: "job".into(),
            role: RunRole::Submission,
            workspace_id: "job".into(),
            executable_id: "workspaces/job/program".into(),
            args: vec![],
            stdin_file: None,
            stdout_file: "stdout".into(),
            stderr_file: "stderr".into(),
            environment: BTreeMap::new(),
            toolchain: None,
            local_toolchain: None,
            limits: default_limits(),
        };
        let paths = ValidatedRun {
            executable: workspace.join("program"),
            toolchain_package_root: None,
            isolation: LocalToolchainIsolation::Strict,
            workspace: workspace.clone(),
            stdin: None,
            stdout: workspace.join("stdout"),
            stderr: workspace.join("stderr"),
        };
        let command = build_bwrap_command(&root, &spec, &paths, 9, 10).unwrap();
        let args: Vec<_> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        for mount in ["/", "/tmp"] {
            assert!(
                args.windows(2).any(|pair| pair == ["--remount-ro", mount]),
                "missing readonly mount {mount}: {args:?}"
            );
        }
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--tmpfs", SANDBOX_TMPDIR]));
        assert!(args.windows(3).any(|part| part
            == [
                "--bind",
                workspace.to_str().unwrap(),
                workspace.to_str().unwrap()
            ]));
    }

    fn default_limits() -> RunLimits {
        RunLimits {
            wall_time_ms: 5_000,
            memory_bytes: 128 * 1024 * 1024,
            process_count: 1,
            thread_count: 16,
            output_bytes: 1024 * 1024,
            total_write_bytes: 16 * 1024 * 1024,
            open_files: 64,
            created_files: 32,
        }
    }

    #[test]
    fn bwrap_status_requires_a_valid_completed_payload() {
        use std::io::Write;
        for (status, expected) in [
            ("{\"child-pid\":123}\n{\"exit-code\":1}\n", Some(1)),
            ("{\"child-pid\":123}\n", None),
            ("{\"child-pid\":null}\n{\"exit-code\":1}\n", None),
            ("{\"child-pid\":123}\n{\"exit-code\":-1}\n", None),
            ("{\"child-pid\":123}\n{\"exit-code\":65536}\n", None),
            ("not-json\n", None),
        ] {
            let (read, write) = create_status_pipe().expect("status pipe");
            let mut writer = File::from(write);
            writer.write_all(status.as_bytes()).expect("status fixture");
            drop(writer);
            let actual = read_bwrap_status(read).and_then(|status| status.payload_exit_code());
            assert_eq!(actual, expected, "{status}");
        }
    }

    #[test]
    fn linux_failed_exec_is_not_checker_wa() {
        use std::os::unix::fs::PermissionsExt;

        let (platform, root) = LinuxPlatform::initialize().expect("initialize LinuxPlatform");
        let workspace = root.join("workspaces/launch_regression");
        fs::create_dir_all(&workspace).expect("create workspace");
        let missing_interpreter = workspace.join("checker");
        fs::write(&missing_interpreter, b"#!/judgedesk-missing-interpreter\n")
            .expect("write invalid interpreter fixture");
        fs::set_permissions(&missing_interpreter, fs::Permissions::from_mode(0o755))
            .expect("make fixture executable");
        let active: ActiveRuns = Arc::new(Mutex::new(HashMap::new()));
        for role in [RunRole::Checker, RunRole::Submission] {
            let spec = RunSpec {
                run_id: format!("launch_regression_{role:?}"),
                role,
                workspace_id: "launch_regression".into(),
                executable_id: "workspaces/launch_regression/checker".into(),
                args: Vec::new(),
                stdin_file: None,
                stdout_file: "stdout.txt".into(),
                stderr_file: "stderr.txt".into(),
                environment: BTreeMap::new(),
                toolchain: None,
                local_toolchain: None,
                limits: default_limits(),
            };
            let validated = validate_run(&root, &spec).expect("validate fixture");
            let result = platform.run(&root, &spec, &validated, &active);
            assert!(
                matches!(result.reason, RunReason::LaunchError),
                "{result:?}"
            );
            assert!(active.lock().expect("active runs").is_empty());
        }
        fs::copy("/usr/bin/false", workspace.join("valid_checker")).expect("stage real exit 1");
        for (name, interactor, expected) in [
            ("failed_interactor", "checker", "JE"),
            ("valid_wa", "valid_checker", "WA"),
        ] {
            let sub_ws = root.join("workspaces/launch_sub");
            fs::create_dir_all(&sub_ws).expect("submission workspace");
            fs::copy("/usr/bin/true", sub_ws.join("submission")).expect("stage submission");
            let participant = |id: &str, ws: &str, executable: &str, role| RunSpec {
                run_id: id.into(),
                role,
                workspace_id: ws.into(),
                executable_id: format!("workspaces/{ws}/{executable}"),
                args: Vec::new(),
                stdin_file: None,
                stdout_file: "stdout.txt".into(),
                stderr_file: "stderr.txt".into(),
                environment: BTreeMap::new(),
                toolchain: None,
                local_toolchain: None,
                limits: default_limits(),
            };
            let pair = InteractiveRunSpec {
                run_id: name.into(),
                submission: participant(
                    "launch_sub",
                    "launch_sub",
                    "submission",
                    RunRole::Submission,
                ),
                interactor: participant(
                    "launch_inter",
                    "launch_regression",
                    interactor,
                    RunRole::Checker,
                ),
            };
            let result = platform.run_interactive(&root, &pair, &active);
            assert_eq!(result.verdict, expected, "{result:?}");
            assert!(active.lock().expect("active runs").is_empty());
        }
    }

    #[test]
    fn linux_platform_self_test_and_full_sandbox_contract() {
        let (platform, root) = LinuxPlatform::initialize().expect("initialize LinuxPlatform");
        let health = platform.health(&root);
        assert!(
            health.ready,
            "self-test diagnostics: {:?}",
            health.diagnostics
        );
        assert_eq!(health.mode, "linux-bwrap-cgroup-seccomp");
        assert!(health.network_blocked);
        assert!(health.filesystem_isolated);
        assert!(health.process_tree_controlled);
        assert!(health.memory_limit_supported);

        let active: ActiveRuns = Arc::new(Mutex::new(HashMap::new()));

        // 1. Compile and run a C++ submission using host g++
        let ws_compile = root.join("workspaces").join("ws_cpp_compile");
        fs::create_dir_all(&ws_compile).expect("create compile workspace");
        fs::write(
            ws_compile.join("main.cpp"),
            r#"#include <bits/stdc++.h>
using namespace std;
int main() {
    int a, b;
    if (!(cin >> a >> b)) return 1;
    cout << (a + b) << "\n";
    return 0;
}
"#,
        )
        .expect("write main.cpp");

        let compile_spec = RunSpec {
            run_id: "test_cpp_compile".into(),
            role: RunRole::Compiler,
            workspace_id: "ws_cpp_compile".into(),
            executable_id: "local-toolchain/bin/g++".into(),
            args: vec![
                "-O2".into(),
                "-std=c++14".into(),
                "main.cpp".into(),
                "-o".into(),
                "main".into(),
            ],
            stdin_file: None,
            stdout_file: "compile.stdout".into(),
            stderr_file: "compile.stderr".into(),
            environment: BTreeMap::new(),
            toolchain: None,
            local_toolchain: Some(LocalToolchainGrant {
                root_path: "/usr".into(),
                executable_relative_path: "bin/g++".into(),
                isolation: LocalToolchainIsolation::Strict,
                role: ToolchainGrantRole::Compiler,
            }),
            limits: RunLimits {
                wall_time_ms: 15_000,
                memory_bytes: 512 * 1024 * 1024,
                process_count: 16,
                thread_count: 32,
                output_bytes: 1024 * 1024,
                total_write_bytes: 32 * 1024 * 1024,
                open_files: 128,
                created_files: 64,
            },
        };
        let validated_compile = validate_run(&root, &compile_spec).expect("validate compile");
        let compile_res = platform.run(&root, &compile_spec, &validated_compile, &active);
        assert!(
            matches!(compile_res.reason, RunReason::Exited),
            "compile result: {compile_res:?}, stderr: {}",
            fs::read_to_string(ws_compile.join("compile.stderr")).unwrap_or_default()
        );
        assert_eq!(compile_res.exit_code, Some(0));

        fs::write(ws_compile.join("input.txt"), "17 25\n").expect("write input");
        let run_cpp_spec = RunSpec {
            run_id: "test_cpp_run".into(),
            role: RunRole::Submission,
            workspace_id: "ws_cpp_compile".into(),
            executable_id: "workspaces/ws_cpp_compile/main".into(),
            args: Vec::new(),
            stdin_file: Some("input.txt".into()),
            stdout_file: "run.stdout".into(),
            stderr_file: "run.stderr".into(),
            environment: BTreeMap::new(),
            toolchain: None,
            local_toolchain: None,
            limits: default_limits(),
        };
        let validated_run_cpp = validate_run(&root, &run_cpp_spec).expect("validate cpp run");
        let cpp_res = platform.run(&root, &run_cpp_spec, &validated_run_cpp, &active);
        assert!(matches!(cpp_res.reason, RunReason::Exited), "{cpp_res:?}");
        assert_eq!(cpp_res.exit_code, Some(0));
        assert_eq!(
            fs::read_to_string(ws_compile.join("run.stdout")).expect("read stdout"),
            "42\n"
        );
        assert!(cpp_res.peak_memory_bytes.unwrap_or(0) > 0);

        // 2. MemoryLimit enforcement (80 MiB allocation under 64 MiB limit)
        let ws_limits = root.join("workspaces").join("ws_limits");
        fs::create_dir_all(&ws_limits).expect("create ws_limits");
        let helper_spec = |run_id: &str, args: Vec<String>, limits: RunLimits| -> RunResult {
            let spec = RunSpec {
                run_id: run_id.into(),
                role: RunRole::SecurityProbe,
                workspace_id: "ws_limits".into(),
                executable_id: "artifacts/security-probe".into(),
                args,
                stdin_file: None,
                stdout_file: format!("{run_id}.stdout"),
                stderr_file: format!("{run_id}.stderr"),
                environment: BTreeMap::new(),
                toolchain: None,
                local_toolchain: None,
                limits,
            };
            let validated = validate_run(&root, &spec).expect("validate helper spec");
            platform.run(&root, &spec, &validated, &active)
        };

        let mle_res = helper_spec(
            "test_mle",
            vec!["--test-allocate-mib".into(), "80".into(), "200".into()],
            RunLimits {
                memory_bytes: 64 * 1024 * 1024,
                ..default_limits()
            },
        );
        assert!(
            matches!(mle_res.reason, RunReason::MemoryLimit),
            "{mle_res:?}"
        );
        assert!(mle_res.peak_memory_bytes.unwrap_or(0) <= 64 * 1024 * 1024);

        // 3. WallTimeLimit enforcement
        let tle_res = helper_spec(
            "test_tle",
            vec!["--test-cpu-loop".into()],
            RunLimits {
                wall_time_ms: 100,
                ..default_limits()
            },
        );
        assert!(
            matches!(tle_res.reason, RunReason::WallTimeLimit),
            "{tle_res:?}"
        );

        // 4. ProcessLimit enforcement
        let proc_res = helper_spec(
            "test_proc_bomb",
            vec!["--test-process-bomb".into(), "32".into(), "500".into()],
            RunLimits {
                process_count: 1,
                ..default_limits()
            },
        );
        assert!(
            matches!(proc_res.reason, RunReason::ProcessLimit),
            "{proc_res:?}"
        );

        // 5. ThreadLimit enforcement
        let thread_res = helper_spec(
            "test_thread_bomb",
            vec!["--test-thread-bomb".into(), "32".into(), "1000".into()],
            RunLimits {
                thread_count: 8,
                ..default_limits()
            },
        );
        assert!(
            matches!(thread_res.reason, RunReason::ThreadLimit),
            "{thread_res:?}"
        );

        // 6. OutputLimit enforcement
        let ole_res = helper_spec(
            "test_ole",
            vec!["--test-output-bytes".into(), (256 * 1024).to_string()],
            RunLimits {
                output_bytes: 32 * 1024,
                total_write_bytes: 1024 * 1024,
                ..default_limits()
            },
        );
        assert!(
            matches!(ole_res.reason, RunReason::OutputLimit),
            "{ole_res:?}"
        );

        // 7. WriteLimit enforcement
        let wle_target = ws_limits.join("bomb.bin").to_string_lossy().into_owned();
        let wle_res = helper_spec(
            "test_wle",
            vec!["--test-write".into(), wle_target, (256 * 1024).to_string()],
            RunLimits {
                output_bytes: 16 * 1024,
                total_write_bytes: 32 * 1024,
                ..default_limits()
            },
        );
        assert!(
            matches!(wle_res.reason, RunReason::WriteLimit),
            "{wle_res:?}"
        );

        // 8. Interactive run (Submission + Interactor communicating via pipes)
        let ws_sub = root.join("workspaces").join("ws_inter_sub");
        let ws_inter = root.join("workspaces").join("ws_inter_judge");
        fs::create_dir_all(&ws_sub).expect("create ws_sub");
        fs::create_dir_all(&ws_inter).expect("create ws_inter");
        fs::copy(ws_compile.join("main"), ws_sub.join("sub")).expect("copy sub binary");
        fs::set_permissions(ws_sub.join("sub"), fs::Permissions::from_mode(0o700))
            .expect("chmod sub");

        fs::write(
            ws_inter.join("interactor.py"),
            r#"import sys
print("19 23", flush=True)
ans = sys.stdin.readline().strip()
if ans == "42":
    sys.stderr.write("Correct answer\n")
    sys.exit(0)
else:
    sys.stderr.write(f"Wrong answer: {ans}\n")
    sys.exit(1)
"#,
        )
        .expect("write interactor.py");

        let inter_spec = InteractiveRunSpec {
            run_id: "test_interactive_ac".into(),
            submission: RunSpec {
                run_id: "test_interactive_sub".into(),
                role: RunRole::Submission,
                workspace_id: "ws_inter_sub".into(),
                executable_id: "workspaces/ws_inter_sub/sub".into(),
                args: Vec::new(),
                stdin_file: None,
                stdout_file: "sub.stdout".into(),
                stderr_file: "sub.stderr".into(),
                environment: BTreeMap::new(),
                toolchain: None,
                local_toolchain: None,
                limits: default_limits(),
            },
            interactor: RunSpec {
                run_id: "test_interactive_inter".into(),
                role: RunRole::CheckerRuntime,
                workspace_id: "ws_inter_judge".into(),
                executable_id: "local-toolchain/bin/python3".into(),
                args: vec!["-I".into(), "-B".into(), "interactor.py".into()],
                stdin_file: None,
                stdout_file: "inter.stdout".into(),
                stderr_file: "inter.stderr".into(),
                environment: BTreeMap::from([("JUDGEDESK_PYTHON_ISOLATED".into(), "1".into())]),
                toolchain: None,
                local_toolchain: Some(LocalToolchainGrant {
                    root_path: "/usr".into(),
                    executable_relative_path: "bin/python3".into(),
                    isolation: LocalToolchainIsolation::Strict,
                    role: ToolchainGrantRole::CheckerRuntime,
                }),
                limits: default_limits(),
            },
        };
        let inter_res = platform.run_interactive(&root, &inter_spec, &active);
        assert_eq!(inter_res.verdict, "AC", "{inter_res:?}");
        assert_eq!(inter_res.score_multiplier, Some(1.0));
    }
}
