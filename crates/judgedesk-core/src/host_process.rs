//! Environment and lifecycle policy for host desktop tools, never student code.
use std::ffi::OsStr;
use std::process::Command;

pub fn command(program: impl AsRef<OsStr>) -> Result<Command, String> {
    let command = Command::new(program);
    #[cfg(target_os = "linux")]
    let command = {
        let mut command = command;
        configure_linux_environment(&mut command, &std::env::vars_os().collect())?;
        command
    };
    Ok(command)
}

#[cfg(target_os = "linux")]
fn configure_linux_environment(
    command: &mut Command,
    environment: &std::collections::BTreeMap<std::ffi::OsString, std::ffi::OsString>,
) -> Result<(), String> {
    let snapshot = environment
        .get(OsStr::new("JUDGEDESK_HOST_ENV_VERSION"))
        .is_some_and(|v| v == "1");
    let appdir = environment.get(OsStr::new("APPDIR"));
    if !snapshot && appdir.is_none() && !environment.contains_key(OsStr::new("APPIMAGE")) {
        return Ok(());
    }
    let keys: Vec<String> =
        serde_json::from_str(include_str!("../../../shared/linux-host-environment.json"))
            .map_err(|e| format!("Invalid host environment contract: {e}"))?;
    for key in keys {
        let saved = format!("JUDGEDESK_HOST_{key}");
        let flag = format!("{saved}_SET");
        if snapshot {
            match environment.get(OsStr::new(&flag)).and_then(|v| v.to_str()) {
                Some("1") => {
                    let value = environment
                        .get(OsStr::new(&saved))
                        .ok_or_else(|| format!("Missing original host variable {key}"))?;
                    command.env(&key, value);
                }
                Some("0") => {
                    command.env_remove(&key);
                }
                _ => return Err(format!("Invalid original host variable marker for {key}")),
            }
        } else if key == "PATH" {
            // Compatibility with launches without our AppRun snapshot: remove
            // only bundle paths, leaving the host executable search order intact.
            if let (Some(root), Some(path)) = (appdir, environment.get(OsStr::new("PATH"))) {
                let paths: Vec<_> = std::env::split_paths(path)
                    .filter(|p| !p.starts_with(root))
                    .collect();
                command.env(
                    "PATH",
                    std::env::join_paths(paths).map_err(|e| e.to_string())?,
                );
            }
        } else {
            command.env_remove(&key);
        }
        command.env_remove(saved).env_remove(flag);
    }
    for name in [
        "APPDIR",
        "APPIMAGE",
        "ARGV0",
        "OWD",
        "JUDGEDESK_HOST_ENV_VERSION",
    ] {
        command.env_remove(name);
    }
    Ok(())
}

/// Observe early launch failures without waiting for a long-lived desktop app.
/// "Launched" is a process handoff, never a guarantee that a window was drawn.
pub fn launch_desktop(mut command: Command) -> Result<(), String> {
    use std::io::Read;
    use std::process::Stdio;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn desktop viewer: {e}"))?;
    let stderr = Arc::new(Mutex::new(Vec::<u8>::new()));
    if let Some(mut pipe) = child.stderr.take() {
        let collected = Arc::clone(&stderr);
        std::thread::spawn(move || {
            let mut buffer = [0u8; 4096];
            while let Ok(size) = pipe.read(&mut buffer) {
                if size == 0 {
                    break;
                }
                let mut bytes = collected.lock().unwrap_or_else(|p| p.into_inner());
                let take = size.min(16_384usize.saturating_sub(bytes.len()));
                bytes.extend_from_slice(&buffer[..take]);
                // Continue draining after the bound so a noisy viewer cannot block.
            }
        });
    }
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_millis(250);
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    let result = if status.success() {
                        Ok(())
                    } else {
                        let bytes = stderr.lock().unwrap_or_else(|p| p.into_inner());
                        Err(format!(
                            "Desktop viewer exited with {status}: {}",
                            String::from_utf8_lossy(&bytes).trim()
                        ))
                    };
                    let _ = sender.send(result);
                    return;
                }
                Err(error) => {
                    let _ = sender.send(Err(format!("Cannot observe desktop viewer: {error}")));
                    let _ = child.wait();
                    return;
                }
                Ok(None) if Instant::now() >= deadline => {
                    let _ = sender.send(Ok(()));
                    if let Ok(status) = child.wait() {
                        if !status.success() {
                            eprintln!("Desktop viewer later exited with {status}");
                        }
                    }
                    return;
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            }
        }
    });
    receiver
        .recv()
        .map_err(|e| format!("Desktop viewer observer stopped: {e}"))?
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "linux")]
    use super::*;
    #[cfg(target_os = "linux")]
    use std::collections::BTreeMap;
    #[cfg(target_os = "linux")]
    use std::ffi::OsString;

    #[cfg(target_os = "linux")]
    #[test]
    fn host_commands_restore_original_values_without_changing_session_variables() {
        let keys: Vec<String> =
            serde_json::from_str(include_str!("../../../shared/linux-host-environment.json"))
                .expect("contract");
        let mut environment = BTreeMap::<OsString, OsString>::new();
        environment.insert("JUDGEDESK_HOST_ENV_VERSION".into(), "1".into());
        for key in keys {
            environment.insert(format!("JUDGEDESK_HOST_{key}_SET").into(), "0".into());
        }
        environment.insert("JUDGEDESK_HOST_PATH_SET".into(), "1".into());
        environment.insert("JUDGEDESK_HOST_PATH".into(), "/usr/bin:/bin".into());
        environment.insert("JUDGEDESK_HOST_LD_LIBRARY_PATH_SET".into(), "1".into());
        environment.insert(
            "JUDGEDESK_HOST_LD_LIBRARY_PATH".into(),
            "/host/custom path".into(),
        );
        let mut command = Command::new("/usr/bin/env");
        command
            .envs(environment.clone())
            .env("GTK_PATH", "/bundle/gtk")
            .env("DISPLAY", ":0")
            .env("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/bus");
        configure_linux_environment(&mut command, &environment).expect("restore");
        let output = command.output().expect("environment probe");
        let values = String::from_utf8(output.stdout).expect("utf8");
        assert!(values.contains("LD_LIBRARY_PATH=/host/custom path\n"));
        assert!(!values.contains("GTK_PATH="));
        assert!(!values.contains("JUDGEDESK_HOST_"));
        assert!(values.contains("DISPLAY=:0\n"));
        assert!(values.contains("DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/bus\n"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn viewer_early_failure_is_reported_but_long_lived_viewer_does_not_block() {
        let mut bad = Command::new("/bin/sh");
        bad.args(["-c", "printf 'loader failed' >&2; exit 1"]);
        assert!(launch_desktop(bad)
            .expect_err("early failure")
            .contains("exited"));
        let mut handoff = Command::new("/bin/sh");
        handoff.args(["-c", "exit 0"]);
        launch_desktop(handoff).expect("successful handoff");
        let mut viewer = Command::new("/bin/sleep");
        viewer.arg("0.5");
        let started = std::time::Instant::now();
        launch_desktop(viewer).expect("long lived viewer");
        assert!(started.elapsed() < std::time::Duration::from_millis(450));
    }
}
