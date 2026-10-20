use std::collections::HashMap;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::json;
use tokio::sync::broadcast::error::RecvError;
use tokio_stream::wrappers::UnboundedReceiverStream;

pub use crate::osd::ProblemResultForLog;
use crate::server::state::AppState;

#[derive(Deserialize, Default)]
pub struct OsdStartPayload {
    #[serde(rename = "osdPath", default)]
    pub osd_path: Option<String>,
    #[serde(rename = "contestantsPath", default)]
    pub contestants_path: Option<String>,
    #[serde(rename = "testPath", default)]
    pub test_path: Option<String>,
    #[serde(rename = "enableLog", default)]
    pub enable_log: Option<bool>,
    #[serde(rename = "problemConfigs", default)]
    pub problem_configs: HashMap<String, serde_json::Value>,
}

pub async fn handle_osd_status(State(state): State<AppState>) -> Response {
    Json(json!({
        "success": true,
        "status": state.osd.get_status()
    }))
    .into_response()
}

pub async fn handle_osd_start(
    State(state): State<AppState>,
    Json(payload): Json<OsdStartPayload>,
) -> Response {
    let Some(osd_path) = payload.osd_path.filter(|s| !s.trim().is_empty()) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "success": false,
                "message": "Cần cung cấp đầy đủ đường dẫn thư mục OSD, Thư mục Thí sinh và Thư mục Đề thi."
            })),
        )
            .into_response();
    };
    let Some(contestants_path) = payload.contestants_path.filter(|s| !s.trim().is_empty()) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "success": false,
                "message": "Cần cung cấp đầy đủ đường dẫn thư mục OSD, Thư mục Thí sinh và Thư mục Đề thi."
            })),
        )
            .into_response();
    };
    let Some(test_path) = payload.test_path.filter(|s| !s.trim().is_empty()) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "success": false,
                "message": "Cần cung cấp đầy đủ đường dẫn thư mục OSD, Thư mục Thí sinh và Thư mục Đề thi."
            })),
        )
            .into_response();
    };

    let enable_log = payload.enable_log != Some(false);
    match state.osd.start(
        state.clone(),
        osd_path,
        contestants_path,
        test_path,
        enable_log,
        payload.problem_configs,
    ) {
        Ok(status) => Json(json!({
            "success": true,
            "status": status
        }))
        .into_response(),
        Err(message) => (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "success": false,
                "message": message
            })),
        )
            .into_response(),
    }
}

pub async fn handle_osd_stop(State(state): State<AppState>) -> Response {
    let status = state.osd.stop();
    Json(json!({
        "success": true,
        "status": status
    }))
    .into_response()
}

pub async fn handle_osd_events(State(state): State<AppState>) -> Response {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Result<String, std::io::Error>>();
    let mut sub = state.osd.subscribe();

    let initial_payload = json!({
        "type": "osd_status",
        "data": state.osd.get_status()
    });
    let initial_line = format!(
        "data: {}\n\n",
        serde_json::to_string(&initial_payload).unwrap_or_default()
    );
    let _ = tx.send(Ok(initial_line));

    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = tx.closed() => break,
                recv_res = sub.recv() => {
                    match recv_res {
                        Ok(ev) => {
                            let line = format!(
                                "data: {}\n\n",
                                serde_json::to_string(&ev).unwrap_or_default()
                            );
                            if tx.send(Ok(line)).is_err() {
                                break;
                            }
                        }
                        Err(RecvError::Lagged(_)) => {
                            let snap = json!({
                                "type": "osd_status",
                                "data": state.osd.get_status()
                            });
                            let line = format!(
                                "data: {}\n\n",
                                serde_json::to_string(&snap).unwrap_or_default()
                            );
                            if tx.send(Ok(line)).is_err() {
                                break;
                            }
                        }
                        Err(RecvError::Closed) => break,
                    }
                }
            }
        }
    });

    let body = axum::body::Body::from_stream(UnboundedReceiverStream::new(rx));
    match Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", "text/event-stream")
        .header("Cache-Control", "no-cache")
        .header("Connection", "keep-alive")
        .body(body)
    {
        Ok(resp) => resp,
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "failed to build SSE response",
        )
            .into_response(),
    }
}
