#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used))]

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
const CANCEL_DRAIN_TIMEOUT: Duration = Duration::from_secs(20);

fn reserve_run_ids(accepted: &AcceptedRuns, run_ids: &[&str]) -> bool {
    let mut reservations = accepted
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let unique: HashSet<_> = run_ids.iter().copied().collect();
    if unique.len() != run_ids.len() || run_ids.iter().any(|id| reservations.contains(*id)) {
        return false;
    }
    reservations.extend(run_ids.iter().map(|id| (*id).to_owned()));
    true
}

fn release_run_ids(accepted: &AcceptedRuns, run_ids: &[&str]) {
    let mut reservations = accepted
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    for run_id in run_ids {
        reservations.remove(*run_id);
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CancelOutcome {
    NotFound,
    Drained,
    TimedOut,
}

fn main() {
    // Internal security probe modes (including libc::POSIX_SPAWN_SETPGROUP verification in security_probe.rs)
    if let Some(exit_code) = judgedesk_native_executor::try_run_internal_mode() {
        std::process::exit(exit_code);
    }

    match std::env::args().nth(1).as_deref() {
        #[cfg(target_os = "macos")]
        Some("--test-process-identity") => {
            let pid = match numeric_argument(2).try_into() {
                Ok(pid) => pid,
                Err(error) => {
                    let _ = writeln!(io::stderr(), "process identity PID is outside i32: {error}");
                    std::process::exit(2);
                }
            };
            match judgedesk_native_executor::macos_process::read_process_identity(pid) {
                Ok(identity) => {
                    if let Ok(json) = serde_json::to_string(&identity) {
                        println!("{json}");
                    }
                }
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
            let executable = match arguments.next() {
                Some(executable) => executable,
                None => {
                    let _ = writeln!(io::stderr(), "missing child executable");
                    std::process::exit(2);
                }
            };
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
            let path = match arguments.get(2) {
                Some(path) => path,
                None => {
                    let _ = writeln!(io::stderr(), "missing output path");
                    std::process::exit(2);
                }
            };
            let bytes = match arguments
                .get(3)
                .and_then(|value| value.to_str())
                .and_then(|value| value.parse::<usize>().ok())
            {
                Some(bytes) => bytes,
                None => {
                    let _ = writeln!(io::stderr(), "invalid byte count");
                    std::process::exit(2);
                }
            };
            if let Err(error) = std::fs::write(path, vec![0_u8; bytes]) {
                let _ = writeln!(io::stderr(), "write test output: {error}");
                std::process::exit(2);
            }
            return;
        }
        Some("--test-file-network-probe") => {
            test_file_network_probe();
            return;
        }
        Some("--test-mock-health-version") => {
            let ver = std::env::args().nth(2).unwrap_or_else(|| "1.4.0".into());
            run_mock_health(true, &ver, true, true, true, true);
            return;
        }
        Some("--test-mock-health-unready") => {
            run_mock_health(
                false,
                judgedesk_native_executor::protocol::EXECUTOR_VERSION,
                true,
                true,
                true,
                true,
            );
            return;
        }
        Some("--test-mock-health-insecure") => {
            run_mock_health(
                true,
                judgedesk_native_executor::protocol::EXECUTOR_VERSION,
                false,
                true,
                true,
                true,
            );
            return;
        }
        Some("--test-mock-malformed-response") => {
            run_mock_malformed();
            return;
        }
        Some("--test-mock-unknown-id") => {
            run_mock_unknown_id();
            return;
        }
        Some("--test-mock-health-then-unknown-drain") => {
            run_mock_health_then_unknown_drain();
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
        .unwrap_or(0)
}

fn test_file_network_probe() {
    use std::net::{SocketAddr, TcpStream};

    let sentinel = match std::env::args_os().nth(2) {
        Some(sentinel) => sentinel,
        None => {
            let _ = writeln!(io::stderr(), "missing private sentinel path");
            return;
        }
    };
    let read_blocked = std::fs::read(&sentinel).is_err();
    let write_blocked = std::fs::write(&sentinel, b"OVERWRITTEN").is_err();
    let address = SocketAddr::from(([127, 0, 0, 1], 9));
    let network_blocked = std::panic::catch_unwind(|| {
        let network_error = TcpStream::connect_timeout(&address, Duration::from_millis(500)).err();
        network_error.as_ref().is_some_and(|error| {
            error.kind() == std::io::ErrorKind::PermissionDenied
                || matches!(error.raw_os_error(), Some(13 | 10013 | 10107))
        })
    })
    .unwrap_or(true);
    println!(
        "{}",
        serde_json::json!({
            "readBlocked": read_blocked,
            "writeBlocked": write_blocked,
            "networkBlocked": network_blocked,
        })
    );
}

fn run_mock_health(
    ready: bool,
    version: &str,
    network_blocked: bool,
    filesystem_isolated: bool,
    process_tree_controlled: bool,
    memory_limit_supported: bool,
) {
    use judgedesk_native_executor::protocol::{write_frame, ExecutorHealth};
    let mut reader = io::stdin();
    if let Ok(Some(frame)) = read_frame(&mut reader) {
        if let Ok(ExecutorRequest::Health { id }) = serde_json::from_slice(&frame) {
            let resp = ExecutorResponse::Health {
                id,
                health: ExecutorHealth {
                    ready,
                    mode: "sandbox".into(),
                    executor_version: version.into(),
                    executor_root: std::env::temp_dir().to_string_lossy().to_string(),
                    diagnostics: if ready {
                        vec![]
                    } else {
                        vec!["mock unready".into()]
                    },
                    network_blocked,
                    filesystem_isolated,
                    process_tree_controlled,
                    memory_limit_supported,
                    startup_timings: None,
                },
            };
            let mut writer = io::stdout();
            let _ = write_frame(&mut writer, &resp);
        }
    }
}

fn run_mock_malformed() {
    let mut reader = io::stdin();
    if let Ok(Some(_)) = read_frame(&mut reader) {
        let mut writer = io::stdout();
        let bad = b"not a json object";
        let _ = writer.write_all(&(bad.len() as u32).to_le_bytes());
        let _ = writer.write_all(bad);
        let _ = writer.flush();
    }
}

fn run_mock_unknown_id() {
    use judgedesk_native_executor::protocol::{write_frame, ExecutorHealth};
    let mut reader = io::stdin();
    if let Ok(Some(_)) = read_frame(&mut reader) {
        let resp = ExecutorResponse::Health {
            id: "wrong-correlation-id-999".into(),
            health: ExecutorHealth {
                ready: true,
                mode: "sandbox".into(),
                executor_version: judgedesk_native_executor::protocol::EXECUTOR_VERSION.into(),
                executor_root: std::env::temp_dir().to_string_lossy().to_string(),
                diagnostics: vec![],
                network_blocked: true,
                filesystem_isolated: true,
                process_tree_controlled: true,
                memory_limit_supported: true,
                startup_timings: None,
            },
        };
        let mut writer = io::stdout();
        let _ = write_frame(&mut writer, &resp);
    }
}

fn run_mock_health_then_unknown_drain() {
    use judgedesk_native_executor::protocol::{write_frame, ExecutorHealth};

    let mut reader = io::stdin();
    let Ok(Some(frame)) = read_frame(&mut reader) else {
        return;
    };
    let Ok(ExecutorRequest::Health { id }) = serde_json::from_slice(&frame) else {
        return;
    };
    let health = ExecutorHealth {
        ready: true,
        mode: "sandbox".into(),
        executor_version: judgedesk_native_executor::protocol::EXECUTOR_VERSION.into(),
        executor_root: std::env::temp_dir().to_string_lossy().to_string(),
        diagnostics: vec![],
        network_blocked: true,
        filesystem_isolated: true,
        process_tree_controlled: true,
        memory_limit_supported: true,
        startup_timings: None,
    };
    let mut writer = io::stdout();
    let _ = write_frame(
        &mut writer,
        &ExecutorResponse::Health {
            id,
            health: health.clone(),
        },
    );
    let _ = write_frame(
        &mut writer,
        &ExecutorResponse::Health {
            id: "wrong-correlation-id-after-health".into(),
            health,
        },
    );

    while matches!(read_frame(&mut reader), Ok(Some(_))) {}
    std::thread::sleep(Duration::from_millis(250));
}

#[cfg(not(target_os = "macos"))]
fn test_process_bomb(count: usize, hold_ms: u64) {
    let executable = match std::env::current_exe() {
        Ok(exe) => exe,
        Err(error) => {
            let _ = writeln!(io::stderr(), "locate process-bomb helper: {error}");
            return;
        }
    };
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
    let _tree_guard = judgedesk_native_executor::tree_guard::acquire_executor_from_environment()?;
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
                return Err(format!("malformed or unknown executor request: {error}"));
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
                if !accepted_runs
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .insert(spec.run_id.clone())
                {
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
            ExecutorRequest::InteractiveRun { id, spec } => {
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
                let reserved_ids = [
                    spec.run_id.clone(),
                    spec.submission.run_id.clone(),
                    spec.interactor.run_id.clone(),
                ];
                if !reserve_run_ids(accepted_runs, &reserved_ids.each_ref().map(String::as_str)) {
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
                let worker_reserved_ids = reserved_ids.clone();
                if let Err(error) = std::thread::Builder::new()
                    .name(format!("judgedesk-interactive-{worker_run_id}"))
                    .spawn(move || {
                        let result = worker_platform.run_interactive(&spec, &worker_active);
                        let _ = send(
                            &worker_writer,
                            ExecutorResponse::InteractiveRunResult {
                                id: worker_id,
                                result: Box::new(result),
                            },
                        );
                        release_run_ids(
                            &worker_accepted_runs,
                            &worker_reserved_ids.each_ref().map(String::as_str),
                        );
                    })
                {
                    release_run_ids(accepted_runs, &reserved_ids.each_ref().map(String::as_str));
                    send(
                        writer,
                        ExecutorResponse::Error {
                            id,
                            code: "SECURE_RUNNER_UNAVAILABLE".into(),
                            message: format!("cannot start interactive worker: {error}"),
                        },
                    )?;
                }
            }
            ExecutorRequest::Cancel { id, run_id } => {
                // A successful cancellation response is a drain acknowledgement, not merely
                // proof that a signal was requested. The worker attempts its terminal RunResult
                // before releasing accepted_runs, while each platform removes its active handle
                // only after the Job/guardian has proved the process container empty.
                let outcome =
                    cancel_and_wait_for_run(active, accepted_runs, &run_id, CANCEL_DRAIN_TIMEOUT);
                send(
                    writer,
                    ExecutorResponse::CancelResult {
                        id,
                        run_id: run_id.clone(),
                        cancelled: outcome == CancelOutcome::Drained,
                    },
                )?;
                if outcome == CancelOutcome::TimedOut {
                    // Stop admission permanently. Continuing the request loop after a timed-out
                    // cancellation would allow a new run beside a container that has not proved
                    // empty. Keep retrying teardown; if it eventually drains, exit this executor
                    // so the client must establish a fresh startup self-test before more work.
                    drain_runs(active, accepted_runs);
                    return Err(format!(
                        "cancellation drain timed out for run {run_id}; executor entered terminal drain"
                    ));
                }
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

fn cancel_and_wait_for_run(
    active: &ActiveRuns,
    accepted_runs: &AcceptedRuns,
    run_id: &str,
    timeout: Duration,
) -> CancelOutcome {
    let initially_active = active
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .contains_key(run_id);
    let initially_accepted = accepted_runs
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .contains(run_id);
    if !initially_active && !initially_accepted {
        return CancelOutcome::NotFound;
    }

    let deadline = Instant::now() + timeout;
    loop {
        let cancellation = active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(run_id)
            .cloned();
        if let Some(cancellation) = cancellation {
            cancellation.cancel();
        }

        let active_now = active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .contains_key(run_id);
        let accepted_now = accepted_runs
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .contains(run_id);
        if !active_now && !accepted_now {
            return CancelOutcome::Drained;
        }
        if Instant::now() >= deadline {
            return CancelOutcome::TimedOut;
        }
        std::thread::sleep(Duration::from_millis(1));
    }
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

    #[test]
    fn cancel_ack_waits_until_the_run_is_no_longer_active_or_accepted() {
        let active: ActiveRuns = Arc::new(Mutex::new(HashMap::new()));
        let accepted: AcceptedRuns = Arc::new(Mutex::new(HashSet::from(["run".into()])));
        let (cancelled_tx, cancelled_rx) = mpsc::channel();
        active.lock().unwrap().insert(
            "run".into(),
            Arc::new(TestCancellation {
                cancelled: AtomicBool::new(false),
                observed: cancelled_tx,
            }),
        );

        let cancel_active = Arc::clone(&active);
        let cancel_accepted = Arc::clone(&accepted);
        let (finished_tx, finished_rx) = mpsc::channel();
        let cancel_thread = std::thread::spawn(move || {
            let acknowledged = cancel_and_wait_for_run(
                &cancel_active,
                &cancel_accepted,
                "run",
                Duration::from_secs(1),
            );
            finished_tx.send(acknowledged).unwrap();
        });

        cancelled_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("cancellation was not requested");
        assert!(finished_rx.recv_timeout(Duration::from_millis(25)).is_err());

        active.lock().unwrap().remove("run");
        assert!(finished_rx.recv_timeout(Duration::from_millis(25)).is_err());
        accepted.lock().unwrap().remove("run");
        assert_eq!(
            finished_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
            CancelOutcome::Drained,
        );
        cancel_thread.join().unwrap();
    }

    #[test]
    fn cancel_timeout_is_distinct_from_not_found_and_never_claims_drain() {
        let active: ActiveRuns = Arc::new(Mutex::new(HashMap::new()));
        let accepted: AcceptedRuns = Arc::new(Mutex::new(HashSet::from(["stuck".into()])));

        assert_eq!(
            cancel_and_wait_for_run(&active, &accepted, "missing", Duration::ZERO),
            CancelOutcome::NotFound,
        );
        assert_eq!(
            cancel_and_wait_for_run(&active, &accepted, "stuck", Duration::ZERO),
            CancelOutcome::TimedOut,
        );
    }

    #[test]
    fn poisoned_mutex_synchronization_does_not_panic() {
        let active: ActiveRuns = Arc::new(Mutex::new(HashMap::new()));
        let accepted: AcceptedRuns = Arc::new(Mutex::new(HashSet::new()));

        // Intentionally poison both mutexes by panicking inside a thread holding the lock
        let poison_active = Arc::clone(&active);
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = poison_active.lock().unwrap();
            panic!("intentional poison active");
        }));
        assert!(active.is_poisoned());

        let poison_accepted = Arc::clone(&accepted);
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = poison_accepted.lock().unwrap();
            panic!("intentional poison accepted");
        }));
        assert!(accepted.is_poisoned());

        // Now verify drain_runs handles poisoned mutexes without panic
        drain_runs(&active, &accepted);

        // Verify cancel_and_wait_for_run handles poisoned mutexes without panic
        let outcome = cancel_and_wait_for_run(&active, &accepted, "nonexistent", Duration::ZERO);
        assert_eq!(outcome, CancelOutcome::NotFound);

        // Verify insertion into accepted_runs succeeds even when poisoned
        let mut guard = accepted.lock().unwrap_or_else(|p| p.into_inner());
        assert!(guard.insert("recovered".into()));
    }

    #[test]
    fn interactive_reservation_is_atomic_and_protects_participant_ids() {
        let accepted: AcceptedRuns = Arc::new(Mutex::new(HashSet::from(["busy".into()])));
        assert!(!reserve_run_ids(&accepted, &["pair", "submission", "busy"]));
        assert_eq!(*accepted.lock().unwrap(), HashSet::from(["busy".into()]));
        assert!(!reserve_run_ids(&accepted, &["duplicate", "duplicate"]));
        assert!(reserve_run_ids(
            &accepted,
            &["pair", "submission", "interactor"]
        ));
        assert!(!reserve_run_ids(&accepted, &["submission"]));
        release_run_ids(&accepted, &["pair", "submission", "interactor"]);
        assert!(reserve_run_ids(&accepted, &["submission"]));
        assert!(accepted.lock().unwrap().contains("busy"));
    }
}
