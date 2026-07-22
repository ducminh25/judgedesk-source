use judgedesk_native_executor::platform::{ActiveRuns, Platform};
use judgedesk_native_executor::protocol::{
    read_frame, write_frame, ExecutorRequest, ExecutorResponse,
};
use judgedesk_native_executor::request_validation::validate_run;
use std::collections::{HashMap, HashSet};
use std::io::{self, Write};
use std::sync::{Arc, Mutex};

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

    let checkpoint = |phase: &str| {
        let _ = writeln!(io::stderr(), "security-probe:{phase}");
        let _ = io::stderr().flush();
    };
    checkpoint("started");
    let sentinel = std::env::args()
        .nth(2)
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::var_os("JUDGEDESK_PROBE_SENTINEL").map(std::path::PathBuf::from));
    let read_blocked = sentinel
        .as_ref()
        .is_some_and(|path| std::fs::read(path).is_err());
    checkpoint("read-checked");
    let write_blocked = sentinel
        .as_ref()
        .is_some_and(|path| std::fs::write(path, b"OVERWRITTEN").is_err());
    checkpoint("write-checked");
    let address: SocketAddr = "127.0.0.1:9".parse().unwrap();
    let network_blocked = std::panic::catch_unwind(|| {
        let network_error = TcpStream::connect_timeout(&address, Duration::from_millis(500)).err();
        network_error.as_ref().is_some_and(|error| {
            error.kind() == std::io::ErrorKind::PermissionDenied
                || matches!(error.raw_os_error(), Some(13 | 10013 | 10107))
        })
    })
    .unwrap_or(true);
    checkpoint("network-checked");
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
    let platform = Arc::new(Platform::initialize());
    let active: ActiveRuns = Arc::new(Mutex::new(HashMap::new()));
    let accepted_runs = Arc::new(Mutex::new(HashSet::<String>::new()));
    let writer = Arc::new(Mutex::new(io::stdout()));
    let mut reader = io::stdin();

    while let Some(frame) = read_frame(&mut reader).map_err(|error| error.to_string())? {
        let request: ExecutorRequest = match serde_json::from_slice(&frame) {
            Ok(request) => request,
            Err(error) => {
                send(
                    &writer,
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
                    &writer,
                    ExecutorResponse::Health {
                        id,
                        health: platform.health(),
                    },
                )?;
            }
            ExecutorRequest::Run { id, spec } => {
                if !platform.health().ready {
                    send(
                        &writer,
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
                            &writer,
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
                        &writer,
                        ExecutorResponse::Error {
                            id,
                            code: "SECURE_RUNNER_INVALID_REQUEST".into(),
                            message: "duplicate runId".into(),
                        },
                    )?;
                    continue;
                }
                let platform = Arc::clone(&platform);
                let active = Arc::clone(&active);
                let accepted_runs = Arc::clone(&accepted_runs);
                let writer = Arc::clone(&writer);
                std::thread::spawn(move || {
                    let result = platform.run(&spec, &validated, &active);
                    accepted_runs.lock().unwrap().remove(&spec.run_id);
                    let _ = send(&writer, ExecutorResponse::RunResult { id, result });
                });
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
                    &writer,
                    ExecutorResponse::CancelResult {
                        id,
                        run_id,
                        cancelled,
                    },
                )?;
            }
            ExecutorRequest::Shutdown { id } => {
                platform.shutdown(&active);
                send(&writer, ExecutorResponse::ShutdownResult { id })?;
                return Ok(());
            }
        }
    }
    platform.shutdown(&active);
    Ok(())
}

fn send(writer: &Arc<Mutex<io::Stdout>>, response: ExecutorResponse) -> Result<(), String> {
    write_frame(&mut *writer.lock().unwrap(), &response).map_err(|error| error.to_string())
}
