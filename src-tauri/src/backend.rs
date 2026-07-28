use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex};
use std::time::Duration;
use tauri::{App, AppHandle, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

use crate::startup_guard::InstanceCoordinator;

#[derive(Default)]
struct BackendProcessState {
    child: Option<CommandChild>,
    process_id: Option<u32>,
}

#[derive(Default)]
pub struct BackendSidecar {
    state: Mutex<BackendProcessState>,
    terminated: Condvar,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
enum UpdatePreparationState {
    #[default]
    Running,
    Preparing,
    Prepared,
    Failed,
}

#[derive(Default)]
pub struct UpdateHandoff {
    state: Mutex<UpdatePreparationState>,
}

pub struct BackendPort(pub u16);

#[cfg(debug_assertions)]
fn dev_state_path() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()?
        .parent()
        .map(|directory| directory.join("judgedesk-backend-state.json"))
}

#[cfg(debug_assertions)]
fn dev_state_contents(port: u16) -> String {
    format!("{{\"parentPid\":{},\"port\":{port}}}", std::process::id())
}

#[cfg(debug_assertions)]
fn write_dev_state(port: u16) {
    let Some(path) = dev_state_path() else {
        return;
    };
    if let Err(error) = fs::write(&path, dev_state_contents(port)) {
        eprintln!("Failed to write desktop dev backend state: {error}");
    }
}

#[cfg(not(debug_assertions))]
fn write_dev_state(_port: u16) {}

#[cfg(debug_assertions)]
fn clear_dev_state(port: u16) {
    let Some(path) = dev_state_path() else {
        return;
    };
    if fs::read_to_string(&path).ok().as_deref() == Some(dev_state_contents(port).as_str()) {
        let _ = fs::remove_file(path);
    }
}

#[cfg(not(debug_assertions))]
fn clear_dev_state(_port: u16) {}

const MAX_SHUTDOWN_RESPONSE_BYTES: u64 = 8 * 1024;

#[derive(Debug, Eq, PartialEq)]
enum GracefulShutdownOutcome {
    Completed,
    Unavailable,
    Rejected(String),
}

fn parse_shutdown_response(response: &[u8]) -> GracefulShutdownOutcome {
    let Some(header_end) = response.windows(4).position(|window| window == b"\r\n\r\n") else {
        return GracefulShutdownOutcome::Rejected(
            "backend shutdown returned a malformed HTTP response".to_owned(),
        );
    };
    let header = &response[..header_end];
    let status_line_end = header
        .windows(2)
        .position(|window| window == b"\r\n")
        .unwrap_or(header.len());
    let status_line = String::from_utf8_lossy(&header[..status_line_end]);
    let successful_status =
        status_line.starts_with("HTTP/1.1 200 ") || status_line.starts_with("HTTP/1.0 200 ");
    let body = &response[header_end + 4..];
    let acknowledged = serde_json::from_slice::<serde_json::Value>(body)
        .ok()
        .is_some_and(|value| value == serde_json::json!({ "success": true }));
    if successful_status && acknowledged {
        GracefulShutdownOutcome::Completed
    } else {
        GracefulShutdownOutcome::Rejected(format!(
            "backend shutdown was not acknowledged: {}",
            status_line.trim()
        ))
    }
}

fn request_graceful_shutdown(port: u16) -> GracefulShutdownOutcome {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, std::time::Duration::from_secs(1))
    else {
        return GracefulShutdownOutcome::Unavailable;
    };
    if let Err(error) = stream.set_read_timeout(Some(std::time::Duration::from_secs(30))) {
        return GracefulShutdownOutcome::Rejected(format!(
            "backend shutdown read timeout could not be configured: {error}"
        ));
    }
    if let Err(error) = stream.set_write_timeout(Some(std::time::Duration::from_secs(2))) {
        return GracefulShutdownOutcome::Rejected(format!(
            "backend shutdown write timeout could not be configured: {error}"
        ));
    }
    let request = format!(
        "POST /api/shutdown HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    if let Err(error) = stream.write_all(request.as_bytes()) {
        return GracefulShutdownOutcome::Rejected(format!(
            "backend shutdown request could not be written: {error}"
        ));
    }
    let mut response = Vec::new();
    match stream
        .take(MAX_SHUTDOWN_RESPONSE_BYTES + 1)
        .read_to_end(&mut response)
    {
        Ok(_) if response.len() as u64 <= MAX_SHUTDOWN_RESPONSE_BYTES => {
            parse_shutdown_response(&response)
        }
        Ok(_) => GracefulShutdownOutcome::Rejected(
            "backend shutdown response exceeded its size limit".to_owned(),
        ),
        Err(error) => GracefulShutdownOutcome::Rejected(format!(
            "backend shutdown response could not be read: {error}"
        )),
    }
}

fn get_free_port() -> Option<u16> {
    TcpListener::bind("127.0.0.1:0")
        .ok()
        .and_then(|listener| listener.local_addr().ok())
        .map(|addr| addr.port())
}

fn initialize_log(log_path: &Path, port: u16, resource_dir: &Path) {
    if let Some(parent) = log_path.parent() {
        if let Err(error) = fs::create_dir_all(parent) {
            eprintln!("Failed to create backend log directory: {error}");
            return;
        }
    }
    // Keep previous sessions so restarting the app does not erase the crash
    // signal that explains why the preceding backend disappeared.
    match OpenOptions::new().create(true).append(true).open(log_path) {
        Ok(mut file) => {
            if let Err(error) = writeln!(
                file,
                "\n[Tauri Shell] Starting backend sidecar on port {port}\n[Tauri Shell] Resource directory: {}",
                resource_dir.display()
            ) {
                eprintln!("Failed to initialize backend log: {error}");
            }
        }
        Err(error) => eprintln!("Failed to initialize backend log: {error}"),
    }
}

fn append_log(log_path: &Path, message: &str) {
    match OpenOptions::new().create(true).append(true).open(log_path) {
        Ok(mut file) => {
            if let Err(error) = writeln!(file, "{message}") {
                eprintln!("Failed to write backend log: {error}");
            }
        }
        Err(error) => eprintln!("Failed to open backend log: {error}"),
    }
}

fn backend_log_path(app: &App) -> Option<PathBuf> {
    app.path()
        .app_log_dir()
        .ok()
        .map(|directory| directory.join("backend.log"))
}

pub fn spawn(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    let port = get_free_port().unwrap_or(3000);
    let resource_dir = app.path().resource_dir()?;
    app.manage(BackendPort(port));
    let log_path = backend_log_path(app);

    if let Some(path) = log_path.as_deref() {
        initialize_log(path, port, &resource_dir);
        println!("[Tauri Shell] Backend log: {}", path.display());
    }

    println!("[Tauri Shell] Allocating backend sidecar on port {}", port);
    let sidecar = match app.shell().sidecar("server") {
        Ok(command) => command,
        Err(error) => {
            let message =
                format!("[Tauri Shell] Failed to create backend sidecar command: {error}");
            eprintln!("{message}");
            if let Some(path) = log_path.as_deref() {
                append_log(path, &message);
            }
            return Ok(());
        }
    };
    let sidecar = sidecar
        .env("PORT", port.to_string())
        .env("JUDGEDESK_PARENT_PID", std::process::id().to_string())
        .env("THEMIS_RESOURCE_DIR", resource_dir);
    let startup_token = crate::startup_guard::create_backend_startup_token()?;
    let sidecar = sidecar.env("JUDGEDESK_BOOTSTRAP_TOKEN", &startup_token);
    let spawn_result = sidecar.spawn();
    let (mut events, mut child) = match spawn_result {
        Ok(process) => process,
        Err(error) => {
            let message = format!("[Tauri Shell] Failed to spawn backend sidecar: {error}");
            eprintln!("{message}");
            if let Some(path) = log_path.as_deref() {
                append_log(path, &message);
            }
            return Ok(());
        }
    };

    #[cfg(windows)]
    {
        let coordinator = app.state::<InstanceCoordinator>();
        if let Err(error) = coordinator.assign_backend(child.pid()) {
            let _ = child.kill();
            return Err(Box::new(error));
        }
    }
    let gate_frame = format!("JUDGEDESK_START/1 {startup_token}\n");
    if let Err(error) = child.write(gate_frame.as_bytes()) {
        let _ = child.kill();
        return Err(Box::new(error));
    }

    let process_id = child.pid();
    {
        let backend = app.state::<BackendSidecar>();
        let mut state = backend.state.lock().unwrap();
        if state.child.is_some() {
            let _ = child.kill();
            return Err("JudgeDesk backend is already running".into());
        }
        state.child = Some(child);
        state.process_id = Some(process_id);
    }
    write_dev_state(port);
    let handle = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            let message = match event {
                CommandEvent::Stdout(bytes) => {
                    let message = format!("Server: {}", String::from_utf8_lossy(&bytes));
                    println!("{message}");
                    Some(message)
                }
                CommandEvent::Stderr(bytes) => {
                    let message = format!("Server error: {}", String::from_utf8_lossy(&bytes));
                    eprintln!("{message}");
                    Some(message)
                }
                CommandEvent::Error(error) => {
                    let message = format!("Server sidecar error: {error}");
                    eprintln!("{message}");
                    Some(message)
                }
                CommandEvent::Terminated(payload) => {
                    let message = format!(
                        "Server sidecar terminated: code={:?}, signal={:?}",
                        payload.code, payload.signal
                    );
                    println!("{message}");
                    let backend = handle.state::<BackendSidecar>();
                    let mut state = backend.state.lock().unwrap();
                    if state.process_id == Some(process_id) {
                        state.child.take();
                        state.process_id = None;
                        backend.terminated.notify_all();
                    }
                    clear_dev_state(port);
                    Some(message)
                }
                _ => None,
            };
            if let (Some(path), Some(message)) = (log_path.as_deref(), message) {
                append_log(path, &message);
            }
        }
        let backend = handle.state::<BackendSidecar>();
        let mut state = backend.state.lock().unwrap();
        if state.process_id == Some(process_id) {
            state.child.take();
            state.process_id = None;
            backend.terminated.notify_all();
        }
    });
    Ok(())
}

fn wait_for_termination(backend: &BackendSidecar, timeout: Duration) -> bool {
    let state = backend.state.lock().unwrap();
    if state.process_id.is_none() {
        return true;
    }
    let (state, _) = backend
        .terminated
        .wait_timeout_while(state, timeout, |state| state.process_id.is_some())
        .unwrap();
    state.process_id.is_none()
}

pub fn stop(app: &AppHandle) -> std::io::Result<()> {
    let port = app.try_state::<BackendPort>().map(|port| port.0);
    let backend = app.state::<BackendSidecar>();
    let backend_is_running = backend.state.lock().unwrap().process_id.is_some();
    let graceful_outcome = if backend_is_running {
        port.map_or(
            GracefulShutdownOutcome::Unavailable,
            request_graceful_shutdown,
        )
    } else {
        GracefulShutdownOutcome::Unavailable
    };
    let graceful_requested = graceful_outcome == GracefulShutdownOutcome::Completed;
    if !graceful_requested || !wait_for_termination(&backend, Duration::from_secs(2)) {
        #[cfg(windows)]
        {
            app.state::<InstanceCoordinator>()
                .terminate_backend_tree(Duration::from_secs(5))?;
        }
        #[cfg(not(windows))]
        {
            let child = backend.state.lock().unwrap().child.take();
            if let Some(child) = child {
                if let Err(error) = child.kill() {
                    eprintln!("Failed to force-stop server sidecar: {error}");
                }
            }
        }
    }
    #[cfg(windows)]
    app.state::<InstanceCoordinator>()
        .wait_for_backend_tree(Duration::from_secs(2))?;
    if !wait_for_termination(&backend, Duration::from_secs(5)) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "backend sidecar did not terminate before JudgeDesk exit",
        ));
    }
    if let Some(port) = port {
        clear_dev_state(port);
    }
    match graceful_outcome {
        GracefulShutdownOutcome::Rejected(error) => Err(std::io::Error::other(error)),
        GracefulShutdownOutcome::Completed | GracefulShutdownOutcome::Unavailable => Ok(()),
    }
}

#[tauri::command]
pub async fn prepare_for_update(
    app: AppHandle,
    handoff: tauri::State<'_, UpdateHandoff>,
) -> Result<(), String> {
    {
        let mut state = handoff
            .state
            .lock()
            .map_err(|_| "update handoff state is unavailable".to_owned())?;
        match *state {
            UpdatePreparationState::Running => *state = UpdatePreparationState::Preparing,
            UpdatePreparationState::Prepared => return Ok(()),
            UpdatePreparationState::Preparing => {
                return Err("update handoff is already in progress".to_owned());
            }
            UpdatePreparationState::Failed => {
                return Err(
                    "update handoff previously failed; restart JudgeDesk before retrying"
                        .to_owned(),
                );
            }
        }
    }

    let result = match tauri::async_runtime::spawn_blocking(move || {
        let activation_result = app.state::<InstanceCoordinator>().begin_shutdown();
        let stop_result = stop(&app);
        let drain_result = app.state::<InstanceCoordinator>().shutdown_backend_tree();
        match (activation_result, stop_result, drain_result) {
            (Ok(()), Ok(()), Ok(())) => Ok(()),
            (activation, backend, tree) => {
                let mut errors = Vec::new();
                if let Err(error) = activation {
                    errors.push(format!("activation shutdown failed: {error}"));
                }
                if let Err(error) = backend {
                    errors.push(format!("backend shutdown failed: {error}"));
                }
                if let Err(error) = tree {
                    errors.push(format!("backend process-tree drain failed: {error}"));
                }
                Err(errors.join("; "))
            }
        }
    })
    .await
    {
        Ok(result) => result,
        Err(error) => Err(format!("update shutdown task failed: {error}")),
    };

    if let Ok(mut state) = handoff.state.lock() {
        *state = if result.is_ok() {
            UpdatePreparationState::Prepared
        } else {
            UpdatePreparationState::Failed
        };
    } else {
        return Err("update handoff state became unavailable".to_owned());
    }
    result
}

#[cfg(test)]
mod tests {
    use super::{parse_shutdown_response, GracefulShutdownOutcome};

    #[test]
    fn shutdown_response_requires_a_success_status_and_body_acknowledgement() {
        assert_eq!(
            parse_shutdown_response(
                b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"success\":true}"
            ),
            GracefulShutdownOutcome::Completed
        );
        assert!(matches!(
            parse_shutdown_response(
                b"HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\n\r\n{\"success\":false}"
            ),
            GracefulShutdownOutcome::Rejected(_)
        ));
        assert!(matches!(
            parse_shutdown_response(
                b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"success\":false}"
            ),
            GracefulShutdownOutcome::Rejected(_)
        ));
        assert!(matches!(
            parse_shutdown_response(
                b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"message\":\"\\\"success\\\":true\"}"
            ),
            GracefulShutdownOutcome::Rejected(_)
        ));
        assert!(matches!(
            parse_shutdown_response(
                b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"success\":true,\"extra\":1}"
            ),
            GracefulShutdownOutcome::Rejected(_)
        ));
    }

    #[test]
    fn shutdown_response_rejects_malformed_http() {
        assert!(matches!(
            parse_shutdown_response(b"not-http"),
            GracefulShutdownOutcome::Rejected(_)
        ));
    }
}
