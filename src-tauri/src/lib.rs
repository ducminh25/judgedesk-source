// ThemisV2 - Local Online Judge
// Tauri v2 entry point

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;

mod backend;
mod checker_sources;
mod contest_archive;
mod process_supervisor;
mod startup_guard;

pub fn try_run_internal_process_supervisor() -> Option<i32> {
    process_supervisor::try_run_internal_mode()
}

pub fn get_cli_contest_file() -> Option<String> {
    for arg in std::env::args_os().skip(1) {
        let path = std::path::PathBuf::from(&arg);
        if let Some(ext) = path.extension() {
            if ext.eq_ignore_ascii_case("judgedesk") {
                if let Ok(abs) = std::path::absolute(&path) {
                    if abs.is_file() {
                        return Some(abs.to_string_lossy().to_string());
                    }
                }
                if path.is_file() {
                    return Some(path.to_string_lossy().to_string());
                }
            }
        }
    }
    None
}

pub struct InitialContestFile(pub std::sync::Mutex<Option<String>>);

#[tauri::command]
fn get_backend_port(port: tauri::State<'_, backend::BackendPort>) -> u16 {
    port.0
}

#[tauri::command]
fn get_initial_contest_file(initial_file: tauri::State<'_, InitialContestFile>) -> Option<String> {
    initial_file.0.lock().ok()?.take()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();

    let initial_contest_file = get_cli_contest_file();
    #[cfg(desktop)]
    let instance_coordinator = match startup_guard::acquire(
        &context.config().identifier,
        initial_contest_file.as_deref(),
    ) {
        Ok(startup_guard::AcquireOutcome::Primary(coordinator)) => coordinator,
        Ok(startup_guard::AcquireOutcome::Secondary(
            startup_guard::SecondaryOutcome::Activated,
        )) => return,
        Ok(startup_guard::AcquireOutcome::Secondary(
            startup_guard::SecondaryOutcome::ActivationFailed(error),
        )) => {
            rfd::MessageDialog::new()
                .set_title("JudgeDesk is already running")
                .set_description(format!(
                    "JudgeDesk found the running instance but could not bring it to the front.\n\n{error}"
                ))
                .set_level(rfd::MessageLevel::Warning)
                .show();
            return;
        }
        Err(error) => {
            rfd::MessageDialog::new()
                .set_title("JudgeDesk startup error")
                .set_description(format!(
                    "JudgeDesk could not establish exclusive startup ownership.\n\n{error}"
                ))
                .set_level(rfd::MessageLevel::Error)
                .show();
            std::process::exit(70);
        }
    };
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder.manage(instance_coordinator);

    let app = builder
        .manage(InitialContestFile(std::sync::Mutex::new(
            initial_contest_file,
        )))
        .manage(backend::BackendSidecar::default())
        .manage(backend::UpdateHandoff::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            app.state::<startup_guard::InstanceCoordinator>()
                .attach(app.handle().clone())?;
            checker_sources::cleanup_checker_previews();
            contest_archive::cleanup_contest_workspaces();
            backend::spawn(app)
        })
        .invoke_handler(tauri::generate_handler![
            get_backend_port,
            get_initial_contest_file,
            backend::prepare_for_update,
            checker_sources::open_checker_source,
            contest_archive::open_contest_archive,
            contest_archive::save_contest_archive
        ])
        .build(context)
        .expect("error while building ThemisV2");

    app.run(|handle, event| {
        #[cfg(target_os = "macos")]
        if matches!(event, tauri::RunEvent::Reopen { .. }) {
            if let Err(error) = startup_guard::focus_primary(handle) {
                eprintln!("Failed to focus JudgeDesk after Dock reopen: {error}");
            }
        }
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = event {
            use tauri::Emitter;
            for url in urls {
                if let Ok(file_path) = url.to_file_path() {
                    if file_path
                        .extension()
                        .is_some_and(|ext| ext.eq_ignore_ascii_case("judgedesk"))
                    {
                        let _ = handle.emit("open_contest_file", file_path.to_string_lossy().to_string());
                    }
                }
            }
        }
        if matches!(event, tauri::RunEvent::Exit) {
            let coordinator = handle.state::<startup_guard::InstanceCoordinator>();
            let activation_stopped = match coordinator.begin_shutdown() {
                Ok(()) => true,
                Err(error) => {
                    eprintln!("Failed to quiesce JudgeDesk activation: {error}");
                    false
                }
            };
            let backend_stopped = match backend::stop(handle) {
                Ok(()) => true,
                Err(error) => {
                    eprintln!("Failed to confirm JudgeDesk backend shutdown: {error}");
                    false
                }
            };
            if activation_stopped && backend_stopped {
                if let Err(error) = coordinator.release() {
                    eprintln!("Failed to release JudgeDesk instance ownership: {error}");
                }
            } else {
                eprintln!(
                    "JudgeDesk retained its instance lease until process exit because shutdown was not fully verified"
                );
            }
        }
    });
}
