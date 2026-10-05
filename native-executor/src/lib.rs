#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used))]

#[cfg(feature = "executor")]
pub mod fault_trace;
#[cfg(all(feature = "executor", any(target_os = "macos", test)))]
pub(crate) mod guardian_io;
#[cfg(feature = "executor")]
pub mod guardian_protocol;
#[cfg(all(feature = "executor", any(target_os = "macos", test)))]
pub(crate) mod macos_interactive;
#[cfg(feature = "executor")]
pub mod macos_launcher;
#[cfg(feature = "executor")]
pub mod macos_process;
#[cfg(feature = "executor")]
pub mod macos_run_controller;
#[cfg(feature = "executor")]
pub mod macos_run_guardian;
#[cfg(all(feature = "executor", target_os = "macos"))]
pub mod macos_stdio;
#[cfg(feature = "executor")]
pub mod native_build;
#[cfg(feature = "executor")]
pub mod platform;
pub mod protocol;
pub mod request_validation;
#[cfg(feature = "executor")]
pub mod security_probe;
#[cfg(feature = "executor")]
pub mod tree_guard;
#[cfg(feature = "executor")]
pub mod workspace;

#[cfg(feature = "executor")]
pub fn try_run_internal_mode() -> Option<i32> {
    #[cfg(target_os = "macos")]
    {
        if let Some(exit_code) = macos_run_guardian::try_run_internal_mode() {
            return Some(exit_code);
        }
        if let Some(exit_code) = macos_launcher::try_run_internal_mode() {
            return Some(exit_code);
        }
    }

    match std::env::args().nth(1).as_deref() {
        Some("--security-probe-child") => {
            security_probe::security_probe_child();
            Some(0)
        }
        #[cfg(target_os = "macos")]
        Some("--security-pgroup-spawn-child") => Some(0),
        _ => None,
    }
}
