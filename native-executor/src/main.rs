use judgedesk_native_executor::platform::{ActiveRuns, Platform};
use judgedesk_native_executor::protocol::{
    read_frame, write_frame, ExecutorRequest, ExecutorResponse,
};
use judgedesk_native_executor::request_validation::validate_run;
use std::collections::{HashMap, HashSet};
use std::io::{self, Write};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

type AcceptedRuns = Arc<Mutex<HashSet<String>>>;

fn main() {
    #[cfg(target_os = "macos")]
    {
        if let Some(exit_code) =
            judgedesk_native_executor::macos_run_guardian::try_run_internal_mode()
        {
            std::process::exit(exit_code);
        }
        if let Some(exit_code) = judgedesk_native_executor::macos_launcher::try_run_internal_mode()
        {
            std::process::exit(exit_code);
        }
    }

    match std::env::args().nth(1).as_deref() {
        Some("--security-probe-child") => {
            security_probe_child();
            return;
        }
        #[cfg(target_os = "macos")]
        Some("--security-pgroup-spawn-child") => {
            return;
        }
        #[cfg(target_os = "macos")]
        Some("--test-process-identity") => {
            let pid = numeric_argument(2)
                .try_into()
                .expect("process identity PID is outside i32");
            match judgedesk_native_executor::macos_process::read_process_identity(pid) {
                Ok(identity) => println!("{}", serde_json::to_string(&identity).unwrap()),
                Err(error) => {
                    let _ = writeln!(io::stderr(), "process identity lookup failed: {error}");
                    std::process::exit(2);
                }
            }
            return;
        }
        Some("--test-sleep") => {
            std::thread::sleep(std::time::Duration::from_secs(60));
            return;
        }
        Some("--test-sleep-ms") => {
            let milliseconds = numeric_argument(2);
            std::thread::sleep(std::time::Duration::from_millis(milliseconds));
            return;
        }
        Some("--test-cpu-loop") => {
            let mut value = 0_u64;
            loop {
                value =
                    std::hint::black_box(value.wrapping_mul(6364136223846793005).wrapping_add(1));
            }
        }
        Some("--test-allocate-mib") => {
            let bytes = numeric_argument(2).saturating_mul(1024 * 1024) as usize;
            let hold_ms = numeric_argument(3);
            let mut allocation = vec![0_u8; bytes];
            for index in (0..allocation.len()).step_by(4096) {
                allocation[index] = 0x5a;
            }
            std::hint::black_box(&allocation);
            std::thread::sleep(std::time::Duration::from_millis(hold_ms));
            return;
        }
        Some("--test-output-bytes") => {
            let bytes = numeric_argument(2) as usize;
            let chunk = [b'X'; 4096];
            let mut remaining = bytes;
            let mut output = io::stdout().lock();
            while remaining > 0 {
                let amount = remaining.min(chunk.len());
                if output.write_all(&chunk[..amount]).is_err() {
                    break;
                }
                remaining -= amount;
            }
            let _ = output.flush();
            return;
        }
        Some("--test-thread-bomb") => {
            let count = numeric_argument(2) as usize;
            let hold_ms = numeric_argument(3);
            let mut threads = Vec::with_capacity(count);
            for _ in 0..count {
                threads.push(std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(hold_ms));
                }));
            }
            for thread in threads {
                let _ = thread.join();
            }
            return;
        }
        Some("--test-process-bomb") => {
            let count = numeric_argument(2) as usize;
            let hold_ms = numeric_argument(3);
            test_process_bomb(count, hold_ms);
            return;
        }
        Some("--test-spawn-child") => {
            let mut arguments = std::env::args_os().skip(2);
            let executable = arguments.next().expect("missing child executable");
            match std::process::Command::new(executable)
                .args(arguments)
                .status()
            {
                Ok(status) => println!(
                    "{}",
                    serde_json::json!({ "ok": true, "exitCode": status.code() })
                ),
                Err(error) => println!(
                    "{}",
                    serde_json::json!({
                        "ok": false,
                        "kind": format!("{:?}", error.kind()),
                        "rawOsError": error.raw_os_error(),
                        "message": error.to_string(),
                    })
                ),
            }
            return;
        }
        Some("--test-write") => {
            let arguments: Vec<_> = std::env::args_os().collect();
            let path = arguments.get(2).expect("missing output path");
            let bytes = arguments
                .get(3)
                .and_then(|value| value.to_str())
                .and_then(|value| value.parse::<usize>().ok())
                .expect("invalid byte count");
            std::fs::write(path, vec![0_u8; bytes]).expect("write test output");
            return;
        }
        _ => {}
    }
    if let Err(error) = run() {
        let _ = writeln!(io::stderr(), "JudgeDesk executor fatal error: {error}");
        std::process::exit(1);
    }
}

fn numeric_argument(index: usize) -> u64 {
    std::env::args()
        .nth(index)
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or_else(|| panic!("missing or invalid numeric argument at index {index}"))
}

#[cfg(not(target_os = "macos"))]
fn test_process_bomb(count: usize, hold_ms: u64) {
    let executable = std::env::current_exe().expect("locate process-bomb helper");
    let mut children = Vec::with_capacity(count.min(64));
    for _ in 0..count {
        match std::process::Command::new(&executable)
            .arg("--test-sleep-ms")
            .arg(hold_ms.to_string())
            .spawn()
        {
            Ok(child) => children.push(child),
            Err(_) => {
                // Keep every successfully-created child alive long enough for the executor to
                // observe the process-count violation.
                std::thread::sleep(std::time::Duration::from_millis(hold_ms));
                break;
            }
        }
    }
    for mut child in children {
        let _ = child.wait();
    }
}

#[cfg(target_os = "macos")]
fn test_process_bomb(count: usize, hold_ms: u64) {
    // Security-probe profiles intentionally deny posix_spawn because its SETPGROUP/SETSID flags
    // can escape containment. fork is the safe hostile fixture: children inherit this PGID, and
    // RLIMIT_NPROC still provides the kernel-backed burst ceiling under test.
    let mut children = Vec::with_capacity(count.min(64));
    let sleep = libc::timespec {
        tv_sec: (hold_ms / 1_000).min(libc::time_t::MAX as u64) as libc::time_t,
        tv_nsec: ((hold_ms % 1_000) * 1_000_000) as libc::c_long,
    };
    for _ in 0..count {
        let child = unsafe { libc::fork() };
        if child == 0 {
            let mut remaining = sleep;
            loop {
                let mut interrupted = libc::timespec {
                    tv_sec: 0,
                    tv_nsec: 0,
                };
                if unsafe { libc::nanosleep(&remaining, &mut interrupted) } == 0 {
                    break;
                }
                remaining = interrupted;
            }
            unsafe {
                libc::_exit(0);
            }
        }
        if child > 0 {
            children.push(child);
            continue;
        }
        std::thread::sleep(Duration::from_millis(hold_ms));
        break;
    }
    for child in children {
        let _ = wait_for_macos_probe_child(child);
    }
}

fn security_probe_child() {
    use std::net::{SocketAddr, TcpStream};
    #[cfg(not(target_os = "macos"))]
    use std::process::Command;
    use std::time::Duration;

    let sentinel = std::env::args()
        .nth(2)
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::var_os("JUDGEDESK_PROBE_SENTINEL").map(std::path::PathBuf::from));
    let read_blocked = sentinel
        .as_ref()
        .is_some_and(|path| std::fs::read(path).is_err());
    let write_blocked = sentinel
        .as_ref()
        .is_some_and(|path| std::fs::write(path, b"OVERWRITTEN").is_err());
    let address: SocketAddr = "127.0.0.1:9".parse().unwrap();
    let network_blocked = std::panic::catch_unwind(|| {
        let network_error = TcpStream::connect_timeout(&address, Duration::from_millis(500)).err();
        network_error.as_ref().is_some_and(|error| {
            error.kind() == std::io::ErrorKind::PermissionDenied
                || matches!(error.raw_os_error(), Some(13 | 10013 | 10107))
        })
    })
    .unwrap_or(true);
    #[cfg(not(target_os = "macos"))]
    let (process_command, process_args): (&str, &[&str]) = if cfg!(windows) {
        ("cmd.exe", &["/c", "exit", "0"])
    } else {
        ("/bin/sh", &["-c", "exit 0"])
    };
    let probe = serde_json::json!({
        "readBlocked": read_blocked,
        "writeBlocked": write_blocked,
        "networkBlocked": network_blocked,
        "processAttemptStarted": true,
    });
    #[cfg(target_os = "macos")]
    let probe = {
        let mut probe = probe;
        probe["processGroupEscape"] = macos_process_group_escape_probe();
        let forbidden_exec = macos_forbidden_exec_probe();
        probe["forbiddenExecBlockedWithEperm"] =
            serde_json::Value::Bool(forbidden_exec.blocked_with_eperm);
        probe["forbiddenExecDetail"] = serde_json::Value::String(forbidden_exec.detail);
        probe
    };
    println!("{probe}");
    let _ = io::stdout().flush();
    #[cfg(not(target_os = "macos"))]
    {
        let process_blocked = Command::new(process_command)
            .args(process_args)
            .status()
            .is_err();
        if !process_blocked {
            // The parent treats this reserved code as proof that a forbidden child really ran.
            std::process::exit(97);
        }
    }
}

#[cfg(target_os = "macos")]
struct MacosGroupEscapeProbe {
    blocked_with_eperm: bool,
    detail: String,
}

#[cfg(target_os = "macos")]
fn macos_process_group_escape_probe() -> serde_json::Value {
    let setpgid = forked_macos_group_escape_probe("setpgid", || unsafe { libc::setpgid(0, 0) });
    let setsid = forked_macos_group_escape_probe("setsid", || unsafe { libc::setsid() });
    let posix_spawn = macos_posix_spawn_group_escape_probe();
    serde_json::json!({
        "setpgidBlockedWithEperm": setpgid.blocked_with_eperm,
        "setpgidDetail": setpgid.detail,
        "setsidBlockedWithEperm": setsid.blocked_with_eperm,
        "setsidDetail": setsid.detail,
        "posixSpawnGroupBlockedWithEperm": posix_spawn.blocked_with_eperm,
        "posixSpawnGroupDetail": posix_spawn.detail,
    })
}

#[cfg(target_os = "macos")]
fn macos_forbidden_exec_probe() -> MacosGroupEscapeProbe {
    use std::ffi::CString;

    let shell = CString::new("/bin/sh").unwrap();
    let shell_name = CString::new("sh").unwrap();
    let command_flag = CString::new("-c").unwrap();
    let command = CString::new("exit 97").unwrap();
    let environment = unsafe { *libc::_NSGetEnviron() as *const *const libc::c_char };
    let child = unsafe { libc::fork() };
    if child < 0 {
        return MacosGroupEscapeProbe {
            blocked_with_eperm: false,
            detail: format!(
                "forbidden exec probe fork failed: {}",
                io::Error::last_os_error()
            ),
        };
    }
    if child == 0 {
        let arguments = [
            shell_name.as_ptr(),
            command_flag.as_ptr(),
            command.as_ptr(),
            std::ptr::null(),
        ];
        unsafe {
            libc::execve(shell.as_ptr(), arguments.as_ptr(), environment);
            let error = *libc::__error();
            libc::_exit(if error == libc::EPERM {
                0
            } else {
                32 + error.clamp(0, 200)
            });
        }
    }

    match wait_for_macos_probe_child(child) {
        Ok(0) => MacosGroupEscapeProbe {
            blocked_with_eperm: true,
            detail: "blocked with EPERM".into(),
        },
        Ok(97) => MacosGroupEscapeProbe {
            blocked_with_eperm: false,
            detail: "/bin/sh unexpectedly executed".into(),
        },
        Ok(code) if (32..=232).contains(&code) => MacosGroupEscapeProbe {
            blocked_with_eperm: false,
            detail: format!("forbidden exec returned errno {}", code - 32),
        },
        Ok(code) => MacosGroupEscapeProbe {
            blocked_with_eperm: false,
            detail: format!("forbidden exec probe exited with status {code}"),
        },
        Err(error) => MacosGroupEscapeProbe {
            blocked_with_eperm: false,
            detail: format!("forbidden exec probe {error}"),
        },
    }
}

#[cfg(target_os = "macos")]
fn forked_macos_group_escape_probe(
    name: &str,
    operation: impl FnOnce() -> libc::c_int,
) -> MacosGroupEscapeProbe {
    let child = unsafe { libc::fork() };
    if child < 0 {
        return MacosGroupEscapeProbe {
            blocked_with_eperm: false,
            detail: format!("{name} probe fork failed: {}", io::Error::last_os_error()),
        };
    }
    if child == 0 {
        // Only async-signal-safe libc calls are used after fork. Exit zero exclusively when the
        // policy returned EPERM and left the child in its inherited process group.
        let original_group = unsafe { libc::getpgrp() };
        let result = operation();
        let error = if result < 0 {
            unsafe { *libc::__error() }
        } else {
            0
        };
        let group_unchanged = unsafe { libc::getpgrp() } == original_group;
        let exit_code = if result < 0 && error == libc::EPERM && group_unchanged {
            0
        } else if result >= 0 {
            1
        } else if !group_unchanged {
            2
        } else {
            32 + error.clamp(0, 200)
        };
        unsafe {
            libc::_exit(exit_code);
        }
    }

    match wait_for_macos_probe_child(child) {
        Ok(0) => MacosGroupEscapeProbe {
            blocked_with_eperm: true,
            detail: "blocked with EPERM and process group unchanged".into(),
        },
        Ok(1) => MacosGroupEscapeProbe {
            blocked_with_eperm: false,
            detail: format!("{name} unexpectedly succeeded"),
        },
        Ok(2) => MacosGroupEscapeProbe {
            blocked_with_eperm: false,
            detail: format!("{name} failed after changing the process group"),
        },
        Ok(code) if (32..=232).contains(&code) => MacosGroupEscapeProbe {
            blocked_with_eperm: false,
            detail: format!("{name} returned errno {}", code - 32),
        },
        Ok(code) => MacosGroupEscapeProbe {
            blocked_with_eperm: false,
            detail: format!("{name} probe exited with status {code}"),
        },
        Err(error) => MacosGroupEscapeProbe {
            blocked_with_eperm: false,
            detail: format!("{name} probe {error}"),
        },
    }
}

#[cfg(target_os = "macos")]
fn macos_posix_spawn_group_escape_probe() -> MacosGroupEscapeProbe {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let executable = match std::env::current_exe()
        .map_err(|error| error.to_string())
        .and_then(|path| {
            CString::new(path.as_os_str().as_bytes())
                .map_err(|_| "security probe executable contains a NUL byte".to_string())
        }) {
        Ok(executable) => executable,
        Err(error) => {
            return MacosGroupEscapeProbe {
                blocked_with_eperm: false,
                detail: error,
            };
        }
    };
    let argument = CString::new("--security-pgroup-spawn-child").unwrap();
    let mut attributes: libc::posix_spawnattr_t = std::ptr::null_mut();
    let initialized = unsafe { libc::posix_spawnattr_init(&mut attributes) };
    if initialized != 0 {
        return MacosGroupEscapeProbe {
            blocked_with_eperm: false,
            detail: format!("posix_spawnattr_init returned {initialized}"),
        };
    }

    let flags = libc::POSIX_SPAWN_SETPGROUP as libc::c_short;
    let configured = unsafe {
        let flags_result = libc::posix_spawnattr_setflags(&mut attributes, flags);
        if flags_result != 0 {
            flags_result
        } else {
            libc::posix_spawnattr_setpgroup(&mut attributes, 0)
        }
    };
    if configured != 0 {
        unsafe {
            libc::posix_spawnattr_destroy(&mut attributes);
        }
        return MacosGroupEscapeProbe {
            blocked_with_eperm: false,
            detail: format!("posix_spawn group attributes returned {configured}"),
        };
    }

    let mut child = 0;
    let mut arguments = [
        executable.as_ptr().cast_mut(),
        argument.as_ptr().cast_mut(),
        std::ptr::null_mut(),
    ];
    let spawn_result = unsafe {
        libc::posix_spawn(
            &mut child,
            executable.as_ptr(),
            std::ptr::null(),
            &attributes,
            arguments.as_mut_ptr(),
            *libc::_NSGetEnviron(),
        )
    };
    unsafe {
        libc::posix_spawnattr_destroy(&mut attributes);
    }

    if spawn_result == libc::EPERM {
        return MacosGroupEscapeProbe {
            blocked_with_eperm: true,
            detail: "blocked with EPERM".into(),
        };
    }
    if spawn_result != 0 {
        return MacosGroupEscapeProbe {
            blocked_with_eperm: false,
            detail: format!("posix_spawn returned {spawn_result}, expected EPERM"),
        };
    }

    let child_detail = match wait_for_macos_probe_child(child) {
        Ok(code) => format!("; child exit status {code}"),
        Err(error) => format!("; child {error}"),
    };
    MacosGroupEscapeProbe {
        blocked_with_eperm: false,
        detail: format!("posix_spawn unexpectedly created process {child}{child_detail}"),
    }
}

#[cfg(target_os = "macos")]
fn wait_for_macos_probe_child(child: libc::pid_t) -> Result<i32, String> {
    loop {
        let mut status = 0;
        let waited = unsafe { libc::waitpid(child, &mut status, 0) };
        if waited == child {
            if libc::WIFEXITED(status) {
                return Ok(libc::WEXITSTATUS(status));
            }
            return Err(format!("terminated with wait status {status}"));
        }
        if waited < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(format!("waitpid failed: {error}"));
        }
    }
}

fn run() -> Result<(), String> {
    let _tree_guard = judgedesk_native_executor::tree_guard::acquire_from_environment()?;
    let platform = Arc::new(Platform::initialize());
    let active: ActiveRuns = Arc::new(Mutex::new(HashMap::new()));
    let accepted_runs: AcceptedRuns = Arc::new(Mutex::new(HashSet::new()));
    let writer = Arc::new(Mutex::new(io::stdout()));
    let mut reader = io::stdin();

    let protocol_result = serve_requests(&platform, &active, &accepted_runs, &writer, &mut reader);
    // Every exit path, including malformed/truncated input and a broken stdout pipe, must wait
    // for the last accepted worker to prove its process group empty before the macOS generation
    // guard can be dropped.
    drain_runs(&active, &accepted_runs);
    protocol_result
}

fn serve_requests(
    platform: &Arc<Platform>,
    active: &ActiveRuns,
    accepted_runs: &AcceptedRuns,
    writer: &Arc<Mutex<io::Stdout>>,
    reader: &mut io::Stdin,
) -> Result<(), String> {
    while let Some(frame) = read_frame(reader).map_err(|error| error.to_string())? {
        let request: ExecutorRequest = match serde_json::from_slice(&frame) {
            Ok(request) => request,
            Err(error) => {
                send(
                    writer,
                    ExecutorResponse::Error {
                        id: String::new(),
                        code: "SECURE_RUNNER_PROTOCOL_ERROR".into(),
                        message: error.to_string(),
                    },
                )?;
                continue;
            }
        };
        match request {
            ExecutorRequest::Health { id } => {
                send(
                    writer,
                    ExecutorResponse::Health {
                        id,
                        health: platform.health(),
                    },
                )?;
            }
            ExecutorRequest::Run { id, spec } => {
                if !platform.health().ready {
                    send(
                        writer,
                        ExecutorResponse::Error {
                            id,
                            code: "SECURE_RUNNER_UNAVAILABLE".into(),
                            message: platform.health().diagnostics.join("; "),
                        },
                    )?;
                    continue;
                }
                let validated = match validate_run(platform.root(), &spec) {
                    Ok(value) => value,
                    Err(message) => {
                        send(
                            writer,
                            ExecutorResponse::Error {
                                id,
                                code: "SECURE_RUNNER_INVALID_REQUEST".into(),
                                message,
                            },
                        )?;
                        continue;
                    }
                };
                if !accepted_runs.lock().unwrap().insert(spec.run_id.clone()) {
                    send(
                        writer,
                        ExecutorResponse::Error {
                            id,
                            code: "SECURE_RUNNER_INVALID_REQUEST".into(),
                            message: "duplicate runId".into(),
                        },
                    )?;
                    continue;
                }
                let worker_platform = Arc::clone(platform);
                let worker_active = Arc::clone(active);
                let worker_accepted_runs = Arc::clone(accepted_runs);
                let worker_writer = Arc::clone(writer);
                let run_id = spec.run_id.clone();
                let worker_run_id = run_id.clone();
                let worker_id = id.clone();
                if let Err(error) = std::thread::Builder::new()
                    .name(format!("judgedesk-run-{worker_run_id}"))
                    .spawn(move || {
                        let result = worker_platform.run(&spec, &validated, &worker_active);
                        // Keep the reservation until after the terminal frame has been attempted.
                        // ShutdownResult must never overtake a RunResult from an accepted run.
                        let _ = send(
                            &worker_writer,
                            ExecutorResponse::RunResult {
                                id: worker_id,
                                result,
                            },
                        );
                        worker_accepted_runs
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner())
                            .remove(&worker_run_id);
                    })
                {
                    accepted_runs
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .remove(&run_id);
                    send(
                        writer,
                        ExecutorResponse::Error {
                            id,
                            code: "SECURE_RUNNER_UNAVAILABLE".into(),
                            message: format!("cannot start secure-run worker: {error}"),
                        },
                    )?;
                }
            }
            ExecutorRequest::Cancel { id, run_id } => {
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
                let mut cancelled = false;
                loop {
                    if let Some(handle) = active.lock().unwrap().get(&run_id).cloned() {
                        handle.cancel();
                        cancelled = true;
                        break;
                    }
                    if !accepted_runs.lock().unwrap().contains(&run_id)
                        || std::time::Instant::now() >= deadline
                    {
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(1));
                }
                send(
                    writer,
                    ExecutorResponse::CancelResult {
                        id,
                        run_id,
                        cancelled,
                    },
                )?;
            }
            ExecutorRequest::Shutdown { id } => {
                drain_runs(active, accepted_runs);
                send(writer, ExecutorResponse::ShutdownResult { id })?;
                return Ok(());
            }
        }
    }
    Ok(())
}

fn drain_runs(active: &ActiveRuns, accepted_runs: &AcceptedRuns) {
    let mut next_diagnostic = Instant::now() + Duration::from_secs(10);
    loop {
        // Repeat cancellation to cover the accepted -> active handoff: a worker may have been
        // reserved before shutdown but not registered its process-group cancellation handle yet.
        let runs: Vec<_> = active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .values()
            .cloned()
            .collect();
        for run in runs {
            run.cancel();
        }

        let active_count = active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .len();
        let accepted_count = accepted_runs
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .len();
        if active_count == 0 && accepted_count == 0 {
            return;
        }

        if Instant::now() >= next_diagnostic {
            let _ = writeln!(
                io::stderr(),
                "EXECUTOR_DRAIN_STALLED active={active_count} accepted={accepted_count}"
            );
            next_diagnostic = Instant::now() + Duration::from_secs(10);
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn send(writer: &Arc<Mutex<io::Stdout>>, response: ExecutorResponse) -> Result<(), String> {
    write_frame(
        &mut *writer
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()),
        &response,
    )
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use judgedesk_native_executor::platform::Cancellation;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc;

    struct TestCancellation {
        cancelled: AtomicBool,
        observed: mpsc::Sender<()>,
    }

    impl Cancellation for TestCancellation {
        fn cancel(&self) {
            if !self.cancelled.swap(true, Ordering::AcqRel) {
                let _ = self.observed.send(());
            }
        }
    }

    #[test]
    fn drain_waits_for_reserved_run_and_cancels_after_late_registration() {
        let active: ActiveRuns = Arc::new(Mutex::new(HashMap::new()));
        let accepted: AcceptedRuns = Arc::new(Mutex::new(HashSet::from(["late".into()])));
        let drain_active = Arc::clone(&active);
        let drain_accepted = Arc::clone(&accepted);
        let (finished_tx, finished_rx) = mpsc::channel();
        let drain_thread = std::thread::spawn(move || {
            drain_runs(&drain_active, &drain_accepted);
            finished_tx.send(()).unwrap();
        });

        assert!(finished_rx.recv_timeout(Duration::from_millis(25)).is_err());

        let (cancelled_tx, cancelled_rx) = mpsc::channel();
        active.lock().unwrap().insert(
            "late".into(),
            Arc::new(TestCancellation {
                cancelled: AtomicBool::new(false),
                observed: cancelled_tx,
            }),
        );
        cancelled_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("late active run was not cancelled");
        assert!(finished_rx.recv_timeout(Duration::from_millis(25)).is_err());

        active.lock().unwrap().remove("late");
        accepted.lock().unwrap().remove("late");
        finished_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("drain did not finish after both barriers became empty");
        drain_thread.join().unwrap();
    }
}
