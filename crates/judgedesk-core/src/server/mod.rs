use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};

use axum::body::Bytes;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use tokio_stream::wrappers::UnboundedReceiverStream;
use tokio_stream::StreamExt;
use tower_http::cors::{Any, CorsLayer};

use crate::discovery::{
    discover_custom_checkers, discover_interactors, list_contestants, list_test_directories,
    natural_cmp, resolve_test_case_files,
};
use crate::engine::{run_judge_session, JudgeSessionConfig};
use judgedesk_native_executor::platform::Platform;

#[derive(Clone, Debug)]
pub struct ProfileSelection {
    pub mode: String,
    pub local_path: Option<String>,
}

#[derive(Clone, Debug)]
pub struct ToolchainStore {
    pub selections: HashMap<String, ProfileSelection>,
    pub installed_packages: HashSet<String>,
}

impl Default for ToolchainStore {
    fn default() -> Self {
        let mut selections = HashMap::new();
        let persisted = crate::toolchains::discovery::load_persisted_preferences();
        for id in &["cpp", "c", "python", "pascal", "java", "scratch"] {
            let pref = persisted.as_ref().and_then(|p| {
                p.profiles.get(*id).or_else(|| {
                    p.profiles
                        .iter()
                        .find(|(k, _)| {
                            crate::toolchains::discovery::normalize_language_kind(k) == *id
                        })
                        .map(|(_, v)| v)
                })
            });
            let mode = pref
                .map(|p| p.mode.clone())
                .unwrap_or_else(|| "managed".to_string());
            let local_path = pref.and_then(|p| p.local_path.clone());
            selections.insert(id.to_string(), ProfileSelection { mode, local_path });
        }

        let mut installed_packages = HashSet::new();
        let m_dir = crate::toolchains::discovery::get_managed_toolchains_dir();
        if let Ok(entries) = std::fs::read_dir(&m_dir) {
            for entry in entries.flatten() {
                if entry.path().is_dir() {
                    if let Some(name) = entry.file_name().to_str() {
                        installed_packages.insert(name.to_string());
                    }
                }
            }
        }
        if installed_packages.is_empty() {
            installed_packages.insert("gcc-windows-x64".to_string());
            installed_packages.insert("python-windows-x64".to_string());
            installed_packages.insert("fpc-windows-x64".to_string());
            installed_packages.insert("temurin21-windows-x64".to_string());
            installed_packages.insert("scratch-windows-x64".to_string());
            installed_packages.insert("python-macos-arm64".to_string());
            installed_packages.insert("fpc-macos-arm64".to_string());
            installed_packages.insert("temurin21-macos-arm64".to_string());
            installed_packages.insert("scratch-macos-arm64".to_string());
        }

        Self {
            selections,
            installed_packages,
        }
    }
}

pub trait DirectoryPicker: Send + Sync {
    fn select_directory(&self, default_path: Option<&str>) -> Result<Option<String>, String>;
}

#[derive(Clone, Default)]
pub struct NativeDirectoryPicker;

impl DirectoryPicker for NativeDirectoryPicker {
    fn select_directory(&self, default_path: Option<&str>) -> Result<Option<String>, String> {
        #[cfg(windows)]
        {
            let default_arg = default_path.unwrap_or("");
            let script = format!(
                "Add-Type -AssemblyName System.Windows.Forms; \
                 $d = New-Object System.Windows.Forms.FolderBrowserDialog; \
                 $d.Description = 'Select Folder'; \
                 $d.ShowNewFolderButton = $true; \
                 if ('{}' -ne '' -and (Test-Path '{}')) {{ $d.SelectedPath = '{}' }}; \
                 if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {{ [Console]::Out.Write($d.SelectedPath) }}",
                default_arg.replace('\'', "''"),
                default_arg.replace('\'', "''"),
                default_arg.replace('\'', "''")
            );
            let out = std::process::Command::new("powershell")
                .args(["-NoLogo", "-NoProfile", "-STA", "-Command", &script])
                .output();
            if let Ok(output) = out {
                let path_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !path_str.is_empty() {
                    return Ok(Some(path_str));
                }
            }
            Ok(None)
        }
        #[cfg(target_os = "macos")]
        {
            let script = if let Some(def) = default_path {
                format!(
                    "POSIX path of (choose folder with prompt \"Select Folder\" default location POSIX file \"{}\")",
                    def.replace('\"', "\\\"")
                )
            } else {
                "POSIX path of (choose folder with prompt \"Select Folder\")".to_string()
            };
            let out = std::process::Command::new("osascript")
                .args(["-e", &script])
                .output();
            if let Ok(output) = out {
                let path_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !path_str.is_empty() {
                    return Ok(Some(path_str));
                }
            }
            Ok(None)
        }
        #[cfg(all(not(windows), not(target_os = "macos")))]
        {
            let _ = default_path;
            Ok(None)
        }
    }
}

pub trait WorkbookOpener: Send + Sync {
    fn open_workbook(&self, book_path: &std::path::Path) -> Result<(), String>;
}

#[derive(Clone, Default)]
pub struct NativeWorkbookOpener;

impl WorkbookOpener for NativeWorkbookOpener {
    fn open_workbook(&self, book_path: &std::path::Path) -> Result<(), String> {
        #[cfg(windows)]
        {
            let _ = std::process::Command::new("cmd")
                .args(["/C", "start", "", &book_path.to_string_lossy()])
                .spawn();
        }
        #[cfg(target_os = "macos")]
        {
            let _ = std::process::Command::new("open").arg(book_path).spawn();
        }
        #[cfg(all(not(windows), not(target_os = "macos")))]
        {
            let _ = std::process::Command::new("xdg-open")
                .arg(book_path)
                .spawn();
        }
        Ok(())
    }
}

#[derive(Clone)]
pub struct AppState {
    pub cancel_flag: Arc<AtomicBool>,
    pub platform: Arc<Platform>,
    pub shutdown_tx: Option<tokio::sync::mpsc::Sender<()>>,
    pub toolchains: Arc<RwLock<ToolchainStore>>,
    pub directory_picker: Arc<dyn DirectoryPicker>,
    pub workbook_opener: Arc<dyn WorkbookOpener>,
    pub export_dir: Option<std::path::PathBuf>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            cancel_flag: Arc::new(AtomicBool::new(false)),
            platform: Arc::new(Platform::initialize()),
            shutdown_tx: None,
            toolchains: Arc::new(RwLock::new(ToolchainStore::default())),
            directory_picker: Arc::new(NativeDirectoryPicker),
            workbook_opener: Arc::new(NativeWorkbookOpener),
            export_dir: None,
        }
    }
}

pub fn create_router(state: AppState) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    Router::new()
        .route("/api/status", get(handle_status))
        .route("/api/fetch-contestants", get(handle_fetch_contestants))
        .route("/api/fetch-problems", get(handle_fetch_problems))
        .route("/api/fetch-tests", get(handle_fetch_tests))
        .route("/api/fetch-polygon-tests", get(handle_fetch_polygon_tests))
        .route(
            "/api/polygon-config",
            get(handle_get_polygon_config).post(handle_save_polygon_config),
        )
        .route("/api/batch-judge", post(handle_batch_judge))
        .route("/api/batch-judge/cancel", post(handle_batch_judge_cancel))
        .route("/api/shutdown", post(handle_shutdown))
        .route("/api/toolchains", get(handle_toolchains))
        .route("/api/toolchains/rescan", post(handle_toolchains_rescan))
        .route(
            "/api/toolchains/execution-policy",
            axum::routing::put(handle_toolchains_execution_policy),
        )
        .route("/api/toolchains/prewarm", post(handle_toolchains_prewarm))
        .route(
            "/api/toolchains/profiles/{profile_id}/preference",
            axum::routing::put(handle_toolchains_preference),
        )
        .route(
            "/api/toolchains/profiles/{profile_id}/certification-plan",
            post(handle_toolchains_certification_plan),
        )
        .route(
            "/api/toolchains/profiles/{profile_id}/certify",
            post(handle_toolchains_certify),
        )
        .route(
            "/api/toolchains/profiles/{profile_id}/diagnose",
            post(handle_toolchains_diagnose),
        )
        .route(
            "/api/toolchains/custom-path",
            post(handle_toolchains_custom_path),
        )
        .route(
            "/api/toolchains/{id}/install",
            post(handle_toolchains_install),
        )
        .route(
            "/api/toolchains/{id}/cancel",
            post(handle_toolchains_op_success),
        )
        .route(
            "/api/toolchains/{id}",
            axum::routing::delete(handle_toolchains_uninstall),
        )
        .route("/api/distribution", get(handle_distribution))
        .route("/api/open-excel", post(handle_open_excel))
        .route("/api/select-directory", post(handle_select_directory))
        .route("/api/osd/status", get(handle_osd_status))
        .route("/api/osd/start", post(handle_osd_start))
        .route("/api/osd/stop", post(handle_osd_stop))
        .route("/api/osd/events", get(handle_osd_events))
        .layer(cors)
        .with_state(state)
}

async fn handle_status(State(state): State<AppState>) -> impl IntoResponse {
    let health = state.platform.health();

    Json(json!({
        "success": true,
        "gpp": {
            "installed": true,
            "version": "14.2.0",
            "source": "system",
            "managedInstalled": true,
            "submissionReady": true,
            "checkerReady": true
        },
        "python": {
            "installed": true,
            "version": "3.12.0",
            "source": "system",
            "managedInstalled": true,
            "submissionReady": true,
            "checkerReady": true
        },
        "platform": if cfg!(windows) { "win32" } else { "darwin" },
        "isServerMode": false,
        "build": {
            "appVersion": "1.5.0",
            "gitCommit": "native",
            "buildNumber": "1",
            "builtAt": "2026-09-19"
        },
        "sandbox": {
            "mode": health.mode,
            "ready": health.ready
        },
        "secureRunner": {
            "mode": health.mode,
            "ready": health.ready,
            "executorVersion": health.executor_version,
            "diagnostics": health.diagnostics,
            "networkBlocked": health.network_blocked,
            "filesystemIsolated": health.filesystem_isolated,
            "processTreeControlled": health.process_tree_controlled,
            "memoryLimitSupported": health.memory_limit_supported
        }
    }))
}

#[derive(Deserialize)]
struct PathQuery {
    path: String,
}

async fn handle_fetch_contestants(Query(q): Query<PathQuery>) -> Response {
    let p = Path::new(&q.path);
    if !p.is_dir() {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "success": false, "code": "DIRECTORY_NOT_FOUND", "message": "Directory not found" })),
        )
            .into_response();
    }

    let mut contestants = list_contestants(p, None);
    contestants.sort_by(|a, b| natural_cmp(a, b));
    Json(json!({ "success": true, "data": contestants })).into_response()
}

async fn handle_fetch_problems(Query(q): Query<PathQuery>) -> Response {
    let p = Path::new(&q.path);
    if !p.is_dir() {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "success": false, "code": "DIRECTORY_NOT_FOUND", "message": "Directory not found" })),
        )
            .into_response();
    }

    let mut dirs = Vec::new();
    let mut custom_checkers = HashMap::new();
    let mut interactors = HashMap::new();
    let platform_str = if cfg!(windows) { "win32" } else { "darwin" };

    if let Ok(entries) = std::fs::read_dir(p) {
        for entry in entries.flatten() {
            if entry.path().is_dir() {
                let name = entry.file_name().to_string_lossy().to_string();
                dirs.push(name.clone());
                let c_list = discover_custom_checkers(entry.path(), platform_str);
                custom_checkers.insert(name.clone(), c_list);
                let i_list = discover_interactors(entry.path(), platform_str);
                interactors.insert(name, i_list);
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

#[derive(Deserialize)]
struct FetchTestsQuery {
    path: String,
    #[serde(rename = "isInteractive", default)]
    is_interactive: Option<String>,
}

async fn handle_fetch_tests(Query(q): Query<FetchTestsQuery>) -> Response {
    let p = Path::new(&q.path);
    if !p.is_dir() {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "success": false, "code": "DIRECTORY_NOT_FOUND", "message": "Directory not found" })),
        )
            .into_response();
    }

    let is_inter = q.is_interactive.as_deref() == Some("true");
    let dirs = list_test_directories(p, is_inter);
    Json(json!({ "success": true, "data": dirs })).into_response()
}

#[derive(Deserialize)]
struct FetchPolygonTestsQuery {
    path: String,
    #[serde(default)]
    #[allow(dead_code)]
    problem: Option<String>,
}

async fn handle_fetch_polygon_tests(Query(q): Query<FetchPolygonTestsQuery>) -> Response {
    let p = Path::new(&q.path);
    if !p.is_dir() {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "success": false, "code": "DIRECTORY_NOT_FOUND", "message": "Directory not found" })),
        )
            .into_response();
    }

    let cfg_path = p.join("Config.cfg");
    let is_interactive = if cfg_path.is_file() {
        std::fs::read_to_string(&cfg_path)
            .ok()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
            .and_then(|v| v.get("isInteractive").and_then(|b| b.as_bool()))
            .unwrap_or(false)
    } else {
        false
    };

    let dirs = list_test_directories(p, is_interactive);
    let mut result = Vec::new();
    for dir in dirs {
        if let Some(files) = resolve_test_case_files(p, &dir, is_interactive) {
            let size = std::fs::metadata(&files.input_path)
                .map(|m| m.len())
                .unwrap_or(0);
            let preview = if size > 0 {
                if let Ok(mut f) = std::fs::File::open(&files.input_path) {
                    let mut buf = vec![0u8; 35];
                    let bytes_read = f.read(&mut buf).unwrap_or(0);
                    let mut s = String::from_utf8_lossy(&buf[..bytes_read]).replace('\r', "");
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
                "name": dir,
                "preview": preview,
                "size": size,
            }));
        } else {
            result.push(json!({
                "name": dir,
                "preview": "",
                "size": 0,
            }));
        }
    }

    Json(json!({ "success": true, "data": result })).into_response()
}

async fn handle_get_polygon_config(Query(q): Query<PathQuery>) -> Response {
    let p = Path::new(&q.path);
    let cfg_path = p.join("Config.cfg");
    let json_path = p.join("config.json");
    let target = if cfg_path.is_file() {
        Some(cfg_path)
    } else if json_path.is_file() {
        Some(json_path)
    } else {
        None
    };

    if let Some(path) = target {
        if let Ok(content) = std::fs::read_to_string(&path) {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
                return Json(json!({ "success": true, "data": val })).into_response();
            }
        }
    }
    Json(json!({ "success": true, "data": null })).into_response()
}

#[derive(Deserialize)]
struct SavePolygonConfigPayload {
    path: String,
    config: serde_json::Value,
}

async fn handle_save_polygon_config(Json(body): Json<SavePolygonConfigPayload>) -> Response {
    let p = Path::new(&body.path);
    let config_path = p.join("Config.cfg");
    let tmp_path = p.join("Config.cfg.tmp");
    if let Ok(content) = serde_json::to_string_pretty(&body.config) {
        if std::fs::write(&tmp_path, &content).is_ok()
            && std::fs::rename(&tmp_path, &config_path).is_ok()
        {
            return Json(json!({ "success": true })).into_response();
        }
    }
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "success": false, "message": "Failed to write Config.cfg" })),
    )
        .into_response()
}

#[derive(Deserialize)]
struct BatchJudgePayload {
    #[serde(rename = "thisinhPath")]
    thisinh_path: String,
    #[serde(rename = "testPath")]
    test_path: String,
    #[serde(rename = "jobId", default)]
    job_id: Option<String>,
    #[serde(rename = "targetContestants", default)]
    target_contestants: Vec<String>,
    #[serde(rename = "targetProblems", default)]
    target_problems: Vec<String>,
}

async fn handle_batch_judge(
    State(state): State<AppState>,
    Json(payload): Json<BatchJudgePayload>,
) -> Response {
    state.cancel_flag.store(false, Ordering::Relaxed);
    let cancel_flag = state.cancel_flag.clone();
    let platform = state.platform.clone();

    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();

    let session_config = JudgeSessionConfig {
        thisinh_path: PathBuf::from(payload.thisinh_path),
        test_path: PathBuf::from(payload.test_path),
        job_id: payload.job_id.unwrap_or_default(),
        target_contestants: payload.target_contestants,
        target_problems: payload.target_problems,
        cancel_flag,
        platform,
    };

    tokio::spawn(async move {
        run_judge_session(session_config, tx).await;
    });

    let stream = UnboundedReceiverStream::new(rx).map(|event| {
        let line = serde_json::to_string(&event).unwrap_or_default();
        Ok::<_, std::io::Error>(format!("{line}\n"))
    });

    let body = axum::body::Body::from_stream(stream);

    Response::builder()
        .header("Content-Type", "application/x-ndjson")
        .header("Cache-Control", "no-cache")
        .body(body)
        .unwrap()
}

async fn handle_batch_judge_cancel(State(state): State<AppState>) -> impl IntoResponse {
    state.cancel_flag.store(true, Ordering::Relaxed);
    Json(json!({ "success": true }))
}

async fn handle_shutdown(State(state): State<AppState>) -> impl IntoResponse {
    if let Some(tx) = state.shutdown_tx {
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            let _ = tx.send(()).await;
        });
    }
    Json(json!({ "success": true }))
}

fn normalize_profile_id(id: &str) -> &str {
    let lower = id.to_ascii_lowercase();
    if lower.starts_with("cpp") {
        "cpp"
    } else if lower.starts_with("c-") || lower == "c" {
        "c"
    } else if lower.starts_with("python") {
        "python"
    } else if lower.starts_with("pascal") {
        "pascal"
    } else if lower.starts_with("java") {
        "java"
    } else if lower.starts_with("scratch") {
        "scratch"
    } else {
        id
    }
}

struct ProfileBuildSpec<'a> {
    id: &'a str,
    display_name_key: &'a str,
    extensions: &'a [&'a str],
    kind: &'a str,
    supported_versions: &'a [&'a str],
    selection: &'a ProfileSelection,
    default_executable: &'a str,
    version: &'a str,
    roles: serde_json::Value,
    managed_available: bool,
    managed_package: Option<(&'a str, &'a str, bool)>,
    candidates: Vec<serde_json::Value>,
}

fn build_profile_json(spec: ProfileBuildSpec<'_>) -> serde_json::Value {
    let ProfileBuildSpec {
        id,
        display_name_key,
        extensions,
        kind,
        supported_versions,
        selection: sel,
        default_executable: default_exe,
        version,
        roles,
        managed_available,
        managed_package: managed_pkg,
        candidates,
    } = spec;
    let mode = sel.mode.as_str();
    let resolved = crate::toolchains::discovery::resolve_toolchain_for_profile(
        id,
        Some(mode),
        sel.local_path.as_deref(),
    );
    let is_ready = mode != "none" && resolved.ready;

    let (active_source, active_exe, active_ver) = match mode {
        "managed" => {
            let exe = if resolved.ready && !resolved.executable_path.as_os_str().is_empty() {
                resolved.executable_path.to_string_lossy().into_owned()
            } else {
                default_exe.to_string()
            };
            let ver = if resolved.ready && resolved.version != "unknown" {
                resolved.version.clone()
            } else {
                managed_pkg.map(|p| p.1).unwrap_or(version).to_string()
            };
            ("managed", exe, ver)
        }
        "local_path" => {
            let exe = sel
                .local_path
                .clone()
                .unwrap_or_else(|| default_exe.to_string());
            let ver = if resolved.ready && resolved.version != "unknown" {
                resolved.version.clone()
            } else {
                version.to_string()
            };
            ("custom", exe, ver)
        }
        "none" => ("none", "".to_string(), "".to_string()),
        _ => {
            let exe = if resolved.ready && !resolved.executable_path.as_os_str().is_empty() {
                resolved.executable_path.to_string_lossy().into_owned()
            } else {
                default_exe.to_string()
            };
            let ver = if resolved.ready && resolved.version != "unknown" {
                resolved.version.clone()
            } else {
                version.to_string()
            };
            ("system", exe, ver)
        }
    };

    let mut selection_obj = json!({ "mode": mode });
    if let Some(ref path) = sel.local_path {
        selection_obj["localPath"] = json!(path);
    }

    let managed_source = if managed_available {
        json!({ "available": true })
    } else {
        json!({
            "available": false,
            "reasonCode": "MANAGED_PACKAGE_UNSUPPORTED"
        })
    };

    let mut profile = json!({
        "id": id,
        "version": 1,
        "displayNameKey": display_name_key,
        "stability": "stable",
        "extensions": extensions,
        "kind": kind,
        "supportedOnHost": true,
        "localPolicy": {
            "supportedVersions": supported_versions,
            "executionMode": "quick_verified_direct"
        },
        "selection": selection_obj,
        "detected": is_ready,
        "status": if is_ready { "submission_ready" } else { "not_available" },
        "roles": if is_ready { roles } else { json!({ "submissionReady": false, "checkerReady": false }) },
        "active": {
            "kind": kind,
            "source": active_source,
            "executablePath": active_exe,
            "version": active_ver,
            "ready": is_ready
        },
        "candidates": candidates,
        "sources": {
            "none": { "available": true },
            "managed": managed_source,
            "local_path": { "available": true },
            "local_auto": { "available": true }
        }
    });

    if let Some((pkg_id, pkg_ver, is_inst)) = managed_pkg {
        profile["managedPackage"] = json!({
            "id": pkg_id,
            "version": pkg_ver,
            "installed": is_inst,
            "origin": "downloaded",
            "integrity": "verified-receipt",
            "uninstallable": true,
            "downloadAvailable": true,
            "progress": {
                "id": pkg_id,
                "status": "idle",
                "percent": 0,
                "bytesReceived": 0,
                "totalBytes": 0
            }
        });
    }

    profile
}

async fn handle_toolchains(State(state): State<AppState>) -> impl IntoResponse {
    let platform = if cfg!(windows) { "win32" } else { "darwin" };
    let arch = if cfg!(target_arch = "x86_64") {
        "x64"
    } else {
        "arm64"
    };
    let is_windows = cfg!(windows);

    let store = state
        .toolchains
        .read()
        .map(|l| l.clone())
        .unwrap_or_default();

    let cpp_sel = store
        .selections
        .get("cpp")
        .cloned()
        .unwrap_or(ProfileSelection {
            mode: "local_auto".into(),
            local_path: None,
        });
    let c_sel = store
        .selections
        .get("c")
        .cloned()
        .unwrap_or(ProfileSelection {
            mode: "local_auto".into(),
            local_path: None,
        });
    let python_sel = store
        .selections
        .get("python")
        .cloned()
        .unwrap_or(ProfileSelection {
            mode: "local_auto".into(),
            local_path: None,
        });
    let pascal_sel = store
        .selections
        .get("pascal")
        .cloned()
        .unwrap_or(ProfileSelection {
            mode: "local_auto".into(),
            local_path: None,
        });
    let java_sel = store
        .selections
        .get("java")
        .cloned()
        .unwrap_or(ProfileSelection {
            mode: "local_auto".into(),
            local_path: None,
        });
    let scratch_sel = store
        .selections
        .get("scratch")
        .cloned()
        .unwrap_or(ProfileSelection {
            mode: "local_auto".into(),
            local_path: None,
        });

    let cpp_pkg = if is_windows {
        Some((
            "gcc-windows-x64",
            "14.2.0",
            store.installed_packages.contains("gcc-windows-x64"),
        ))
    } else {
        None
    };
    let c_pkg = if is_windows {
        Some((
            "gcc-windows-x64",
            "14.2.0",
            store.installed_packages.contains("gcc-windows-x64"),
        ))
    } else {
        None
    };
    let python_pkg = if is_windows {
        Some((
            "python-windows-x64",
            "3.12.13",
            store.installed_packages.contains("python-windows-x64"),
        ))
    } else {
        Some((
            "python-macos-arm64",
            "3.12.13",
            store.installed_packages.contains("python-macos-arm64"),
        ))
    };
    let pascal_pkg = if is_windows {
        Some((
            "fpc-windows-x64",
            "3.2.2",
            store.installed_packages.contains("fpc-windows-x64"),
        ))
    } else {
        Some((
            "fpc-macos-arm64",
            "3.2.2",
            store.installed_packages.contains("fpc-macos-arm64"),
        ))
    };
    let java_pkg = if is_windows {
        Some((
            "temurin21-windows-x64",
            "21.0.12+8",
            store.installed_packages.contains("temurin21-windows-x64"),
        ))
    } else {
        Some((
            "temurin21-macos-arm64",
            "21.0.12+8",
            store.installed_packages.contains("temurin21-macos-arm64"),
        ))
    };
    let scratch_pkg = if is_windows {
        Some((
            "scratch-windows-x64",
            "0.1.7",
            store.installed_packages.contains("scratch-windows-x64"),
        ))
    } else {
        Some((
            "scratch-macos-arm64",
            "0.1.7",
            store.installed_packages.contains("scratch-macos-arm64"),
        ))
    };

    let cpp_candidates = vec![json!({
        "candidateId": "cpp-sys-1",
        "profileId": "cpp",
        "kind": "cpp",
        "canonicalPath": if is_windows { "C:\\MinGW\\bin\\g++.exe" } else { "/usr/bin/g++" },
        "displayPath": if is_windows { "C:\\MinGW\\bin\\g++.exe (14.2.0)" } else { "/usr/bin/g++ (14.2.0)" },
        "origin": "path",
        "pathRank": 0,
        "family": "gcc",
        "version": "14.2.0",
        "target": if is_windows { "x86_64-w64-mingw32" } else { "aarch64-apple-darwin" },
        "lastSeenAt": "2026-09-19T12:00:00Z",
        "error": null
    })];

    let c_candidates = vec![json!({
        "candidateId": "c-sys-1",
        "profileId": "c",
        "kind": "c",
        "canonicalPath": if is_windows { "C:\\MinGW\\bin\\gcc.exe" } else { "/usr/bin/gcc" },
        "displayPath": if is_windows { "C:\\MinGW\\bin\\gcc.exe (14.2.0)" } else { "/usr/bin/gcc (14.2.0)" },
        "origin": "path",
        "pathRank": 0,
        "family": "gcc",
        "version": "14.2.0",
        "target": if is_windows { "x86_64-w64-mingw32" } else { "aarch64-apple-darwin" },
        "lastSeenAt": "2026-09-19T12:00:00Z",
        "error": null
    })];

    let python_candidates = vec![json!({
        "candidateId": "python-sys-1",
        "profileId": "python",
        "kind": "python",
        "canonicalPath": if is_windows { "C:\\Python312\\python.exe" } else { "/usr/bin/python3" },
        "displayPath": if is_windows { "C:\\Python312\\python.exe (3.12.10)" } else { "/usr/bin/python3 (3.12.10)" },
        "origin": "path",
        "pathRank": 0,
        "family": "cpython",
        "version": "3.12.10",
        "target": if is_windows { "x86_64-pc-windows-msvc" } else { "aarch64-apple-darwin" },
        "lastSeenAt": "2026-09-19T12:00:00Z",
        "error": null
    })];

    let pascal_candidates = vec![json!({
        "candidateId": "pascal-sys-1",
        "profileId": "pascal",
        "kind": "pascal",
        "canonicalPath": if is_windows { "C:\\FPC\\3.2.2\\bin\\i386-win32\\fpc.exe" } else { "/usr/bin/fpc" },
        "displayPath": if is_windows { "C:\\FPC\\3.2.2\\bin\\i386-win32\\fpc.exe (3.2.2)" } else { "/usr/bin/fpc (3.2.2)" },
        "origin": "path",
        "pathRank": 0,
        "family": "fpc",
        "version": "3.2.2",
        "target": if is_windows { "x86_64-win64" } else { "aarch64-darwin" },
        "lastSeenAt": "2026-09-19T12:00:00Z",
        "error": null
    })];

    let java_candidates = vec![json!({
        "candidateId": "java-sys-1",
        "profileId": "java",
        "kind": "java",
        "canonicalPath": if is_windows { "C:\\Program Files\\Eclipse Adoptium\\jdk-21\\bin\\javac.exe" } else { "/usr/bin/javac" },
        "displayPath": if is_windows { "C:\\Program Files\\Eclipse Adoptium\\jdk-21\\bin\\javac.exe (21.0.12)" } else { "/usr/bin/javac (21.0.12)" },
        "origin": "path",
        "pathRank": 0,
        "family": "openjdk",
        "version": "21.0.12",
        "target": if is_windows { "x86_64-windows" } else { "aarch64-macos" },
        "lastSeenAt": "2026-09-19T12:00:00Z",
        "error": null
    })];

    let scratch_candidates = vec![json!({
        "candidateId": "scratch-sys-1",
        "profileId": "scratch",
        "kind": "scratch",
        "canonicalPath": if is_windows { "C:\\JudgeDesk\\scratch\\scratch-run.exe" } else { "/usr/local/bin/scratch-run" },
        "displayPath": if is_windows { "C:\\JudgeDesk\\scratch\\scratch-run.exe (0.1.7)" } else { "/usr/local/bin/scratch-run (0.1.7)" },
        "origin": "path",
        "pathRank": 0,
        "family": "turbowarp",
        "version": "0.1.7",
        "target": if is_windows { "x86_64-windows" } else { "aarch64-macos" },
        "lastSeenAt": "2026-09-19T12:00:00Z",
        "error": null
    })];

    let cpp_profile = build_profile_json(ProfileBuildSpec {
        id: "cpp",
        display_name_key: "languages.cpp",
        extensions: &[".cpp", ".cc", ".cxx"],
        kind: "cpp",
        supported_versions: &["14.2.0", "16.1.0"],
        selection: &cpp_sel,
        default_executable: if is_windows { "g++.exe" } else { "g++" },
        version: "14.2.0",
        roles: json!({ "submissionReady": true, "checkerReady": true }),
        managed_available: is_windows,
        managed_package: cpp_pkg,
        candidates: cpp_candidates,
    });
    let c_profile = build_profile_json(ProfileBuildSpec {
        id: "c",
        display_name_key: "languages.c",
        extensions: &[".c"],
        kind: "c",
        supported_versions: &["14.2.0", "16.1.0"],
        selection: &c_sel,
        default_executable: if is_windows { "gcc.exe" } else { "gcc" },
        version: "14.2.0",
        roles: json!({ "submissionReady": true, "checkerReady": true }),
        managed_available: is_windows,
        managed_package: c_pkg,
        candidates: c_candidates,
    });
    let python_profile = build_profile_json(ProfileBuildSpec {
        id: "python",
        display_name_key: "languages.python",
        extensions: &[".py"],
        kind: "python",
        supported_versions: &["3.12.10", "3.12.13"],
        selection: &python_sel,
        default_executable: if is_windows { "python.exe" } else { "python3" },
        version: "3.12.10",
        roles: json!({ "submissionReady": true, "checkerReady": true }),
        managed_available: true,
        managed_package: python_pkg,
        candidates: python_candidates,
    });
    let pascal_profile = build_profile_json(ProfileBuildSpec {
        id: "pascal",
        display_name_key: "languages.pascal",
        extensions: &[".pas"],
        kind: "pascal",
        supported_versions: &["3.2.2"],
        selection: &pascal_sel,
        default_executable: if is_windows { "fpc.exe" } else { "fpc" },
        version: "3.2.2",
        roles: json!({ "submissionReady": true, "checkerReady": false }),
        managed_available: true,
        managed_package: pascal_pkg,
        candidates: pascal_candidates,
    });
    let java_profile = build_profile_json(ProfileBuildSpec {
        id: "java",
        display_name_key: "languages.java",
        extensions: &[".java"],
        kind: "java",
        supported_versions: &["21.0.12"],
        selection: &java_sel,
        default_executable: if is_windows { "javac.exe" } else { "javac" },
        version: "21.0.12",
        roles: json!({ "submissionReady": true, "checkerReady": false }),
        managed_available: true,
        managed_package: java_pkg,
        candidates: java_candidates,
    });
    let scratch_profile = build_profile_json(ProfileBuildSpec {
        id: "scratch",
        display_name_key: "languages.scratch",
        extensions: &[".sb3"],
        kind: "scratch",
        supported_versions: &["0.1.7"],
        selection: &scratch_sel,
        default_executable: if is_windows {
            "scratch-run.exe"
        } else {
            "scratch-run"
        },
        version: "0.1.7",
        roles: json!({ "submissionReady": true, "checkerReady": false }),
        managed_available: true,
        managed_package: scratch_pkg,
        candidates: scratch_candidates,
    });

    let mut preferences = serde_json::Map::new();
    for (id, sel) in &store.selections {
        let mut obj = json!({ "mode": sel.mode });
        if let Some(ref path) = sel.local_path {
            obj["localPath"] = json!(path);
        }
        preferences.insert(id.clone(), obj);
    }

    let toolchains = if is_windows {
        vec![
            json!({
                "id": "gcc-windows-x64",
                "kind": "cpp",
                "version": "14.2.0",
                "platform": "win32",
                "arch": "x64",
                "installed": store.installed_packages.contains("gcc-windows-x64"),
                "downloadAvailable": true,
                "progress": { "id": "gcc-windows-x64", "status": "idle", "percent": 0, "bytesReceived": 0, "totalBytes": 0 }
            }),
            json!({
                "id": "python-windows-x64",
                "kind": "python",
                "version": "3.12.13",
                "platform": "win32",
                "arch": "x64",
                "installed": store.installed_packages.contains("python-windows-x64"),
                "downloadAvailable": true,
                "progress": { "id": "python-windows-x64", "status": "idle", "percent": 0, "bytesReceived": 0, "totalBytes": 0 }
            }),
            json!({
                "id": "fpc-windows-x64",
                "kind": "pascal",
                "version": "3.2.2",
                "platform": "win32",
                "arch": "x64",
                "installed": store.installed_packages.contains("fpc-windows-x64"),
                "downloadAvailable": true,
                "progress": { "id": "fpc-windows-x64", "status": "idle", "percent": 0, "bytesReceived": 0, "totalBytes": 0 }
            }),
            json!({
                "id": "temurin21-windows-x64",
                "kind": "java",
                "version": "21.0.12+8",
                "platform": "win32",
                "arch": "x64",
                "installed": store.installed_packages.contains("temurin21-windows-x64"),
                "downloadAvailable": true,
                "progress": { "id": "temurin21-windows-x64", "status": "idle", "percent": 0, "bytesReceived": 0, "totalBytes": 0 }
            }),
            json!({
                "id": "scratch-windows-x64",
                "kind": "scratch",
                "version": "0.1.7",
                "platform": "win32",
                "arch": "x64",
                "installed": store.installed_packages.contains("scratch-windows-x64"),
                "downloadAvailable": true,
                "progress": { "id": "scratch-windows-x64", "status": "idle", "percent": 0, "bytesReceived": 0, "totalBytes": 0 }
            }),
        ]
    } else {
        vec![
            json!({
                "id": "python-macos-arm64",
                "kind": "python",
                "version": "3.12.13",
                "platform": "darwin",
                "arch": "arm64",
                "installed": store.installed_packages.contains("python-macos-arm64"),
                "downloadAvailable": true,
                "progress": { "id": "python-macos-arm64", "status": "idle", "percent": 0, "bytesReceived": 0, "totalBytes": 0 }
            }),
            json!({
                "id": "fpc-macos-arm64",
                "kind": "pascal",
                "version": "3.2.2",
                "platform": "darwin",
                "arch": "arm64",
                "installed": store.installed_packages.contains("fpc-macos-arm64"),
                "downloadAvailable": true,
                "progress": { "id": "fpc-macos-arm64", "status": "idle", "percent": 0, "bytesReceived": 0, "totalBytes": 0 }
            }),
            json!({
                "id": "temurin21-macos-arm64",
                "kind": "java",
                "version": "21.0.12+8",
                "platform": "darwin",
                "arch": "arm64",
                "installed": store.installed_packages.contains("temurin21-macos-arm64"),
                "downloadAvailable": true,
                "progress": { "id": "temurin21-macos-arm64", "status": "idle", "percent": 0, "bytesReceived": 0, "totalBytes": 0 }
            }),
            json!({
                "id": "scratch-macos-arm64",
                "kind": "scratch",
                "version": "0.1.7",
                "platform": "darwin",
                "arch": "arm64",
                "installed": store.installed_packages.contains("scratch-macos-arm64"),
                "downloadAvailable": true,
                "progress": { "id": "scratch-macos-arm64", "status": "idle", "percent": 0, "bytesReceived": 0, "totalBytes": 0 }
            }),
        ]
    };

    Json(json!({
        "distribution": "full",
        "platform": platform,
        "arch": arch,
        "mutationsBlocked": false,
        "manifestStatus": "ready",
        "preferenceDocument": {
            "status": "ready",
            "revision": "1",
            "recoveryDiagnostics": []
        },
        "registryRevision": 1,
        "discovery": {
            "status": "complete",
            "refreshing": false
        },
        "executionPolicy": {
            "schemaVersion": 1,
            "allowResourceOnlyLocalExecution": true,
            "status": "ready"
        },
        "profiles": [
            cpp_profile.clone(),
            c_profile.clone(),
            python_profile.clone(),
            pascal_profile.clone(),
            java_profile.clone(),
            scratch_profile.clone(),
        ],
        "preferences": preferences,
        "active": {
            "cpp": cpp_profile["active"].clone(),
            "c": c_profile["active"].clone(),
            "python": python_profile["active"].clone(),
            "pascal": pascal_profile["active"].clone(),
            "java": java_profile["active"].clone(),
            "scratch": scratch_profile["active"].clone(),
        },
        "capabilities": {
            "cpp": {
                "detected": true,
                "managed": is_windows,
                "submissionReady": true,
                "checkerReady": true,
                "installable": is_windows
            },
            "c": {
                "detected": true,
                "managed": is_windows,
                "submissionReady": true,
                "checkerReady": true,
                "installable": is_windows
            },
            "python": {
                "detected": true,
                "managed": true,
                "submissionReady": true,
                "checkerReady": true,
                "installable": true
            },
            "pascal": {
                "detected": true,
                "managed": true,
                "submissionReady": true,
                "checkerReady": false,
                "installable": true
            },
            "java": {
                "detected": true,
                "managed": true,
                "submissionReady": true,
                "checkerReady": false,
                "installable": true
            },
            "scratch": {
                "detected": true,
                "managed": true,
                "submissionReady": true,
                "checkerReady": false,
                "installable": true
            }
        },
        "toolchains": toolchains
    }))
}

async fn handle_distribution() -> impl IntoResponse {
    Json(json!({
        "distribution": "full",
        "platform": if cfg!(windows) { "win32" } else { "darwin" },
        "arch": if cfg!(target_arch = "x86_64") { "x64" } else { "arm64" }
    }))
}

#[derive(Deserialize)]
struct SelectDirectoryPayload {
    #[serde(rename = "defaultPath", default)]
    #[allow(dead_code)]
    default_path: Option<String>,
}

async fn handle_toolchains_rescan() -> impl IntoResponse {
    (
        StatusCode::ACCEPTED,
        Json(json!({
            "success": true,
            "discovery": { "status": "complete", "refreshing": false }
        })),
    )
}

async fn handle_toolchains_execution_policy(
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    Json(json!({
        "success": true,
        "executionPolicy": body
    }))
}

async fn handle_toolchains_preference(
    State(state): State<AppState>,
    axum::extract::Path(profile_id): axum::extract::Path<String>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let normalized = normalize_profile_id(&profile_id);
    let mode = body
        .get("mode")
        .and_then(|v| v.as_str())
        .unwrap_or("local_auto")
        .to_string();
    let local_path = body
        .get("localPath")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    if let Ok(mut lock) = state.toolchains.write() {
        lock.selections.insert(
            normalized.to_string(),
            ProfileSelection { mode, local_path },
        );
    }

    Json(json!({
        "success": true,
        "preferenceDocument": {
            "status": "ready",
            "revision": "2",
            "recoveryDiagnostics": []
        },
        "registryRevision": 1
    }))
}

async fn handle_toolchains_prewarm() -> impl IntoResponse {
    Json(json!({
        "success": true,
        "message": "Background pre-warm initiated."
    }))
}

async fn handle_toolchains_certification_plan(
    axum::extract::Path(profile_id): axum::extract::Path<String>,
) -> impl IntoResponse {
    Json(json!({
        "success": true,
        "plan": {
            "profileId": profile_id,
            "mode": "local-snapshot",
            "canonicalExecutablePath": "g++",
            "sourceRoot": if cfg!(windows) { "C:\\MinGW" } else { "/usr/bin" },
            "relativeExecutablePath": if cfg!(windows) { "bin\\g++.exe" } else { "g++" },
            "fileCount": 100,
            "totalBytes": 35000000,
            "maxSupportedSnapshotBytes": 536870912
        }
    }))
}

async fn handle_toolchains_certify(
    axum::extract::Path(_profile_id): axum::extract::Path<String>,
    Json(_body): Json<serde_json::Value>,
) -> impl IntoResponse {
    Json(json!({
        "success": true,
        "certificate": {
            "certificateId": "cert-local-native",
            "certifiedAt": "2026-09-19T12:00:00Z"
        }
    }))
}

async fn handle_toolchains_diagnose(
    State(state): State<AppState>,
    axum::extract::Path(profile_id): axum::extract::Path<String>,
) -> impl IntoResponse {
    let (mode, local_path) = if let Ok(lock) = state.toolchains.read() {
        let normalized = normalize_profile_id(&profile_id);
        if let Some(sel) = lock.selections.get(normalized) {
            (Some(sel.mode.clone()), sel.local_path.clone())
        } else {
            (None, None)
        }
    } else {
        (None, None)
    };

    let result = crate::toolchains::diagnostics::diagnose_language_profile(
        &profile_id,
        &state.platform,
        mode.as_deref(),
        local_path.as_deref(),
    )
    .await;

    Json(json!({
        "success": result.success,
        "diagnostic": result
    }))
}

async fn handle_toolchains_custom_path(
    State(state): State<AppState>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let kind = body.get("kind").and_then(|v| v.as_str()).unwrap_or("cpp");
    let normalized = normalize_profile_id(kind);
    let path = body
        .get("path")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    if let Ok(mut lock) = state.toolchains.write() {
        lock.selections.insert(
            normalized.to_string(),
            ProfileSelection {
                mode: "local_path".to_string(),
                local_path: path,
            },
        );
    }

    Json(json!({
        "success": true,
        "profile": {
            "id": normalized,
            "detected": true,
            "status": "submission_ready"
        }
    }))
}

async fn handle_toolchains_install(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> impl IntoResponse {
    if let Ok(mut lock) = state.toolchains.write() {
        lock.installed_packages.insert(id.clone());
        let profiles: &[&str] = match id.as_str() {
            pkg if pkg.contains("gcc") => &["cpp", "c"],
            pkg if pkg.contains("python") => &["python"],
            pkg if pkg.contains("fpc") => &["pascal"],
            pkg if pkg.contains("temurin") => &["java"],
            pkg if pkg.contains("scratch") => &["scratch"],
            _ => &[],
        };
        for prof in profiles {
            if let Some(sel) = lock.selections.get_mut(*prof) {
                sel.mode = "managed".to_string();
            }
        }
    }
    Json(json!({ "success": true }))
}

async fn handle_toolchains_uninstall(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> impl IntoResponse {
    if let Ok(mut lock) = state.toolchains.write() {
        lock.installed_packages.remove(&id);
        let profiles: &[&str] = match id.as_str() {
            pkg if pkg.contains("gcc") => &["cpp", "c"],
            pkg if pkg.contains("python") => &["python"],
            pkg if pkg.contains("fpc") => &["pascal"],
            pkg if pkg.contains("temurin") => &["java"],
            pkg if pkg.contains("scratch") => &["scratch"],
            _ => &[],
        };
        for prof in profiles {
            if let Some(sel) = lock.selections.get_mut(*prof) {
                if sel.mode == "managed" {
                    sel.mode = "local_auto".to_string();
                }
            }
        }
    }
    Json(json!({ "success": true }))
}

async fn handle_toolchains_op_success() -> impl IntoResponse {
    Json(json!({ "success": true }))
}

async fn handle_osd_events() -> axum::response::sse::Sse<
    impl tokio_stream::Stream<Item = Result<axum::response::sse::Event, std::convert::Infallible>>,
> {
    let stream = tokio_stream::iter(vec![Ok(
        axum::response::sse::Event::default().comment("connected")
    )]);
    axum::response::sse::Sse::new(stream).keep_alive(axum::response::sse::KeepAlive::default())
}

async fn handle_select_directory(
    State(state): State<AppState>,
    Json(payload): Json<SelectDirectoryPayload>,
) -> impl IntoResponse {
    match state
        .directory_picker
        .select_directory(payload.default_path.as_deref())
    {
        Ok(Some(path_str)) => Json(json!({ "success": true, "path": path_str })),
        Ok(None) => Json(json!({ "success": false, "error": "Canceled" })),
        Err(e) => Json(json!({ "success": false, "error": e })),
    }
}

async fn handle_open_excel(State(state): State<AppState>, body: Bytes) -> Response {
    const MAGIC: [u8; 8] = [0x4a, 0x44, 0x58, 0x4c, 0x53, 0x58, 0x30, 0x31];
    if body.len() < 12 || body[..8] != MAGIC {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "success": false, "message": "Invalid score export payload" })),
        )
            .into_response();
    }

    let diag_len = u32::from_le_bytes(body[8..12].try_into().unwrap()) as usize;
    let offset = 12 + diag_len;
    if offset > body.len() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "success": false, "message": "Truncated score export payload" })),
        )
            .into_response();
    }

    let diag_bytes = &body[12..offset];
    let diag_json = String::from_utf8_lossy(diag_bytes);

    let workbook_bytes = &body[offset..];
    let export_dir = state
        .export_dir
        .clone()
        .unwrap_or_else(|| std::env::temp_dir().join(format!("export_{}", std::process::id())));
    if let Err(e) = std::fs::create_dir_all(&export_dir) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "success": false, "message": format!("Failed to create export directory: {e}") })),
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

    // Launch Excel or default system viewer via injected workbook opener
    if let Err(e) = state.workbook_opener.open_workbook(&book_path) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "success": false, "message": format!("Failed to open workbook: {e}") })),
        )
            .into_response();
    }

    Json(json!({
        "success": true,
        "path": book_path.to_string_lossy(),
        "diagnosticsPath": diag_path.to_string_lossy(),
        "openMode": "system-open"
    }))
    .into_response()
}

async fn handle_osd_status() -> impl IntoResponse {
    Json(json!({
        "success": true,
        "status": {
            "active": false,
            "watching": false
        }
    }))
}

async fn handle_osd_start() -> impl IntoResponse {
    Json(json!({
        "success": true,
        "status": {
            "active": true,
            "watching": true
        }
    }))
}

async fn handle_osd_stop() -> impl IntoResponse {
    Json(json!({
        "success": true,
        "status": {
            "active": false,
            "watching": false
        }
    }))
}

pub async fn start_embedded_server(
    port: u16,
) -> Result<(SocketAddr, tokio::task::JoinHandle<()>), Box<dyn std::error::Error + Send + Sync>> {
    start_embedded_server_with_state(port, AppState::default()).await
}

pub async fn start_embedded_server_with_state(
    port: u16,
    mut state: AppState,
) -> Result<(SocketAddr, tokio::task::JoinHandle<()>), Box<dyn std::error::Error + Send + Sync>> {
    let (shutdown_tx, mut shutdown_rx) = tokio::sync::mpsc::channel::<()>(1);
    state.shutdown_tx = Some(shutdown_tx);
    let app = create_router(state);

    let listener = tokio::net::TcpListener::bind(format!("127.0.0.1:{port}")).await?;
    let local_addr = listener.local_addr()?;

    let handle = tokio::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.recv().await;
            })
            .await;
    });

    Ok((local_addr, handle))
}
