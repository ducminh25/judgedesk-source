// ThemisV2 - Local Online Judge
// Tauri v2 entry point

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backend;
mod checker_sources;
mod contest_archive;

#[tauri::command]
fn get_backend_port(port: tauri::State<'_, backend::BackendPort>) -> u16 {
    port.0
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(backend::BackendSidecar::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            checker_sources::cleanup_checker_previews();
            contest_archive::cleanup_contest_workspaces();
            backend::spawn(app)
        })
        .invoke_handler(tauri::generate_handler![
            get_backend_port,
            checker_sources::open_checker_source,
            contest_archive::open_contest_archive,
            contest_archive::save_contest_archive
        ])
        .build(tauri::generate_context!())
        .expect("error while building ThemisV2");

    app.run(|handle, event| {
        if matches!(
            event,
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
        ) {
            backend::stop(handle);
        }
    });
}
