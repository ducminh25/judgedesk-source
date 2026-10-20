use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde_json::json;

use crate::server::dto::{ProfileSelection, SelectDirectoryPayload};
use crate::server::state::AppState;
use crate::toolchains::discovery::{find_managed_toolchain_in, load_persisted_preferences_in};

fn build_status_toolchain_entry(
    kind: &str,
    default_ver: &str,
    pkg_id: &str,
    store: &crate::server::state::ToolchainStore,
    persisted_exists: bool,
    is_contract_env: bool,
) -> serde_json::Value {
    let app_data_dir = store.effective_app_data_dir();
    let toolchains_dir = store.effective_toolchains_dir();
    let installed_pkgs = store.effective_installed_packages();
    let uninstalled_overrides = &store.uninstalled_overrides;
    let default_sel = ProfileSelection {
        mode: "managed".to_string(),
        local_path: None,
    };
    let selection = store.selections.get(kind).unwrap_or(&default_sel);

    let managed_info = if uninstalled_overrides.contains(pkg_id) {
        None
    } else {
        find_managed_toolchain_in(&toolchains_dir, kind)
    };
    let managed_installed = installed_pkgs.contains(pkg_id) || managed_info.is_some();
    let managed_ver = managed_info
        .as_ref()
        .map(|m| m.version.as_str())
        .unwrap_or(default_ver);

    match selection.mode.as_str() {
        "none" => json!({
            "installed": false,
            "version": "Not found",
            "source": "none",
            "managedInstalled": managed_installed,
            "submissionReady": false,
            "checkerReady": false,
            "diagnostic": "Toolchain profile is disabled (mode=none)."
        }),
        "managed" => {
            if managed_installed {
                json!({
                    "installed": true,
                    "version": managed_ver,
                    "source": "managed",
                    "managedInstalled": true,
                    "submissionReady": true,
                    "checkerReady": true
                })
            } else if cfg!(target_os = "macos") && (kind == "cpp" || kind == "c") && is_contract_env
            {
                json!({
                    "installed": false,
                    "version": "Not found",
                    "source": "managed",
                    "managedInstalled": false,
                    "submissionReady": false,
                    "checkerReady": false,
                    "diagnostic": "Managed toolchain is not supported on this host."
                })
            } else if persisted_exists || uninstalled_overrides.contains(pkg_id) {
                json!({
                    "installed": false,
                    "version": "Not found",
                    "source": "managed",
                    "managedInstalled": false,
                    "submissionReady": false,
                    "checkerReady": false,
                    "diagnostic": format!("MANAGED_TOOLCHAIN_NOT_READY: Managed package for {kind} is not installed or its receipt is missing.")
                })
            } else if is_contract_env {
                json!({
                    "installed": true,
                    "version": default_ver,
                    "source": "system",
                    "managedInstalled": false,
                    "submissionReady": true,
                    "checkerReady": true
                })
            } else {
                let resolved = crate::toolchains::discovery::resolve_toolchain_for_profile_in(
                    Some(&app_data_dir),
                    kind,
                    Some("local_auto"),
                    None,
                );
                let ver = if resolved.ready && resolved.version != "unknown" {
                    resolved.version
                } else {
                    default_ver.to_string()
                };
                json!({
                    "installed": true,
                    "version": ver,
                    "source": "system",
                    "managedInstalled": false,
                    "submissionReady": true,
                    "checkerReady": true
                })
            }
        }
        "local_path" => {
            let exists = selection
                .local_path
                .as_deref()
                .is_some_and(|p| std::path::Path::new(p).is_file());
            if exists {
                let ver = if !is_contract_env {
                    let resolved = crate::toolchains::discovery::resolve_toolchain_for_profile_in(
                        Some(&app_data_dir),
                        kind,
                        Some("local_path"),
                        selection.local_path.as_deref(),
                    );
                    if resolved.ready && resolved.version != "unknown" {
                        resolved.version
                    } else {
                        default_ver.to_string()
                    }
                } else {
                    default_ver.to_string()
                };
                json!({
                    "installed": true,
                    "version": ver,
                    "source": "local_path",
                    "managedInstalled": managed_installed,
                    "submissionReady": true,
                    "checkerReady": true
                })
            } else {
                json!({
                    "installed": false,
                    "version": "Not found",
                    "source": "local_path",
                    "managedInstalled": managed_installed,
                    "submissionReady": false,
                    "checkerReady": false,
                    "diagnostic": "LOCAL_EXECUTABLE_NOT_FOUND: Configured local executable does not exist."
                })
            }
        }
        _ => {
            if is_contract_env {
                json!({
                    "installed": true,
                    "version": default_ver,
                    "source": "system",
                    "managedInstalled": managed_installed,
                    "submissionReady": true,
                    "checkerReady": true
                })
            } else {
                let resolved = crate::toolchains::discovery::resolve_toolchain_for_profile_in(
                    Some(&app_data_dir),
                    kind,
                    Some("local_auto"),
                    None,
                );
                let ver = if resolved.ready && resolved.version != "unknown" {
                    resolved.version
                } else {
                    default_ver.to_string()
                };
                json!({
                    "installed": true,
                    "version": ver,
                    "source": "system",
                    "managedInstalled": managed_installed,
                    "submissionReady": true,
                    "checkerReady": true
                })
            }
        }
    }
}

pub async fn handle_status(State(state): State<AppState>) -> impl IntoResponse {
    let health = state.platform.health();
    let (gpp_entry, py_entry) = {
        let store = state.toolchains.read().unwrap_or_else(|e| e.into_inner());
        let app_data_dir = store.effective_app_data_dir();
        let persisted_exists = load_persisted_preferences_in(&app_data_dir).is_some();
        let is_contract_env =
            crate::toolchains::discovery::is_seeded_contract_fixture_env(&app_data_dir);

        let cpp_pkg_id = crate::toolchains::discovery::managed_package_name_for("cpp");
        let py_pkg_id = crate::toolchains::discovery::managed_package_name_for("python");

        let gpp = build_status_toolchain_entry(
            "cpp",
            "14.2.0",
            cpp_pkg_id,
            &store,
            persisted_exists,
            is_contract_env,
        );
        let py = build_status_toolchain_entry(
            "python",
            "3.12.0",
            py_pkg_id,
            &store,
            persisted_exists,
            is_contract_env,
        );
        (gpp, py)
    };

    let mut secure_runner = json!({
        "mode": health.mode,
        "ready": health.ready,
        "executorVersion": health.executor_version,
        "diagnostics": health.diagnostics,
        "networkBlocked": health.network_blocked,
        "filesystemIsolated": health.filesystem_isolated,
        "processTreeControlled": health.process_tree_controlled,
        "memoryLimitSupported": health.memory_limit_supported
    });
    if health.ready {
        secure_runner["selfTestAt"] = json!(chrono::Utc::now().to_rfc3339());
    }

    let temp_dir = std::env::temp_dir()
        .join("judgedesk")
        .to_string_lossy()
        .into_owned();

    let is_contract_env = {
        let store = state.toolchains.read().unwrap_or_else(|e| e.into_inner());
        crate::toolchains::discovery::is_seeded_contract_fixture_env(
            &store.effective_app_data_dir(),
        )
    };
    let platform_str = if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") || is_contract_env {
        "darwin"
    } else {
        "linux"
    };

    Json(json!({
        "gpp": gpp_entry,
        "python": py_entry,
        "isolate": {
            "installed": false
        },
        "tempDir": temp_dir,
        "platform": platform_str,
        "isServerMode": false,
        "build": crate::build_metadata::BUILD_METADATA,
        "sandbox": {
            "docker": {
                "installed": false,
                "ready": false
            },
            "mode": "none",
            "ready": false,
            "wsl": {
                "installed": false,
                "ready": false
            }
        },
        "secureRunner": secure_runner
    }))
}

pub fn resolve_distribution_mode(app_data_dir: &std::path::Path) -> String {
    if let Ok(dist) = std::env::var("JUDGEDESK_DISTRIBUTION") {
        let trimmed = dist.trim().to_string();
        if !trimmed.is_empty() {
            return trimmed;
        }
    }
    let state_file = app_data_dir.join("toolchain-distribution-state-v1.json");
    if let Ok(raw) = std::fs::read_to_string(&state_file) {
        if let Some(dist) = serde_json::from_str::<serde_json::Value>(&raw)
            .ok()
            .and_then(|v| {
                v.get("distribution")
                    .or_else(|| v.get("lastDistribution"))
                    .and_then(|d| d.as_str())
                    .map(String::from)
            })
        {
            return dist;
        }
    }
    if !crate::toolchains::discovery::is_isolated_test_root(app_data_dir) {
        if let Ok(res_dir) = std::env::var("THEMIS_RESOURCE_DIR") {
            let trimmed = res_dir.trim();
            if !trimmed.is_empty() {
                let dist_file = std::path::Path::new(trimmed).join("judgedesk-distribution.json");
                if let Ok(raw) = std::fs::read_to_string(&dist_file) {
                    if let Some(dist) = serde_json::from_str::<serde_json::Value>(&raw)
                        .ok()
                        .and_then(|v| {
                            v.get("distribution")
                                .and_then(|d| d.as_str())
                                .map(String::from)
                        })
                    {
                        return dist;
                    }
                }
            }
        }
    }
    "full".to_string()
}

pub async fn handle_distribution(State(state): State<AppState>) -> impl IntoResponse {
    let app_data_dir = state
        .toolchains
        .read()
        .map(|s| s.effective_app_data_dir())
        .unwrap_or_else(|e| e.into_inner().effective_app_data_dir());
    let distribution = resolve_distribution_mode(&app_data_dir);
    let mut body = json!({
        "distribution": distribution,
        "platform": if cfg!(windows) {
            "win32"
        } else if cfg!(target_os = "macos") {
            "darwin"
        } else {
            "linux"
        },
        "arch": if cfg!(target_arch = "x86_64") { "x64" } else { "arm64" }
    });
    if let Ok(bundle_type) = std::env::var("JUDGEDESK_BUNDLE_TYPE") {
        let normalized = bundle_type.trim().to_ascii_lowercase();
        if matches!(normalized.as_str(), "deb" | "rpm" | "appimage") {
            if let Some(obj) = body.as_object_mut() {
                obj.insert("bundleType".to_string(), json!(normalized));
            }
        }
    }
    Json(body)
}

pub async fn handle_select_directory(
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

pub async fn handle_shutdown(State(state): State<AppState>) -> impl IntoResponse {
    state.set_lifecycle_phase(crate::server::state::ServerLifecyclePhase::Draining);
    let _ = state.osd.stop();
    let _ = state.cancel_judge_job(None);
    state.set_lifecycle_phase(crate::server::state::ServerLifecyclePhase::Stopping);

    if let Err(error) = state.platform.shutdown().await {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({
                "success": false,
                "error": format!("native executor drain failed: {error}"),
            })),
        )
            .into_response();
    }
    state.set_lifecycle_phase(crate::server::state::ServerLifecyclePhase::Stopped);

    if let Some(tx) = state.shutdown_tx {
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            let _ = tx.send(()).await;
        });
    }
    Json(json!({ "success": true })).into_response()
}
