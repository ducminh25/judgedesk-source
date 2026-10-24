//! Explicit local WebView spike. No production trust override, backend process or network source.
use serde_json::Value;
use tauri::Manager;
#[path = "../src/announcements/transport.rs"]
mod production_transport;

async fn https_probe() -> Result<(), Box<dyn std::error::Error>> {
    let trust: Value = serde_json::from_str(include_str!("../../shared/announcements-trust.json"))?;
    let url = trust["endpoint"].as_str().ok_or("endpoint")?;
    let response = production_transport::fetch(
        &production_transport::client()?,
        url,
        reqwest::header::HeaderMap::new(),
        1536 * 1024,
    )
    .await;
    let status = match response {
        Ok(production_transport::Download::Modified {
            bytes,
            etag,
            last_modified,
            content_type,
        }) => {
            println!(
                "HTTPS_PROBE_METADATA={}",
                serde_json::json!({"bodyBytes":bytes.len(), "etagPresent":etag.is_some(), "lastModifiedPresent":last_modified.is_some(), "contentType":content_type})
            );
            200
        }
        Ok(production_transport::Download::NotModified {
            etag,
            last_modified,
        }) => {
            println!(
                "HTTPS_PROBE_METADATA={}",
                serde_json::json!({"etagPresent":etag.is_some(),"lastModifiedPresent":last_modified.is_some()})
            );
            304
        }
        Err(production_transport::DownloadError::Status(status)) => status,
        Err(error) => return Err(error.into()),
    };
    println!(
        "ANNOUNCEMENT_HTTPS_QA={}",
        serde_json::json!({"tlsVerified":true,"endpointStatus":status,"feedReadinessVerified":false,"redirects":"disabled","automaticDecompression":false,"bodyLimit":1536*1024})
    );
    Ok(())
}

#[tauri::command]
fn qa_bytes() -> tauri::ipc::Response {
    tauri::ipc::Response::new(
        (0..4 * 1024 * 1024)
            .map(|index| (index % 251) as u8)
            .collect::<Vec<_>>(),
    )
}
#[tauri::command]
fn qa_png() -> tauri::ipc::Response {
    tauri::ipc::Response::new(
        include_bytes!("../../shared/test-fixtures/announcements/publisher-photo.png").to_vec(),
    )
}
#[tauri::command]
fn qa_resize(window: tauri::WebviewWindow, width: u32, height: u32) -> Result<(), String> {
    if !(640..=1600).contains(&width) || !(480..=1200).contains(&height) {
        return Err("QA viewport limits".into());
    }
    window
        .set_size(tauri::LogicalSize::new(f64::from(width), f64::from(height)))
        .map_err(|error| error.to_string())
}
#[tauri::command]
fn qa_report(app: tauri::AppHandle, report: Value) -> Result<(), String> {
    let raw = serde_json::to_string(&report).map_err(|_| "report")?;
    if raw.len() > 16384 {
        return Err("report limit".into());
    }
    println!("ANNOUNCEMENT_WEBVIEW_QA={raw}");
    app.exit(if report["passed"] == true { 0 } else { 1 });
    Ok(())
}
fn main() {
    if std::env::var_os("JUDGEDESK_ANNOUNCEMENTS_QA_TLS_ONLY").is_some() {
        let result = tokio::runtime::Runtime::new()
            .map_err(|error| error.to_string())
            .and_then(|runtime| {
                runtime
                    .block_on(https_probe())
                    .map_err(|error| error.to_string())
            });
        if let Err(error) = result {
            eprintln!("Announcement HTTPS probe failed: {error}");
            std::process::exit(1);
        }
        return;
    }
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows.clear();
    let result = tauri::Builder::default()
        .manage(themis_v2_lib::announcements::AnnouncementService::default())
        .invoke_handler(tauri::generate_handler![
            qa_bytes,
            qa_png,
            qa_resize,
            qa_report,
            themis_v2_lib::announcements::commands::announcements_snapshot,
        ])
        .setup(|app| {
            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App(
                    "docs/verification/admin-announcements/artifacts/native-qa.html".into(),
                ),
            )
            .title("JudgeDesk — Announcements native QA")
            .inner_size(1280.0, 800.0)
            .visible(std::env::var_os("JUDGEDESK_ANNOUNCEMENTS_QA_VISIBLE").is_some())
            .build()?;
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(45)).await;
                eprintln!("Native announcement QA timed out without a successful report");
                handle.exit(2);
            });
            Ok(())
        })
        .build(context);
    match result {
        Ok(app) => app.run(|handle, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                handle
                    .state::<themis_v2_lib::announcements::AnnouncementService>()
                    .stop();
            }
        }),
        Err(error) => {
            eprintln!("Native announcement QA failed: {error}");
            std::process::exit(1);
        }
    }
}
