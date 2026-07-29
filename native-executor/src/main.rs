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
    match std::env::args().nth(1).as_deref() {
        Some("--security-probe-child") => {
            security_probe_child();
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
                        // Keep every successfully-created child alive long enough for the
                        // executor to observe the process-count violation. A kernel process
                        // ceiling should make this branch happen almost immediately.
                        std::thread::sleep(std::time::Duration::from_millis(hold_ms));
                        break;
                    }
                }
            }
            for mut child in children {
                let _ = child.wait();
            }
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

fn security_probe_child() {
    use std::net::{SocketAddr, TcpStream};
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
    let (process_command, process_args): (&str, &[&str]) = if cfg!(windows) {
        ("cmd.exe", &["/c", "exit", "0"])
    } else {
        ("/bin/sh", &["-c", "exit 0"])
    };
    println!(
        "{}",
        serde_json::json!({
            "readBlocked": read_blocked,
            "writeBlocked": write_blocked,
            "networkBlocked": network_blocked,
            "processAttemptStarted": true,
        })
    );
    let _ = io::stdout().flush();
    let process_blocked = Command::new(process_command)
        .args(process_args)
        .status()
        .is_err();
    if !process_blocked {
        // The parent treats this reserved code as proof that a forbidden child really ran.
        std::process::exit(97);
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
