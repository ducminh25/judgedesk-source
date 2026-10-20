use std::path::Path;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

use crate::server::state::AppState;
use crate::storage::{
    ensure_no_reparse_or_symlink_chain, ensure_safe_contained_path, validate_path_syntax,
};

const SCORE_EXPORT_CONTENT_TYPE: &str = "application/vnd.judgedesk.score-export-v1";
const MAX_SCORE_EXPORT_PAYLOAD_BYTES: usize = 256 * 1024 * 1024;
const MAGIC: [u8; 8] = [0x4a, 0x44, 0x58, 0x4c, 0x53, 0x58, 0x30, 0x31];

pub async fn handle_open_excel(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let ct_valid = headers
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|ct| {
            ct.split(';')
                .next()
                .is_some_and(|mime| mime.trim().eq_ignore_ascii_case(SCORE_EXPORT_CONTENT_TYPE))
        });
    if !ct_valid {
        return (
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            Json(json!({ "success": false, "message": "Score export payload is required." })),
        )
            .into_response();
    }

    if body.len() > MAX_SCORE_EXPORT_PAYLOAD_BYTES {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(json!({ "success": false, "message": "Score export exceeds the 256 MiB safety limit." })),
        )
            .into_response();
    }

    if body.len() < 12 || body[..8] != MAGIC {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "success": false, "message": "Invalid score export payload" })),
        )
            .into_response();
    }

    let diag_len = match body[8..12].try_into() {
        Ok(bytes) => u32::from_le_bytes(bytes) as usize,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "success": false, "message": "Invalid score export payload" })),
            )
                .into_response();
        }
    };
    if diag_len == 0 {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "success": false, "message": "Diagnostic JSON is required." })),
        )
            .into_response();
    }

    let offset = 12usize.saturating_add(diag_len);
    if offset >= body.len() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "success": false, "message": "Truncated or empty score export payload" })),
        )
            .into_response();
    }

    let diag_bytes = &body[12..offset];
    let Ok(diag_json) = std::str::from_utf8(diag_bytes) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "success": false, "message": "Diagnostic JSON must be valid UTF-8." })),
        )
            .into_response();
    };
    if serde_json::from_str::<serde_json::Value>(diag_json).is_err() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "success": false, "message": "Diagnostic JSON is invalid." })),
        )
            .into_response();
    }

    let workbook_bytes = &body[offset..];
    let export_dir = state.export_dir.clone().unwrap_or_else(|| {
        std::env::temp_dir()
            .join("judgedesk")
            .join("exports")
            .join(uuid::Uuid::new_v4().to_string())
    });
    if let Err(e) = validate_path_syntax(&export_dir)
        .and_then(|()| ensure_no_reparse_or_symlink_chain(&export_dir, None))
    {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "success": false, "message": format!("Invalid export directory path: {e}") })),
        )
            .into_response();
    }
    if let Err(e) = std::fs::create_dir_all(&export_dir) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "success": false, "message": format!("Failed to create export directory: {e}") })),
        )
            .into_response();
    }

    if let Err(e) = ensure_safe_contained_path(&export_dir, Path::new("Book.xlsx")) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "success": false, "message": format!("Invalid workbook export path: {e}") })),
        )
            .into_response();
    }
    if let Err(e) = ensure_safe_contained_path(&export_dir, Path::new("diagnostics.json")) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "success": false, "message": format!("Invalid diagnostics export path: {e}") })),
        )
            .into_response();
    }
    let book_path = export_dir.join("Book.xlsx");
    let diag_path = export_dir.join("diagnostics.json");

    if let Err(e) = std::fs::write(&book_path, workbook_bytes) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "success": false, "message": format!("Failed to write workbook: {e}") })),
        )
            .into_response();
    }
    if let Err(e) = std::fs::write(&diag_path, diag_json.as_bytes()) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(
                json!({ "success": false, "message": format!("Failed to write diagnostics: {e}") }),
            ),
        )
            .into_response();
    }

    let open_mode = match state.workbook_opener.open_workbook_with_mode(&book_path) {
        Ok(mode) => mode,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(
                    json!({ "success": false, "message": format!("Failed to open workbook: {e}") }),
                ),
            )
                .into_response();
        }
    };

    Json(json!({
        "success": true,
        "path": book_path.to_string_lossy(),
        "diagnosticsPath": diag_path.to_string_lossy(),
        "openMode": open_mode
    }))
    .into_response()
}
