use std::fs::{self, OpenOptions};
use std::io::Write;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{App, AppHandle, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

#[derive(Default)]
pub struct BackendSidecar(Mutex<Option<CommandChild>>);

pub struct BackendPort(pub u16);

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
    let header = format!(
        "[Tauri Shell] Starting backend sidecar on port {port}\n[Tauri Shell] Resource directory: {}\n",
        resource_dir.display()
    );
    if let Err(error) = fs::write(log_path, header) {
        eprintln!("Failed to initialize backend log: {error}");
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
    let (mut events, child) = match sidecar
        .env("PORT", port.to_string())
        .env("THEMIS_RESOURCE_DIR", resource_dir)
        .spawn()
    {
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

    *app.state::<BackendSidecar>().0.lock().unwrap() = Some(child);
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
                    handle.state::<BackendSidecar>().0.lock().unwrap().take();
                    Some(message)
                }
                _ => None,
            };
            if let (Some(path), Some(message)) = (log_path.as_deref(), message) {
                append_log(path, &message);
            }
        }
    });
    Ok(())
}

pub fn stop(app: &AppHandle) {
    let child = app.state::<BackendSidecar>().0.lock().unwrap().take();
    if let Some(child) = child {
        if let Err(error) = child.kill() {
            eprintln!("Failed to stop server sidecar: {error}");
        }
    }
}
