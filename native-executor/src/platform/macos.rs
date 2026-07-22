use super::{failure, root_display, ActiveRuns, Cancellation};
use crate::protocol::{ExecutorHealth, RunLimits, RunReason, RunResult, RunRole, RunSpec};
use crate::request_validation::{validate_run, ValidatedRun};
use crate::workspace::{file_size, initialize_root, inspect_workspace};
use std::fs::{self, File, OpenOptions};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

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
                limits: RunLimits {
                    wall_time_ms: 5_000,
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
            let run = self.run_inner(&spec, &validated, &active)?;
            let output = fs::read_to_string(workspace.join("probe.stdout"))
                .map_err(|error| format!("cannot read security probe: {error}"))?;
            let probe: serde_json::Value = serde_json::from_str(output.trim()).map_err(|error| {
                let stderr = fs::read_to_string(workspace.join("probe.stderr"))
                    .unwrap_or_default()
                    .chars()
                    .take(1024)
                    .collect::<String>();
                format!(
                    "security probe returned invalid JSON: {error}; reason={:?}; exitCode={:?}; signal={:?}; stderr={stderr:?}",
                    run.reason, run.exit_code, run.signal_or_status
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
            // sandbox-exec needs process-fork to launch the target. Seatbelt still denies exec of
            // every non-approved binary, while the group monitor enforces the process-count cap.
            // The child flushes this marker before the attempt and exits with reserved code 97
            // only if the forbidden shell actually ran.
            let process = probe["processAttemptStarted"].as_bool() == Some(true)
                && (matches!(run.reason, RunReason::ProcessLimit)
                    || (matches!(run.reason, RunReason::Exited)
                        && (run.exit_code == Some(0)
                            || (run.exit_code.is_none() && run.signal_or_status.is_some()))));
            let ready = filesystem && network && process;
            Ok(SelfTest {
                ready,
                diagnostics: if ready {
                    Vec::new()
                } else {
                    vec![format!(
                        "SECURE_RUNNER_SELF_TEST_FAILED: filesystem={filesystem}, network={network}, process={process}, reason={:?}",
                        run.reason
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

    pub fn run(&self, spec: &RunSpec, paths: &ValidatedRun, active: &ActiveRuns) -> RunResult {
        match self.run_inner(spec, paths, active) {
            Ok(result) => result,
            Err(error) => failure(spec, RunReason::LaunchError, error),
        }
    }

    fn run_inner(
        &self,
        spec: &RunSpec,
        paths: &ValidatedRun,
        active: &ActiveRuns,
    ) -> Result<RunResult, String> {
        let setup_started = Instant::now();
        let profile = build_profile(spec, paths)?;
        let profile_path = paths.workspace.join(".judgedesk-seatbelt.sb");
        fs::write(&profile_path, profile)
            .map_err(|error| format!("write Seatbelt profile: {error}"))?;
        let stdin = match &paths.stdin {
            Some(path) => File::open(path).map_err(|error| format!("open stdin: {error}"))?,
            None => File::open("/dev/null").map_err(|error| format!("open /dev/null: {error}"))?,
        };
        let stdout = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&paths.stdout)
            .map_err(|error| format!("open stdout: {error}"))?;
        let stderr = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&paths.stderr)
            .map_err(|error| format!("open stderr: {error}"))?;

        let launch_executable = if matches!(spec.role, RunRole::Compiler) {
            validated_compiler_executable(spec)?
        } else {
            paths.executable.clone()
        };

        let mut command = Command::new("/usr/bin/sandbox-exec");
        command
            .arg("-f")
            .arg(&profile_path)
            .arg(&launch_executable)
            .args(&spec.args)
            .current_dir(&paths.workspace)
            .stdin(Stdio::from(stdin))
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::from(stderr))
            .env_clear()
            .envs(minimal_environment(spec, &paths.workspace));
        // RLIMIT_FSIZE applies to every regular file, not just redirected stdout/stderr. Use
        // the aggregate write ceiling here and distinguish output from workspace writes after
        // wait4; otherwise a workspace bomb is incorrectly reported as OLE.
        let fsize = spec.limits.total_write_bytes;
        let nofile = spec.limits.open_files as u64;
        let address_space_slack = spec
            .limits
            .memory_bytes
            .saturating_mul(8)
            .max(512 * 1024 * 1024);
        // Darwin processes can begin with a very large reserved virtual address space
        // (dyld/shared-cache and allocator reservations). A fixed RLIMIT_AS can therefore be
        // below the launcher's existing VM size and setrlimit returns EINVAL before exec. Keep
        // an emergency ceiling, but calibrate it from the trusted launcher's actual baseline.
        // A fresh dyld/malloc launch can reserve substantially more VM than the already-running
        // executor, so retain at least one additional baseline of headroom.
        let executor_virtual_size = process_usage(std::process::id() as i32).virtual_memory_bytes;
        let address_space = (executor_virtual_size > 0).then(|| {
            executor_virtual_size
                .saturating_mul(2)
                .max(executor_virtual_size.saturating_add(address_space_slack))
        });
        unsafe {
            command.pre_exec(move || {
                if libc::setpgid(0, 0) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                set_limit(libc::RLIMIT_CORE, 0)?;
                set_limit(libc::RLIMIT_FSIZE, fsize)?;
                set_limit(libc::RLIMIT_NOFILE, nofile)?;
                if let Some(address_space) = address_space {
                    set_limit(libc::RLIMIT_AS, address_space)?;
                }
                Ok(())
            });
        }
        let (baseline_bytes, baseline_files) = inspect_workspace(&paths.workspace);
        let child = command
            .spawn()
            .map_err(|error| format!("launch Seatbelt process: {error}"))?;
        let security_setup_time_us =
            setup_started.elapsed().as_micros().min(u64::MAX as u128) as u64;
        let started = Instant::now();
        let pgid = child.id() as i32;
        // wait4 below owns reaping and returns the kernel high-water metrics that Child::wait
        // does not expose.
        drop(child);
        let cancelled = Arc::new(AtomicBool::new(false));
        let cancellation: Arc<dyn Cancellation> = Arc::new(ProcessGroupCancellation {
            pgid,
            cancelled: Arc::clone(&cancelled),
        });
        {
            let mut runs = active.lock().unwrap();
            if runs.insert(spec.run_id.clone(), cancellation).is_some() {
                kill_group(pgid);
                let _ = wait4_process(pgid, 0);
                return Err("duplicate active runId".into());
            }
        }

        let mut reason = RunReason::Exited;
        let mut diagnostic = None;
        let mut peak_memory = 0_u64;
        let (exit_status, final_rusage) = loop {
            if let Some((status, rusage)) = wait4_process(pgid, libc::WNOHANG)? {
                break (status, rusage);
            }
            let usage = process_group_usage(pgid);
            peak_memory = peak_memory.max(usage.memory_bytes);
            if cancelled.load(Ordering::Acquire) {
                reason = RunReason::Cancelled;
            } else if started.elapsed() >= Duration::from_millis(spec.limits.wall_time_ms) {
                reason = RunReason::WallTimeLimit;
            } else if usage.memory_bytes > spec.limits.memory_bytes {
                reason = RunReason::MemoryLimit;
            } else if usage.processes > spec.limits.process_count {
                reason = RunReason::ProcessLimit;
            } else if usage.threads > spec.limits.thread_count {
                reason = RunReason::ThreadLimit;
            } else if file_size(&paths.stdout).saturating_add(file_size(&paths.stderr))
                > spec.limits.output_bytes
            {
                reason = RunReason::OutputLimit;
            } else {
                let (bytes, files) = inspect_workspace(&paths.workspace);
                if bytes.saturating_sub(baseline_bytes) > spec.limits.total_write_bytes {
                    reason = RunReason::WriteLimit;
                } else if files.saturating_sub(baseline_files) > spec.limits.created_files {
                    reason = RunReason::WriteLimit;
                    diagnostic = Some("created-file limit exceeded".into());
                }
            }
            if !matches!(reason, RunReason::Exited) {
                kill_group(pgid);
                let (status, rusage) = wait4_process(pgid, 0)?
                    .ok_or_else(|| "wait4 returned no child after group kill".to_string())?;
                break (status, rusage);
            }
            std::thread::sleep(Duration::from_millis(2));
        };
        let wall_time_us = started.elapsed().as_micros().min(u64::MAX as u128) as u64;
        let collection_started = Instant::now();
        active.lock().unwrap().remove(&spec.run_id);
        let usage = process_group_usage(pgid);
        peak_memory = peak_memory.max(usage.memory_bytes);
        // Darwin reports ru_maxrss in bytes (Linux uses KiB). This survives process exit and
        // catches short resident-memory spikes that the 2 ms live sampler can miss.
        peak_memory = peak_memory.max(final_rusage.ru_maxrss.max(0) as u64);
        let (workspace_bytes, files) = inspect_workspace(&paths.workspace);
        let exit_signal = exit_status.signal();
        let stdout_bytes = file_size(&paths.stdout);
        let stderr_bytes = file_size(&paths.stderr);
        if matches!(reason, RunReason::Exited) && cancelled.load(Ordering::Acquire) {
            // cancel() can kill the group immediately before wait4 reaps it. Preserve the
            // user's cancellation intent even when reap wins that small race.
            reason = RunReason::Cancelled;
        }
        if matches!(reason, RunReason::Exited) {
            // RLIMIT_FSIZE can terminate a fast writer before the polling loop observes a file
            // larger than the limit. Attribute SIGXFSZ to output only when redirected output
            // reached its own cap; otherwise it is a workspace write-limit violation.
            if peak_memory > spec.limits.memory_bytes {
                reason = RunReason::MemoryLimit;
            } else if stdout_bytes.saturating_add(stderr_bytes) > spec.limits.output_bytes
                || (exit_signal == Some(libc::SIGXFSZ)
                    && stdout_bytes.saturating_add(stderr_bytes) >= spec.limits.output_bytes)
            {
                reason = RunReason::OutputLimit;
            } else if exit_signal == Some(libc::SIGXFSZ)
                || workspace_bytes.saturating_sub(baseline_bytes) > spec.limits.total_write_bytes
            {
                reason = RunReason::WriteLimit;
            } else if files.saturating_sub(baseline_files) > spec.limits.created_files {
                reason = RunReason::WriteLimit;
                diagnostic = Some("created-file limit exceeded".into());
            }
        }
        let result_collection_time_us = collection_started
            .elapsed()
            .as_micros()
            .min(u64::MAX as u128) as u64;
        let final_user_cpu_time_us = timeval_us(final_rusage.ru_utime);
        let final_kernel_cpu_time_us = timeval_us(final_rusage.ru_stime);
        Ok(RunResult {
            run_id: spec.run_id.clone(),
            reason,
            exit_code: exit_status.code(),
            signal_or_status: exit_signal.map(|signal| format!("signal {signal}")),
            security_setup_time_us,
            wall_time_us,
            result_collection_time_us,
            user_cpu_time_us: (final_user_cpu_time_us > 0)
                .then_some(final_user_cpu_time_us)
                .or_else(|| (usage.user_time_ns > 0).then_some(usage.user_time_ns / 1000)),
            kernel_cpu_time_us: (final_kernel_cpu_time_us > 0)
                .then_some(final_kernel_cpu_time_us)
                .or_else(|| (usage.system_time_ns > 0).then_some(usage.system_time_ns / 1000)),
            peak_memory_bytes: (peak_memory > 0).then_some(peak_memory),
            stdout_bytes,
            stderr_bytes,
            created_files: Some(files),
            diagnostic,
        })
    }
}

fn wait4_process(
    pid: i32,
    options: i32,
) -> Result<Option<(std::process::ExitStatus, libc::rusage)>, String> {
    loop {
        let mut status = 0_i32;
        let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
        let waited = unsafe { libc::wait4(pid, &mut status, options, &mut usage) };
        if waited == pid {
            return Ok(Some((std::process::ExitStatus::from_raw(status), usage)));
        }
        if waited == 0 {
            return Ok(None);
        }
        let error = std::io::Error::last_os_error();
        if error.kind() == std::io::ErrorKind::Interrupted {
            continue;
        }
        return Err(format!("wait4 process {pid}: {error}"));
    }
}

fn timeval_us(value: libc::timeval) -> u64 {
    (value.tv_sec.max(0) as u64)
        .saturating_mul(1_000_000)
        .saturating_add(value.tv_usec.max(0) as u64)
}

struct ProcessGroupCancellation {
    pgid: i32,
    cancelled: Arc<AtomicBool>,
}

impl Cancellation for ProcessGroupCancellation {
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        kill_group(self.pgid);
    }
}

fn kill_group(pgid: i32) {
    unsafe {
        libc::kill(-pgid, libc::SIGSTOP);
        libc::kill(-pgid, libc::SIGKILL);
    }
}

unsafe fn set_limit(resource: libc::c_int, value: u64) -> std::io::Result<()> {
    let limit = libc::rlimit {
        rlim_cur: value,
        rlim_max: value,
    };
    if libc::setrlimit(resource, &limit) != 0 {
        let error = std::io::Error::last_os_error();
        Err(std::io::Error::new(
            error.kind(),
            format!("setrlimit resource={resource} value={value}: {error}"),
        ))
    } else {
        Ok(())
    }
}

fn minimal_environment(spec: &RunSpec, workspace: &Path) -> Vec<(String, String)> {
    let mut values = vec![
        ("HOME".into(), workspace.to_string_lossy().into_owned()),
        ("TMPDIR".into(), workspace.to_string_lossy().into_owned()),
        ("PATH".into(), "/usr/bin:/bin".into()),
    ];
    values.extend(
        spec.environment
            .iter()
            .map(|(key, value)| (key.clone(), value.clone())),
    );
    values
}

fn build_profile(spec: &RunSpec, paths: &ValidatedRun) -> Result<String, String> {
    let workspace = seatbelt_literal(
        &fs::canonicalize(&paths.workspace)
            .map_err(|error| error.to_string())?
            .to_string_lossy(),
    );
    let executable = seatbelt_literal(
        &fs::canonicalize(&paths.executable)
            .map_err(|error| error.to_string())?
            .to_string_lossy(),
    );
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
    if let Some(toolchain_root) = paths
        .executable
        .ancestors()
        .find(|path| path.file_name().is_some_and(|name| name == "toolchains"))
    {
        read_rules.push(format!(
            "(subpath \"{}\")",
            seatbelt_literal(&toolchain_root.to_string_lossy())
        ));
    }
    let mut process_exec_rules = vec![
        format!("(literal \"{executable}\")"),
        "(literal \"/usr/bin/sandbox-exec\")".into(),
    ];
    if matches!(spec.role, RunRole::Compiler) {
        let (toolchain_root, developer_root) = validated_compiler_roots(spec)?;
        for root in [&toolchain_root, &developer_root] {
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
    Ok(format!(
        r#"(version 1)
(deny default)
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
(allow file-read-metadata file-test-existence
  (literal "/")
  (literal "/etc")
  (literal "/tmp")
  (literal "/var")
  (subpath "/private/var")
  (literal "/System/Volumes")
  (literal "/System/Volumes/Data")
  (literal "/System/Volumes/Data/Users")
  (literal "/System/Volumes/Preboot")
  (literal "/System/Volumes/Preboot/Cryptexes")
  (literal "/System/Cryptexes")
  (literal "/dev")
  (regex "^/dev/.*$"))
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
        read_rules.join(" ")
    ))
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
struct RusageInfoV2 {
    uuid: [u8; 16],
    user_time: u64,
    system_time: u64,
    pkg_idle_wkups: u64,
    interrupt_wkups: u64,
    pageins: u64,
    wired_size: u64,
    resident_size: u64,
    phys_footprint: u64,
    proc_start_abstime: u64,
    proc_exit_abstime: u64,
    child_user_time: u64,
    child_system_time: u64,
    child_pkg_idle_wkups: u64,
    child_interrupt_wkups: u64,
    child_pageins: u64,
    child_elapsed_abstime: u64,
}

#[derive(Default)]
struct ProcessUsage {
    memory_bytes: u64,
    virtual_memory_bytes: u64,
    processes: u32,
    threads: u32,
    user_time_ns: u64,
    system_time_ns: u64,
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
    fn proc_pid_rusage(pid: i32, flavor: i32, buffer: *mut RusageInfoV2) -> i32;
    fn proc_pidinfo(pid: i32, flavor: i32, arg: u64, buffer: *mut libc::c_void, size: i32) -> i32;
}

fn process_group_usage(pgid: i32) -> ProcessUsage {
    const PROC_PGRP_ONLY: u32 = 2;
    // RunSpec rejects process_count above 32. Keep ample room for observing a hostile burst
    // before the monitor kills the group, without allocating inside the polling loop repeatedly.
    let mut pids = [0_i32; 256];
    let buffer_size = std::mem::size_of_val(&pids) as i32;
    let bytes = unsafe {
        proc_listpids(
            PROC_PGRP_ONLY,
            pgid.max(0) as u32,
            pids.as_mut_ptr().cast(),
            buffer_size,
        )
    };
    if bytes <= 0 {
        return ProcessUsage::default();
    }

    let count = (bytes as usize / std::mem::size_of::<i32>()).min(pids.len());
    pids[..count]
        .iter()
        .copied()
        .filter(|pid| *pid > 0)
        .map(process_usage)
        .fold(ProcessUsage::default(), |mut group, process| {
            group.memory_bytes = group.memory_bytes.saturating_add(process.memory_bytes);
            group.virtual_memory_bytes = group
                .virtual_memory_bytes
                .saturating_add(process.virtual_memory_bytes);
            group.processes = group.processes.saturating_add(process.processes);
            group.threads = group.threads.saturating_add(process.threads);
            group.user_time_ns = group.user_time_ns.saturating_add(process.user_time_ns);
            group.system_time_ns = group.system_time_ns.saturating_add(process.system_time_ns);
            group
        })
}

fn process_usage(pid: i32) -> ProcessUsage {
    const RUSAGE_INFO_V2: i32 = 2;
    let mut info = RusageInfoV2::default();
    let success = unsafe { proc_pid_rusage(pid, RUSAGE_INFO_V2, &mut info) } == 0;
    const PROC_PIDTASKINFO: i32 = 4;
    let mut task = ProcTaskInfo::default();
    let task_size = std::mem::size_of::<ProcTaskInfo>() as i32;
    let task_success = unsafe {
        proc_pidinfo(
            pid,
            PROC_PIDTASKINFO,
            0,
            (&mut task as *mut ProcTaskInfo).cast(),
            task_size,
        )
    } == task_size;
    if success {
        ProcessUsage {
            memory_bytes: info
                .phys_footprint
                .max(info.resident_size)
                .max(if task_success { task.resident_size } else { 0 }),
            virtual_memory_bytes: if task_success { task.virtual_size } else { 0 },
            processes: 1,
            threads: if task_success {
                task.thread_count.max(0) as u32
            } else {
                1
            },
            user_time_ns: info.user_time,
            system_time_ns: info.system_time,
        }
    } else {
        ProcessUsage::default()
    }
}
