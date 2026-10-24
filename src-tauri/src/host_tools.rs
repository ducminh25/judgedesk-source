use tauri::AppHandle;
#[cfg(not(target_os = "linux"))]
use tauri_plugin_opener::OpenerExt;

fn validate_external_url(url: &str) -> Result<(), String> {
    // Reuse the exact capability allowlist rather than giving a custom command
    // broader permissions than the opener plugin it replaces on Linux.
    let capability: serde_json::Value =
        serde_json::from_str(include_str!("../capabilities/default.json"))
            .map_err(|error| format!("Invalid opener capability: {error}"))?;
    let allowed = capability["permissions"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|permission| permission["identifier"] == "opener:allow-open-url")
        .flat_map(|permission| permission["allow"].as_array().into_iter().flatten())
        .any(|entry| entry["url"].as_str() == Some(url));
    if !allowed {
        return Err("External URL is outside the opener capability".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn open_external_url(_app: AppHandle, url: String) -> Result<(), String> {
    validate_external_url(&url)?;
    launch_external_url(_app, url).await
}

/// Internal launcher; callers must establish their own narrow URL authority first.
pub(crate) async fn launch_external_url(_app: AppHandle, url: String) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let mut command = judgedesk_core::host_process::command("xdg-open")?;
        command.arg(url);
        tauri::async_runtime::spawn_blocking(move || {
            judgedesk_core::host_process::launch_desktop(command)
        })
        .await
        .map_err(|error| error.to_string())?
    }
    #[cfg(not(target_os = "linux"))]
    _app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn host_url_opener_preserves_capability_scope() {
        assert!(validate_external_url("https://github.com/ducminh25/judgedesk").is_ok());
        for url in [
            "file:///etc/passwd",
            "https://github.com/ducminh25/judgedesk;touch /tmp/marker",
            "https://example.com",
            "javascript:alert(1)",
        ] {
            assert!(validate_external_url(url).is_err());
        }
    }
}
