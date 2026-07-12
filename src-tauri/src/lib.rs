// ThemisV2 - Local Online Judge
// Tauri v2 Entry Point

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandEvent;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // Spawn the backend server sidecar
            let (mut rx, _child) = app
                .shell()
                .sidecar("server")
                .expect("failed to create `server` binary command")
                .spawn()
                .expect("failed to spawn server sidecar");

            // Handle output in a separate task
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    if let CommandEvent::Stdout(line_bytes) = event {
                        let line = String::from_utf8_lossy(&line_bytes);
                        println!("Server: {}", line);
                    }
                }
            });

            // In debug builds, open DevTools automatically
            #[cfg(debug_assertions)]
            {
                let window = app.get_webview_window("main").unwrap();
                window.open_devtools();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running ThemisV2");
}
