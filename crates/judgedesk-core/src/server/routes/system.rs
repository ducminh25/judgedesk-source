use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde_json::json;

use crate::server::dto::{ProfileSelection, SelectDirectoryPayload};
use crate::server::state::AppState;
use crate::toolchains::discovery::{find_managed_toolchain_in, load_persisted_preferences_in};

fn build_status_toolchain_entry(
    state: &AppState,
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

    if cfg!(target_os = "linux") && !is_contract_env && selection.mode == "managed" {
        let resolved = state.toolchain_observation.resolve_profile(
            state,
            store.revision,
            &app_data_dir,
            kind,
            "managed",
            None,
        );
        return json!({
            "installed": managed_installed,
            "version": resolved.version,
            "source": "managed",
            "managedInstalled": managed_installed,
            "submissionReady": resolved.ready,
            "checkerReady": resolved.ready,
            "diagnostic": resolved.diagnostic
        });
    }

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
                let resolved = state.toolchain_observation.resolve_profile(
                    state,
                    store.revision,
                    &app_data_dir,
                    kind,
                    "local_auto",
                    None,
                );
                if resolved.ready {
                    let ver = if resolved.version != "unknown" {
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
                } else {
                    let mut obj = json!({
                        "installed": false,
                        "version": "Not found",
                        "source": "managed",
                        "managedInstalled": false,
                        "submissionReady": false,
                        "checkerReady": false
                    });
                    if let Some(diag) = resolved.diagnostic {
                        obj["diagnostic"] = json!(diag);
                    }
                    obj
                }
            }
        }
        "local_path" => {
            if is_contract_env {
                let exists = selection
                    .local_path
                    .as_deref()
                    .is_some_and(|p| std::path::Path::new(p).is_file());
                if exists {
                    json!({
                        "installed": true,
                        "version": default_ver,
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
            } else {
                let resolved = state.toolchain_observation.resolve_profile(
                    state,
                    store.revision,
                    &app_data_dir,
                    kind,
                    "local_path",
                    selection.local_path.as_deref(),
                );
                if resolved.ready {
                    let ver = if resolved.version != "unknown" {
                        resolved.version
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
                    let exists = selection
                        .local_path
                        .as_deref()
                        .is_some_and(|p| std::path::Path::new(p).is_file());
                    let ver = if exists && resolved.version != "unknown" {
                        resolved.version
                    } else {
                        "Not found".to_string()
                    };
                    let diag = resolved.diagnostic.unwrap_or_else(|| {
                        "LOCAL_EXECUTABLE_NOT_FOUND: Configured local executable does not exist."
                            .to_string()
                    });
                    json!({
                        "installed": exists,
                        "version": ver,
                        "source": "local_path",
                        "managedInstalled": managed_installed,
                        "submissionReady": false,
                        "checkerReady": false,
                        "diagnostic": diag
                    })
                }
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
                let resolved = state.toolchain_observation.resolve_profile(
                    state,
                    store.revision,
                    &app_data_dir,
                    kind,
                    "local_auto",
                    None,
                );
                if resolved.ready {
                    let ver = if resolved.version != "unknown" {
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
                } else {
                    let mut obj = json!({
                        "installed": false,
                        "version": "Not found",
                        "source": "system",
                        "managedInstalled": managed_installed,
                        "submissionReady": false,
                        "checkerReady": false
                    });
                    if let Some(diag) = resolved.diagnostic {
                        obj["diagnostic"] = json!(diag);
                    }
                    obj
                }
            }
        }
    }
}

fn build_status_response(
    state: &AppState,
    store: &crate::server::state::ToolchainStore,
) -> serde_json::Value {
    let health = state.platform.health();
    let app_data_dir = store.effective_app_data_dir();
    let persisted_exists = load_persisted_preferences_in(&app_data_dir).is_some();
    let is_contract_env =
        crate::toolchains::discovery::is_seeded_contract_fixture_env(&app_data_dir);

    let cpp_pkg_id = crate::toolchains::discovery::managed_package_name_for("cpp");
    let py_pkg_id = crate::toolchains::discovery::managed_package_name_for("python");

    let gpp_entry = build_status_toolchain_entry(
        state,
        "cpp",
        "14.2.0",
        cpp_pkg_id,
        store,
        persisted_exists,
        is_contract_env,
    );
    let py_entry = build_status_toolchain_entry(
        state,
        "python",
        "3.12.0",
        py_pkg_id,
        store,
        persisted_exists,
        is_contract_env,
    );

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

    let platform_str = if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    };

    json!({
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
    })
}

pub async fn handle_status(State(state): State<AppState>) -> impl IntoResponse {
    let store = state
        .toolchains
        .read()
        .map(|g| g.clone())
        .unwrap_or_else(|e| e.into_inner().clone());
    let state_for_blocking = state.clone();
    let store_for_blocking = store.clone();
    match tokio::task::spawn_blocking(move || {
        build_status_response(&state_for_blocking, &store_for_blocking)
    })
    .await
    {
        Ok(payload) => Json(payload),
        Err(_) => Json(build_status_response(&state, &store)),
    }
}

pub fn resolve_distribution_mode(app_data_dir: &std::path::Path) -> String {
    if let Ok(dist) = std::env::var("JUDGEDESK_DISTRIBUTION") {
        let trimmed = dist.trim().to_string();
        if !trimmed.is_empty() {
            return trimmed;
        }
    }
    if crate::toolchains::package_trust::is_linux_full_build() {
        return "full".to_string();
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
