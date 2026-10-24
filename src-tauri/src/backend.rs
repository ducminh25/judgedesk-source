use std::ffi::OsStr;
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

const TREE_GUARD_REQUIRED_ENV: &str = "JUDGEDESK_TREE_GUARD_REQUIRED";
const TREE_GUARD_PATH_ENV: &str = "JUDGEDESK_TREE_GUARD_PATH";
const TREE_GUARD_GENERATION_ENV: &str = "JUDGEDESK_TREE_GUARD_GENERATION";

#[derive(Default)]
struct BackendProcessState {
    child: Option<CommandChild>,
    process_id: Option<u32>,
    embedded: bool,
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

#[derive(Clone)]
pub struct BackendSession {
    pub(crate) port: u16,
    pub(crate) token: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum BackendMode {
    NodeSidecar,
    ExperimentalRust,
}

fn backend_mode_from_env(value: Option<&OsStr>) -> std::io::Result<BackendMode> {
    let Some(value) = value else {
        return Ok(BackendMode::ExperimentalRust);
    };
    match value.to_str() {
        Some("1") => Ok(BackendMode::ExperimentalRust),
        Some(value) if value.eq_ignore_ascii_case("true") => Ok(BackendMode::ExperimentalRust),
        Some("0") => Ok(BackendMode::NodeSidecar),
        Some(value) if value.eq_ignore_ascii_case("false") => Ok(BackendMode::NodeSidecar),
        Some(_) | None => Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "JUDGEDESK_PURE_RUST_CORE must be unset, '1', 'true', '0', or 'false'",
        )),
    }
}

fn api_token_from_env(value: Option<&OsStr>) -> std::io::Result<Option<String>> {
    let Some(value) = value else {
        return Ok(None);
    };
    let Some(token) = value.to_str() else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "JUDGEDESK_API_TOKEN must be valid ASCII hex",
        ));
    };
    if token.len() != 64
        || !token
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "JUDGEDESK_API_TOKEN must be 64 lowercase hexadecimal characters",
        ));
    }
    Ok(Some(token.to_owned()))
}

#[cfg(debug_assertions)]
fn dev_state_path() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()?
        .parent()
        .map(|directory| directory.join("judgedesk-backend-state.json"))
}

#[cfg(debug_assertions)]
fn dev_state_contents(port: u16, token: &str) -> String {
    format!(
        "{{\"parentPid\":{},\"port\":{port},\"token\":\"{token}\"}}",
        std::process::id()
    )
}

#[cfg(debug_assertions)]
fn write_dev_state(port: u16, token: &str) {
    let Some(path) = dev_state_path() else {
        return;
    };
    if let Err(error) = fs::write(&path, dev_state_contents(port, token)) {
        eprintln!("Failed to write desktop dev backend state: {error}");
    }
}

#[cfg(not(debug_assertions))]
fn write_dev_state(_port: u16, _token: &str) {}

#[cfg(debug_assertions)]
fn clear_dev_state(port: u16) {
    let Some(path) = dev_state_path() else {
        return;
    };
    let prefix = format!("{{\"parentPid\":{},\"port\":{port}", std::process::id());
    if fs::read_to_string(&path)
        .ok()
        .is_some_and(|contents| contents.starts_with(&prefix))
    {
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

fn request_graceful_shutdown(session: &BackendSession) -> GracefulShutdownOutcome {
    let address = SocketAddr::from(([127, 0, 0, 1], session.port));
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
        "POST /api/shutdown HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nX-JudgeDesk-Session: {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        session.port, session.token
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

fn get_free_port() -> std::io::Result<u16> {
    TcpListener::bind("127.0.0.1:0")?
        .local_addr()
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

fn application_tree_guard(
    app: &App,
) -> Result<judgedesk_core::executor_client::TreeGuardContract, Box<dyn std::error::Error>> {
    let (path, generation) = app
        .state::<InstanceCoordinator>()
        .backend_tree_environment()
        .ok_or_else(|| std::io::Error::other("application process-tree guard is unavailable"))?;
    Ok(judgedesk_core::executor_client::TreeGuardContract::new(
        path, generation,
    )?)
}

fn launch_embedded_backend(
    port: u16,
    api_token: String,
    guard: judgedesk_core::executor_client::TreeGuardContract,
    log_path: Option<&Path>,
) -> Result<Option<u32>, Box<dyn std::error::Error>> {
    let identity = judgedesk_core::build_metadata::startup_log()?;
    if let Some(path) = log_path {
        append_log(path, &identity);
    }
    let (ready_tx, ready_rx) =
        std::sync::mpsc::sync_channel::<Result<(SocketAddr, Option<u32>), String>>(1);
    tauri::async_runtime::spawn(async move {
        match judgedesk_core::server::start_embedded_server_with_tree_guard_and_pid(
            port, guard, api_token,
        )
        .await
        {
            Ok((addr, executor_pid, task)) => {
                println!(
                    "[Tauri Shell] Pure Rust Native Core running directly on port {}",
                    addr.port()
                );
                let _ = ready_tx.send(Ok((addr, executor_pid)));
                let _ = task.await;
            }
            Err(error) => {
                let message =
                    format!("[Tauri Shell] Failed to start native embedded server: {error}");
                eprintln!("{message}");
                let _ = ready_tx.send(Err(message));
            }
        }
    });
    match ready_rx.recv_timeout(Duration::from_secs(10)) {
        Ok(Ok((_addr, executor_pid))) => Ok(executor_pid),
        Ok(Err(error)) => Err(std::io::Error::other(error).into()),
        Err(error) => Err(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            format!("timed out waiting for native embedded server to bind port {port}: {error}"),
        )
        .into()),
    }
}

pub fn spawn(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    let port = get_free_port()?;
    let configured_api_token =
        api_token_from_env(std::env::var_os("JUDGEDESK_API_TOKEN").as_deref())?;
    let api_token = match configured_api_token {
        Some(token) => token,
        None => crate::startup_guard::create_backend_startup_token()?,
    };
    let resource_dir = app.path().resource_dir()?;
    std::env::set_var("THEMIS_RESOURCE_DIR", &resource_dir);
    app.manage(BackendSession {
        port,
        token: api_token.clone(),
    });
    let log_path = backend_log_path(app);

    if let Some(path) = log_path.as_deref() {
        initialize_log(path, port, &resource_dir);
        println!("[Tauri Shell] Backend log: {}", path.display());
    }

    println!("[Tauri Shell] Allocating backend on port {}", port);

    let detected_bundle_type = match tauri::utils::platform::bundle_type() {
        Some(tauri::utils::config::BundleType::Deb) => Some("deb"),
        Some(tauri::utils::config::BundleType::Rpm) => Some("rpm"),
        Some(tauri::utils::config::BundleType::AppImage) => Some("appimage"),
        _ if cfg!(target_os = "linux") && std::env::var_os("APPIMAGE").is_some() => {
            Some("appimage")
        }
        _ => None,
    };
    if let Some(bundle_type) = detected_bundle_type {
        std::env::set_var("JUDGEDESK_BUNDLE_TYPE", bundle_type);
        if cfg!(target_os = "linux") && std::env::var_os("JUDGEDESK_DISTRIBUTION").is_none() {
            let edition = if judgedesk_core::toolchains::package_trust::is_linux_full_build() {
                "full"
            } else {
                "core"
            };
            std::env::set_var("JUDGEDESK_DISTRIBUTION", edition);
        }
    }

    let backend_mode =
        backend_mode_from_env(std::env::var_os("JUDGEDESK_PURE_RUST_CORE").as_deref())?;

    if backend_mode == BackendMode::ExperimentalRust {
        println!("[Tauri Shell] Launching Pure Rust Native Core embedded server on port {port}");
        std::env::set_var("THEMIS_RESOURCE_DIR", &resource_dir);
        let executor_pid = launch_embedded_backend(
            port,
            api_token.clone(),
            application_tree_guard(app)?,
            log_path.as_deref(),
        )?;
        let Some(pid) = executor_pid else {
            let _ = request_graceful_shutdown(&BackendSession {
                port,
                token: api_token,
            });
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "packaged native executor failed to start in embedded Rust mode",
            )
            .into());
        };
        #[cfg(any(windows, target_os = "macos", target_os = "linux"))]
        if let Err(error) = app.state::<InstanceCoordinator>().assign_backend(pid) {
            let _ = request_graceful_shutdown(&BackendSession {
                port,
                token: api_token,
            });
            return Err(error.into());
        }
        {
            let backend = app.state::<BackendSidecar>();
            let mut state = backend.state.lock().unwrap_or_else(|e| e.into_inner());
            state.embedded = true;
        }
        write_dev_state(port, &api_token);
        return Ok(());
    }

    let sidecar = app.shell().sidecar("server").map_err(|error| {
        std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("production backend sidecar is unavailable: {error}"),
        )
    })?;
    let sidecar = sidecar
        .env("PORT", port.to_string())
        .env("JUDGEDESK_API_TOKEN", &api_token)
        .env("JUDGEDESK_PARENT_PID", std::process::id().to_string())
        .env("THEMIS_RESOURCE_DIR", resource_dir);
    let sidecar = if let Some(bundle_type) = detected_bundle_type {
        sidecar.env("JUDGEDESK_BUNDLE_TYPE", bundle_type)
    } else {
        sidecar
    };
    let sidecar = if let Some((guard_path, generation)) = app
        .state::<InstanceCoordinator>()
        .backend_tree_environment()
    {
        sidecar
            .env(TREE_GUARD_REQUIRED_ENV, "1")
            .env(TREE_GUARD_PATH_ENV, guard_path)
            .env(TREE_GUARD_GENERATION_ENV, generation)
    } else {
        sidecar
    };
    let startup_token = crate::startup_guard::create_backend_startup_token()?;
    let sidecar = sidecar.env("JUDGEDESK_BOOTSTRAP_TOKEN", &startup_token);
    let (mut events, mut child) = sidecar.spawn().map_err(|error| {
        let message = format!("failed to spawn production backend sidecar: {error}");
        eprintln!("[Tauri Shell] {message}");
        if let Some(path) = log_path.as_deref() {
            append_log(path, &message);
        }
        std::io::Error::other(message)
    })?;

    let coordinator = app.state::<InstanceCoordinator>();
    if let Err(error) = coordinator.assign_backend(child.pid()) {
        let _ = child.kill();
        return Err(Box::new(error));
    }
    let gate_frame = format!("JUDGEDESK_START/1 {startup_token}\n");
    if let Err(error) = child.write(gate_frame.as_bytes()) {
        let _ = child.kill();
        return Err(Box::new(error));
    }

    let process_id = child.pid();
    {
        let backend = app.state::<BackendSidecar>();
        let mut state = backend.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.child.is_some() {
            let _ = child.kill();
            return Err("JudgeDesk backend is already running".into());
        }
        state.child = Some(child);
        state.process_id = Some(process_id);
    }
    write_dev_state(port, &api_token);
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
                    let mut state = backend.state.lock().unwrap_or_else(|e| e.into_inner());
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
        let mut state = backend.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.process_id == Some(process_id) {
            state.child.take();
            state.process_id = None;
            backend.terminated.notify_all();
        }
    });
    Ok(())
}

fn wait_for_termination(backend: &BackendSidecar, timeout: Duration) -> bool {
    let state = backend.state.lock().unwrap_or_else(|e| e.into_inner());
    if state.process_id.is_none() {
        return true;
    }
    let (state, _) = backend
        .terminated
        .wait_timeout_while(state, timeout, |state| state.process_id.is_some())
        .unwrap_or_else(|e| e.into_inner());
    state.process_id.is_none()
}

pub fn stop(app: &AppHandle) -> std::io::Result<()> {
    let session = app.try_state::<BackendSession>();
    let port = session.as_ref().map(|session| session.port);
    let backend = app.state::<BackendSidecar>();
    let (backend_is_running, is_embedded) = {
        let state = backend.state.lock().unwrap_or_else(|e| e.into_inner());
        (state.process_id.is_some() || state.embedded, state.embedded)
    };
    let graceful_outcome = if backend_is_running {
        session.as_deref().map_or(
            GracefulShutdownOutcome::Unavailable,
            request_graceful_shutdown,
        )
    } else {
        GracefulShutdownOutcome::Unavailable
    };
    if is_embedded {
        #[cfg(any(windows, target_os = "macos", target_os = "linux"))]
        {
            if graceful_outcome != GracefulShutdownOutcome::Completed {
                app.state::<InstanceCoordinator>()
                    .terminate_backend_tree(Duration::from_secs(5))?;
            }
            app.state::<InstanceCoordinator>()
                .wait_for_backend_tree(Duration::from_secs(2))?;
        }
        if let Some(port) = port {
            clear_dev_state(port);
        }
        return match graceful_outcome {
            GracefulShutdownOutcome::Rejected(error) => Err(std::io::Error::other(error)),
            GracefulShutdownOutcome::Completed | GracefulShutdownOutcome::Unavailable => Ok(()),
        };
    }
    let graceful_requested = graceful_outcome == GracefulShutdownOutcome::Completed;
    if !graceful_requested || !wait_for_termination(&backend, Duration::from_secs(2)) {
        #[cfg(any(windows, target_os = "macos", target_os = "linux"))]
        {
            app.state::<InstanceCoordinator>()
                .terminate_backend_tree(Duration::from_secs(5))?;
        }
        #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
        {
            let child = backend
                .state
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .child
                .take();
            if let Some(child) = child {
                if let Err(error) = child.kill() {
                    eprintln!("Failed to force-stop server sidecar: {error}");
                }
            }
        }
    }
    #[cfg(any(windows, target_os = "macos", target_os = "linux"))]
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
    app.state::<crate::announcements::AnnouncementService>()
        .stop();
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
        let preserve_result = judgedesk_core::toolchains::discovery::preserve_bundled_toolchains_in(
            &judgedesk_core::toolchains::discovery::get_app_data_dir(),
        );
        match (
            activation_result,
            stop_result,
            drain_result,
            preserve_result,
        ) {
            (Ok(()), Ok(()), Ok(()), Ok(_)) => Ok(()),
            (activation, backend, tree, preserve) => {
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
                if let Err(error) = preserve {
                    errors.push(format!("bundled toolchain preservation failed: {error}"));
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
    use super::{
        api_token_from_env, backend_mode_from_env, parse_shutdown_response, BackendMode,
        GracefulShutdownOutcome,
    };
    use std::ffi::OsStr;

    #[test]
    fn rust_backend_is_default_and_node_sidecar_requires_explicit_override() {
        assert_eq!(
            backend_mode_from_env(None).unwrap(),
            BackendMode::ExperimentalRust
        );
        assert_eq!(
            backend_mode_from_env(Some(OsStr::new("1"))).unwrap(),
            BackendMode::ExperimentalRust
        );
        assert_eq!(
            backend_mode_from_env(Some(OsStr::new("true"))).unwrap(),
            BackendMode::ExperimentalRust
        );
        assert_eq!(
            backend_mode_from_env(Some(OsStr::new("0"))).unwrap(),
            BackendMode::NodeSidecar
        );
        assert_eq!(
            backend_mode_from_env(Some(OsStr::new("false"))).unwrap(),
            BackendMode::NodeSidecar
        );
        for invalid in ["", "yes", "no", " true ", " false "] {
            assert!(backend_mode_from_env(Some(OsStr::new(invalid))).is_err());
        }
    }

    #[test]
    fn api_token_from_env_accepts_canonical_hex_and_rejects_invalid_values() {
        assert_eq!(api_token_from_env(None).unwrap(), None);
        let valid = "a0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde";
        assert_eq!(
            api_token_from_env(Some(OsStr::new(valid))).unwrap(),
            Some(valid.to_owned())
        );
        for invalid in [
            "",
            &"a".repeat(63),
            &"a".repeat(65),
            &"A".repeat(64),
            &"g".repeat(64),
        ] {
            assert!(api_token_from_env(Some(OsStr::new(invalid))).is_err());
        }
    }

    #[test]
    fn production_backend_source_has_no_port_or_experimental_fallback() {
        let source = include_str!("backend.rs");
        let spawn_source = source
            .split_once("pub fn spawn")
            .and_then(|(_, tail)| tail.split_once("fn wait_for_termination"))
            .map(|(body, _)| body)
            .expect("locate production backend spawn function");
        assert!(!spawn_source.contains("unwrap_or(3000)"));
        assert!(!spawn_source.contains("falling back to Pure Rust"));
        assert!(!spawn_source.contains("Sidecar server unavailable"));
    }

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
