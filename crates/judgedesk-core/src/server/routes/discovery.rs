use std::collections::HashMap;
use std::io::Read;
use std::path::Path;

use axum::extract::Query;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

use crate::discovery::testcase::{
    ensure_or_reconcile_stored_problem_config, is_flat_test_directory, is_ignored_os_metadata_name,
    read_stored_problem_config, resolve_problem_directory_path, write_problem_config_atomic,
};
use crate::discovery::{
    discover_custom_checkers, discover_interactors, discover_test_cases, list_contestants,
    list_test_directories, natural_cmp,
};
use crate::server::dto::{FetchTestsQuery, PathQuery, SavePolygonConfigPayload};

fn validate_directory_query_path(raw_path: &str, p: &Path) -> Option<Response> {
    if raw_path.trim().is_empty() {
        return Some(
            (
                StatusCode::BAD_REQUEST,
                Json(json!({ "success": false, "code": "PATH_REQUIRED", "message": "Path required" })),
            )
                .into_response(),
        );
    }
    if !p.exists() {
        return Some(
            (
                StatusCode::NOT_FOUND,
                Json(json!({ "success": false, "code": "DIRECTORY_NOT_FOUND", "message": "Directory not found" })),
            )
                .into_response(),
        );
    }
    if !p.is_dir() {
        return Some(
            (
                StatusCode::BAD_REQUEST,
                Json(json!({ "success": false, "code": "NOT_A_DIRECTORY", "message": "Path is not a directory" })),
            )
                .into_response(),
        );
    }
    None
}

pub async fn handle_fetch_contestants(Query(q): Query<PathQuery>) -> Response {
    let p = Path::new(&q.path);
    if let Some(resp) = validate_directory_query_path(&q.path, p) {
        return resp;
    }

    let mut contestants = list_contestants(p, None);
    contestants.sort_by(|a, b| natural_cmp(a, b));
    Json(json!({ "success": true, "data": contestants })).into_response()
}

pub async fn handle_fetch_problems(Query(q): Query<PathQuery>) -> Response {
    let p = Path::new(&q.path);
    if let Some(resp) = validate_directory_query_path(&q.path, p) {
        return resp;
    }

    let mut dirs = Vec::new();
    let mut custom_checkers = HashMap::new();
    let mut interactors = HashMap::new();
    let platform_str = if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    };

    if is_flat_test_directory(p) {
        let name = p
            .file_name()
            .map(|f| f.to_string_lossy().to_string())
            .unwrap_or_default();
        if !name.is_empty() {
            dirs.push(name.clone());
            let c_list = discover_custom_checkers(p, platform_str);
            custom_checkers.insert(name.clone(), c_list);
            let i_list = discover_interactors(p, platform_str);
            interactors.insert(name.clone(), i_list);
            let _ = ensure_or_reconcile_stored_problem_config(p, &name, platform_str);
        }
    } else if let Ok(entries) = std::fs::read_dir(p) {
        for entry in entries.flatten() {
            let entry_path = entry.path();
            if entry_path.is_dir() {
                let name = entry.file_name().to_string_lossy().to_string();
                if is_ignored_os_metadata_name(&name) {
                    continue;
                }
                dirs.push(name.clone());
                let c_list = discover_custom_checkers(&entry_path, platform_str);
                custom_checkers.insert(name.clone(), c_list);
                let i_list = discover_interactors(&entry_path, platform_str);
                interactors.insert(name.clone(), i_list);
                let _ = ensure_or_reconcile_stored_problem_config(&entry_path, &name, platform_str);
            }
        }
    }

    dirs.sort_by(|a, b| natural_cmp(a, b));

    Json(json!({
        "success": true,
        "data": dirs,
        "customCheckers": custom_checkers,
        "interactors": interactors
    }))
    .into_response()
}

fn is_interactive_problem(problem_directory: &Path, requested_mode: Option<&str>) -> bool {
    requested_mode == Some("true")
        || read_stored_problem_config(problem_directory)
            .and_then(|config| {
                config
                    .get("isInteractive")
                    .and_then(|value| value.as_bool())
            })
            .unwrap_or(false)
}

pub async fn handle_fetch_tests(Query(q): Query<FetchTestsQuery>) -> Response {
    let p = resolve_problem_directory_path(&q.path);
    if let Some(resp) = validate_directory_query_path(&q.path, &p) {
        return resp;
    }

    let is_inter = is_interactive_problem(&p, q.is_interactive.as_deref());
    let dirs = list_test_directories(&p, is_inter);
    Json(json!({ "success": true, "data": dirs })).into_response()
}

pub async fn handle_fetch_polygon_tests(Query(q): Query<FetchTestsQuery>) -> Response {
    if q.problem.as_deref().map(str::trim).unwrap_or("").is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "success": false, "code": "PATH_REQUIRED", "message": "Path and problem required" })),
        )
            .into_response();
    }
    let p = resolve_problem_directory_path(&q.path);
    if let Some(resp) = validate_directory_query_path(&q.path, &p) {
        return resp;
    }

    let is_interactive = is_interactive_problem(&p, q.is_interactive.as_deref());
    let tests = discover_test_cases(&p, is_interactive);
    let mut result = Vec::new();
    for files in tests {
        let size = std::fs::metadata(&files.input_path)
            .map(|m| m.len())
            .unwrap_or(0);
        let preview = if size > 0 {
            if let Ok(mut f) = std::fs::File::open(&files.input_path) {
                let mut buf = vec![0u8; 35];
                let bytes_read = f.read(&mut buf).unwrap_or(0);
                let slice = &buf[..bytes_read];
                let valid_utf8 = match std::str::from_utf8(slice) {
                    Ok(s) => s.to_string(),
                    Err(e) if e.error_len().is_none() => {
                        std::str::from_utf8(&slice[..e.valid_up_to()])
                            .unwrap_or("")
                            .to_string()
                    }
                    Err(_) => String::from_utf8_lossy(slice).into_owned(),
                };
                let mut s = valid_utf8.replace('\r', "");
                if size > 35 {
                    s.push_str("...");
                }
                s
            } else {
                String::new()
            }
        } else {
            String::new()
        };
        result.push(json!({
            "name": files.name,
            "preview": preview,
            "size": size,
        }));
    }

    Json(json!({ "success": true, "data": result })).into_response()
}

pub async fn handle_get_polygon_config(Query(q): Query<PathQuery>) -> Response {
    if q.path.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "success": false, "code": "PATH_REQUIRED", "message": "Path required" })),
        )
            .into_response();
    }
    let p = resolve_problem_directory_path(&q.path);
    Json(json!({ "success": true, "data": read_stored_problem_config(&p) })).into_response()
}

pub async fn handle_save_polygon_config(Json(body): Json<SavePolygonConfigPayload>) -> Response {
    match tokio::task::spawn_blocking(move || save_polygon_config(body)).await {
        Ok((status, response)) => (status, Json(response)).into_response(),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "success": false, "code": "CONFIG_WRITE_ERROR", "message": "Failed to write problem configuration" })),
        )
            .into_response(),
    }
}

fn save_polygon_config(body: SavePolygonConfigPayload) -> (StatusCode, serde_json::Value) {
    if body.path.is_empty() || !body.config.is_object() {
        return (
            StatusCode::BAD_REQUEST,
            json!({ "success": false, "code": "PARAMS_REQUIRED", "message": "Path and config required" }),
        );
    }
    let normalized_compile =
        match crate::discovery::normalize_compile_config(body.config.get("compile")) {
            Ok(compile) => compile,
            Err(message) => {
                return (
                    StatusCode::BAD_REQUEST,
                    json!({
                        "success": false,
                        "code": "INVALID_COMPILE_CONFIG",
                        "message": message,
                    }),
                );
            }
        };
    let well_formed = body.config.get("testWellFormed").and_then(|v| v.as_bool()) == Some(true);
    if body.validate_only && !well_formed {
        return (
            StatusCode::BAD_REQUEST,
            json!({ "success": false, "code": "VALIDATION_REQUIRED", "message": "Enable well-formed validation for a preview" }),
        );
    }
    let p = resolve_problem_directory_path(&body.path);
    if well_formed {
        let interactive = body.config.get("isInteractive").and_then(|v| v.as_bool()) == Some(true);
        match crate::discovery::test_wellformed::validate_problem_test_inputs(&p, interactive) {
            Ok(validation) => {
                if body.validate_only {
                    return (
                        StatusCode::OK,
                        json!({ "success": true, "data": validation }),
                    );
                }
                if !validation.issues.is_empty() {
                    return (
                        StatusCode::UNPROCESSABLE_ENTITY,
                        json!({ "success": false, "code": "TEST_NOT_WELL_FORMED", "message": "Test inputs are not well-formed", "data": validation }),
                    );
                }
            }
            Err(_) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    json!({ "success": false, "code": "CONFIG_WRITE_ERROR", "message": "Failed to validate test inputs" }),
                )
            }
        }
    }
    let mut persisted_config = body.config.clone();
    if let Some(obj) = persisted_config.as_object_mut() {
        if let Ok(compile_json) = serde_json::to_value(&normalized_compile) {
            obj.insert("compile".to_string(), compile_json);
        }
    }
    if write_problem_config_atomic(&p, "Config.cfg", &persisted_config).is_ok() {
        return (StatusCode::OK, json!({ "success": true }));
    }
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        json!({ "success": false, "code": "CONFIG_WRITE_ERROR", "message": "Failed to write Config.cfg" }),
    )
}
