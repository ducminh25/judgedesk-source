use std::net::TcpListener;
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

pub fn spawn(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    let port = get_free_port().unwrap_or(3000);
    let resource_dir = app.path().resource_dir()?;
    app.manage(BackendPort(port));

    println!("[Tauri Shell] Allocating backend sidecar on port {}", port);
    let (mut events, child) = app
        .shell()
        .sidecar("server")?
        .env("PORT", port.to_string())
        .env("THEMIS_RESOURCE_DIR", resource_dir)
        .spawn()?;

    *app.state::<BackendSidecar>().0.lock().unwrap() = Some(child);
    let handle = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    println!("Server: {}", String::from_utf8_lossy(&bytes));
                }
                CommandEvent::Stderr(bytes) => {
                    eprintln!("Server error: {}", String::from_utf8_lossy(&bytes));
                }
                CommandEvent::Error(error) => {
                    eprintln!("Server sidecar error: {error}");
                }
                CommandEvent::Terminated(payload) => {
                    println!(
                        "Server sidecar terminated: code={:?}, signal={:?}",
                        payload.code, payload.signal
                    );
                    handle.state::<BackendSidecar>().0.lock().unwrap().take();
                }
                _ => {}
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
