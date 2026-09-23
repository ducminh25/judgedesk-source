// ThemisV2 - Desktop Entry Point
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Some(exit_code) = themis_v2_lib::try_run_internal_process_supervisor() {
        std::process::exit(exit_code);
    }
    if let Some(exit_code) = judgedesk_native_executor::try_run_internal_mode() {
        std::process::exit(exit_code);
    }
    themis_v2_lib::run()
}
