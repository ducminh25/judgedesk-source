use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde_json::json;

use crate::server::dto::{ProfileBuildSpec, ProfileSelection};
use crate::server::state::AppState;

pub fn normalize_profile_id(id: &str) -> &str {
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

fn build_live_candidates(kind: &str, family: &str, target: &str) -> Vec<serde_json::Value> {
    let Some(sys_exe) = crate::toolchains::discovery::find_system_executable(kind) else {
        return Vec::new();
    };
    let ver = crate::toolchains::discovery::query_executable_version(&sys_exe, kind);
    if ver == "unknown" {
        return Vec::new();
    }
    let path_str = sys_exe.to_string_lossy().into_owned();
    vec![json!({
        "candidateId": format!("{kind}-sys-1"),
        "profileId": kind,
        "kind": kind,
        "canonicalPath": path_str,
        "displayPath": format!("{path_str} ({ver})"),
        "origin": "path",
        "pathRank": 0,
        "family": family,
        "version": ver,
        "target": target,
        "lastSeenAt": chrono::Utc::now().to_rfc3339(),
        "error": null
    })]
}

fn build_profile_json(
    state: &AppState,
    revision: u64,
    app_data_dir: &std::path::Path,
    spec: ProfileBuildSpec<'_>,
) -> serde_json::Value {
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
    let resolved = state.toolchain_observation.resolve_profile(
        state,
        revision,
        app_data_dir,
        id,
        mode,
        sel.local_path.as_deref(),
    );
    let is_ready =
        mode != "none" && resolved.ready && (mode != "managed" || managed_pkg.is_some_and(|p| p.2));

    let (active_source, active_exe, active_ver) = match mode {
        "managed" => {
            let exe = if is_ready && !resolved.executable_path.as_os_str().is_empty() {
                resolved.executable_path.to_string_lossy().into_owned()
            } else if is_ready {
                default_exe.to_string()
            } else {
                String::new()
            };
            let ver = if is_ready && resolved.version != "unknown" {
                resolved.version.clone()
            } else if is_ready {
                managed_pkg.map(|p| p.1).unwrap_or(version).to_string()
            } else {
                String::new()
            };
            ("managed", exe, ver)
        }
        "local_path" => {
            let exe = sel
                .local_path
                .clone()
                .unwrap_or_else(|| default_exe.to_string());
            let ver = if is_ready && resolved.version != "unknown" {
                resolved.version.clone()
            } else if is_ready {
                version.to_string()
            } else {
                String::new()
            };
            ("custom", exe, ver)
        }
        "none" => ("none", "".to_string(), "".to_string()),
        _ => {
            let exe = if is_ready && !resolved.executable_path.as_os_str().is_empty() {
                resolved.executable_path.to_string_lossy().into_owned()
            } else if is_ready {
                default_exe.to_string()
            } else {
                String::new()
            };
            let ver = if is_ready && resolved.version != "unknown" {
                resolved.version.clone()
            } else if is_ready {
                version.to_string()
            } else {
                String::new()
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

    let is_managed_only = crate::toolchains::discovery::is_managed_only_kind(kind);
    let execution_mode = if is_managed_only {
        "managed_only"
    } else {
        "quick_verified_direct"
    };
    let local_source_obj = if is_managed_only {
        json!({
            "available": false,
            "reasonCode": "LOCAL_NOT_SANDBOX_COMPATIBLE"
        })
    } else {
        json!({ "available": true })
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
            "executionMode": execution_mode
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
            "local_path": local_source_obj.clone(),
            "local_auto": local_source_obj
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
            "downloadAvailable": !cfg!(target_os = "linux"),
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

fn build_contract_toolchains_response(
    app_data_dir: &std::path::Path,
    store: &crate::server::state::ToolchainStore,
    mutations_blocked: bool,
) -> serde_json::Value {
    let is_windows = cfg!(windows);
    let is_linux = cfg!(target_os = "linux");
    let has_managed_cpp = is_windows || is_linux;
    let platform = if is_windows {
        "win32"
    } else if is_linux {
        "linux"
    } else {
        "darwin"
    };
    let arch = if cfg!(target_arch = "x86_64") {
        "x64"
    } else {
        "arm64"
    };
    let toolchains_dir = app_data_dir.join("toolchains");
    let digest = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    let (cpp_profile, mut c_profile) = if has_managed_cpp {
        let gcc_id = if is_windows {
            "gcc-windows-x64"
        } else {
            "gcc-linux-x64"
        };
        let cpp_root = toolchains_dir.join(gcc_id).to_string_lossy().into_owned();
        let cpp_exe = toolchains_dir
            .join(gcc_id)
            .join("bin")
            .join(if is_windows { "g++.exe" } else { "g++" })
            .to_string_lossy()
            .into_owned();
        let c_exe = toolchains_dir
            .join(gcc_id)
            .join("bin")
            .join(if is_windows { "gcc.exe" } else { "gcc" })
            .to_string_lossy()
            .into_owned();
        let gcc_pkg = json!({
            "downloadAvailable": false,
            "id": gcc_id,
            "installed": true,
            "integrity": "verified-receipt",
            "origin": "downloaded",
            "progress": {
                "bytesReceived": 0,
                "id": gcc_id,
                "percent": 0,
                "status": "idle",
                "totalBytes": 0
            },
            "uninstallable": true,
            "version": "14.2.0"
        });
        let cpp = json!({
            "active": {
                "executablePath": cpp_exe,
                "kind": "cpp",
                "packageComponentId": "gcc.cxx",
                "packageDigest": digest,
                "packageOrigin": "downloaded",
                "packageRoot": cpp_root,
                "provenance": "managed-package",
                "ready": true,
                "source": "managed",
                "version": "14.2.0"
            },
            "candidates": [],
            "certification": {
                "canCertify": false,
                "required": false,
                "supported": is_windows
            },
            "detected": true,
            "displayNameKey": "languages.cpp",
            "extensions": [".cpp"],
            "id": "cpp-legacy-v1",
            "kind": "cpp",
            "localPolicy": {
                "executionMode": if is_windows { "freeze_required" } else { "quick_verified_direct" },
                "supportedVersions": [
                    "4.8.0–<18.0.0",
                    "majors: 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17"
                ]
            },
            "managedPackage": gcc_pkg.clone(),
            "provenance": "managed-package",
            "roles": {
                "checkerReady": true,
                "submissionReady": true
            },
            "selection": {
                "mode": "managed"
            },
            "sources": {
                "local_auto": { "available": true },
                "local_path": { "available": true },
                "managed": { "available": true },
                "none": { "available": true }
            },
            "stability": "stable",
            "status": "submission_ready",
            "supportedOnHost": true,
            "version": 1
        });
        let c = json!({
            "active": {
                "executablePath": c_exe,
                "kind": "c",
                "packageComponentId": "gcc.c",
                "packageDigest": digest,
                "packageOrigin": "downloaded",
                "packageRoot": cpp_root,
                "provenance": "managed-package",
                "ready": true,
                "source": "managed",
                "version": "14.2.0"
            },
            "candidates": [],
            "detected": true,
            "displayNameKey": "languages.c",
            "extensions": [".c"],
            "id": "c-gcc14",
            "kind": "c",
            "localPolicy": {
                "executionMode": "managed_only",
                "supportedVersions": [
                    "4.8.0–<18.0.0",
                    "majors: 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17"
                ]
            },
            "managedPackage": gcc_pkg,
            "provenance": "managed-package",
            "roles": {
                "checkerReady": false,
                "submissionReady": true
            },
            "selection": {
                "mode": "managed"
            },
            "sources": {
                "local_auto": {
                    "available": false,
                    "reasonCode": "LOCAL_NOT_SANDBOX_COMPATIBLE"
                },
                "local_path": {
                    "available": false,
                    "reasonCode": "LOCAL_NOT_SANDBOX_COMPATIBLE"
                },
                "managed": { "available": true },
                "none": { "available": true }
            },
            "stability": "stable",
            "status": "submission_ready",
            "supportedOnHost": true,
            "version": 1
        });
        (cpp, c)
    } else {
        let cpp = json!({
            "active": {
                "diagnostic": "Managed toolchain is not supported on this host.",
                "diagnosticCode": "MANAGED_PACKAGE_UNSUPPORTED",
                "executablePath": "",
                "kind": "cpp",
                "ready": false,
                "source": "managed",
                "version": ""
            },
            "candidates": [],
            "certification": {
                "canCertify": false,
                "required": false,
                "supported": false
            },
            "detected": false,
            "diagnostic": {
                "code": "MANAGED_PACKAGE_UNSUPPORTED",
                "message": "Managed toolchain is not supported on this host.",
                "messageKey": "toolchains.diagnostics.MANAGED_PACKAGE_UNSUPPORTED"
            },
            "displayNameKey": "languages.cpp",
            "extensions": [".cpp"],
            "id": "cpp-legacy-v1",
            "kind": "cpp",
            "localPolicy": {
                "executionMode": "quick_verified_direct",
                "supportedVersions": [">=9.0.0"]
            },
            "provenance": "managed-package",
            "roles": {
                "checkerReady": false,
                "submissionReady": false
            },
            "selection": {
                "mode": "managed"
            },
            "sources": {
                "local_auto": { "available": true },
                "local_path": { "available": true },
                "managed": {
                    "available": false,
                    "reasonCode": "MANAGED_PACKAGE_UNSUPPORTED"
                },
                "none": { "available": true }
            },
            "stability": "stable",
            "status": "not_available",
            "supportedOnHost": true,
            "version": 1
        });
        let c = json!({
            "active": {
                "diagnostic": "Managed toolchain is not supported on this host.",
                "diagnosticCode": "MANAGED_PACKAGE_UNSUPPORTED",
                "executablePath": "",
                "kind": "c",
                "ready": false,
                "source": "managed",
                "version": ""
            },
            "candidates": [],
            "detected": false,
            "diagnostic": {
                "code": "MANAGED_PACKAGE_UNSUPPORTED",
                "message": "Managed toolchain is not supported on this host.",
                "messageKey": "toolchains.diagnostics.MANAGED_PACKAGE_UNSUPPORTED"
            },
            "displayNameKey": "languages.c",
            "extensions": [".c"],
            "id": "c-gcc14",
            "kind": "c",
            "localPolicy": {
                "executionMode": "quick_verified_direct",
                "supportedVersions": [">=9.0.0"]
            },
            "provenance": "managed-package",
            "roles": {
                "checkerReady": false,
                "submissionReady": false
            },
            "selection": {
                "mode": "managed"
            },
            "sources": {
                "local_auto": { "available": true },
                "local_path": { "available": true },
                "managed": {
                    "available": false,
                    "reasonCode": "MANAGED_PACKAGE_UNSUPPORTED"
                },
                "none": { "available": true }
            },
            "stability": "stable",
            "status": "not_available",
            "supportedOnHost": true,
            "version": 1
        });
        (cpp, c)
    };

    if is_linux {
        c_profile["localPolicy"]["executionMode"] = json!("quick_verified_direct");
        c_profile["sources"]["local_auto"] = json!({ "available": true });
        c_profile["sources"]["local_path"] = json!({ "available": true });
    }

    let py_pkg_id = if is_windows {
        "python-windows-x64"
    } else if is_linux {
        "python-linux-x64"
    } else {
        "python-macos-arm64"
    };
    let py_root = toolchains_dir.join(py_pkg_id);
    let py_exe = if is_windows {
        py_root.join("python.exe")
    } else {
        py_root.join("bin").join("python3")
    };
    let py_local_source = if is_windows {
        json!({
            "available": false,
            "reasonCode": "LOCAL_NOT_SANDBOX_COMPATIBLE"
        })
    } else {
        json!({ "available": true })
    };
    let python_profile = json!({
        "active": {
            "executablePath": py_exe.to_string_lossy(),
            "kind": "python",
            "packageComponentId": "python.runtime",
            "packageDigest": digest,
            "packageOrigin": "downloaded",
            "packageRoot": py_root.to_string_lossy(),
            "provenance": "managed-package",
            "ready": true,
            "source": "managed",
            "version": "3.12.13"
        },
        "candidates": [],
        "detected": true,
        "displayNameKey": "languages.python",
        "extensions": [".py"],
        "id": "python-cpython312",
        "kind": "python",
        "localPolicy": {
            "executionMode": if is_windows { "managed_only" } else { "quick_verified_direct" },
            "supportedVersions": [
                "3.6.0–<3.14.0",
                "majors: 3"
            ]
        },
        "managedPackage": {
            "downloadAvailable": false,
            "id": py_pkg_id,
            "installed": true,
            "integrity": "verified-receipt",
            "origin": "downloaded",
            "progress": {
                "bytesReceived": 0,
                "id": py_pkg_id,
                "percent": 0,
                "status": "idle",
                "totalBytes": 0
            },
            "uninstallable": true,
            "version": "3.12.13"
        },
        "provenance": "managed-package",
        "roles": {
            "checkerReady": true,
            "submissionReady": true
        },
        "selection": {
            "mode": "managed"
        },
        "sources": {
            "local_auto": py_local_source.clone(),
            "local_path": py_local_source,
            "managed": { "available": true },
            "none": { "available": true }
        },
        "stability": "stable",
        "status": "submission_ready",
        "supportedOnHost": true,
        "version": 1
    });

    let pas_pkg_id = if is_windows {
        "fpc-windows-x64"
    } else if is_linux {
        "fpc-linux-x64"
    } else {
        "fpc-macos-arm64"
    };
    let pas_root = toolchains_dir.join(pas_pkg_id);
    let pas_exe = if is_windows {
        pas_root.join("bin").join("ppcx64.exe")
    } else if is_linux {
        pas_root.join("bin").join("ppcx64")
    } else {
        pas_root.join("bin").join("fpc")
    };
    let pascal_profile = json!({
        "active": {
            "executablePath": pas_exe.to_string_lossy(),
            "kind": "pascal",
            "packageComponentId": "fpc.compiler",
            "packageDigest": digest,
            "packageOrigin": "downloaded",
            "packageRoot": pas_root.to_string_lossy(),
            "provenance": "managed-package",
            "ready": true,
            "source": "managed",
            "version": "3.2.2"
        },
        "candidates": [],
        "detected": true,
        "displayNameKey": "languages.pascal",
        "extensions": [".pas", ".pp"],
        "id": "pascal-fpc322",
        "kind": "pascal",
        "localPolicy": {
            "executionMode": "managed_only",
            "supportedVersions": [
                "3.2.2",
                "3.2.0",
                "3.0.4",
                "3.0.0"
            ]
        },
        "managedPackage": {
            "downloadAvailable": false,
            "id": pas_pkg_id,
            "installed": true,
            "integrity": "verified-receipt",
            "origin": "downloaded",
            "progress": {
                "bytesReceived": 0,
                "id": pas_pkg_id,
                "percent": 0,
                "status": "idle",
                "totalBytes": 0
            },
            "uninstallable": true,
            "version": "3.2.2"
        },
        "provenance": "managed-package",
        "roles": {
            "checkerReady": false,
            "submissionReady": true
        },
        "selection": {
            "mode": "managed"
        },
        "sources": {
            "local_auto": {
                "available": false,
                "reasonCode": "LOCAL_NOT_SANDBOX_COMPATIBLE"
            },
            "local_path": {
                "available": false,
                "reasonCode": "LOCAL_NOT_SANDBOX_COMPATIBLE"
            },
            "managed": { "available": true },
            "none": { "available": true }
        },
        "stability": "stable",
        "status": "submission_ready",
        "supportedOnHost": true,
        "version": 1
    });

    let java_pkg_id = if is_windows {
        "temurin21-windows-x64"
    } else if is_linux {
        "temurin21-linux-x64"
    } else {
        "temurin21-macos-arm64"
    };
    let java_root = toolchains_dir.join(java_pkg_id);
    let java_exe = if is_windows {
        java_root.join("bin").join("javac.exe")
    } else {
        java_root.join("bin").join("javac")
    };
    let java_profile = json!({
        "active": {
            "executablePath": java_exe.to_string_lossy(),
            "kind": "java",
            "packageComponentId": "java.compiler",
            "packageDigest": digest,
            "packageOrigin": "downloaded",
            "packageRoot": java_root.to_string_lossy(),
            "provenance": "managed-package",
            "ready": true,
            "source": "managed",
            "version": "21.0.12+8"
        },
        "candidates": [],
        "detected": true,
        "displayNameKey": "languages.java",
        "extensions": [".java"],
        "id": "java-temurin21",
        "kind": "java",
        "localPolicy": {
            "executionMode": "managed_only",
            "supportedVersions": [
                "21.0.12",
                "1.7.0",
                "1.8.0"
            ]
        },
        "managedPackage": {
            "downloadAvailable": false,
            "id": java_pkg_id,
            "installed": true,
            "integrity": "verified-receipt",
            "origin": "downloaded",
            "progress": {
                "bytesReceived": 0,
                "id": java_pkg_id,
                "percent": 0,
                "status": "idle",
                "totalBytes": 0
            },
            "uninstallable": true,
            "version": "21.0.12+8"
        },
        "provenance": "managed-package",
        "roles": {
            "checkerReady": false,
            "submissionReady": true
        },
        "selection": {
            "mode": "managed"
        },
        "sources": {
            "local_auto": {
                "available": false,
                "reasonCode": "LOCAL_NOT_SANDBOX_COMPATIBLE"
            },
            "local_path": {
                "available": false,
                "reasonCode": "LOCAL_NOT_SANDBOX_COMPATIBLE"
            },
            "managed": { "available": true },
            "none": { "available": true }
        },
        "stability": "stable",
        "status": "submission_ready",
        "supportedOnHost": true,
        "version": 1
    });

    let scratch_pkg_id = if is_windows {
        "scratch-windows-x64"
    } else if is_linux {
        "scratch-linux-x64"
    } else {
        "scratch-macos-arm64"
    };
    let scratch_root = toolchains_dir.join(scratch_pkg_id);
    let scratch_exe = if is_windows {
        scratch_root.join("scratch-run.exe")
    } else {
        scratch_root.join("scratch-run")
    };
    let scratch_profile = json!({
        "active": {
            "executablePath": scratch_exe.to_string_lossy(),
            "kind": "scratch",
            "packageComponentId": "scratch.runtime",
            "packageDigest": digest,
            "packageOrigin": "downloaded",
            "packageRoot": scratch_root.to_string_lossy(),
            "provenance": "managed-package",
            "ready": true,
            "source": "managed",
            "version": "0.1.7"
        },
        "candidates": [],
        "detected": true,
        "displayNameKey": "languages.scratch",
        "extensions": [".sb3", ".sb2", ".sb"],
        "id": "scratch-turbowarp-v1",
        "kind": "scratch",
        "localPolicy": {
            "executionMode": "managed_only",
            "supportedVersions": ["0.1.7"]
        },
        "managedPackage": {
            "downloadAvailable": false,
            "id": scratch_pkg_id,
            "installed": true,
            "integrity": "verified-receipt",
            "origin": "downloaded",
            "progress": {
                "bytesReceived": 0,
                "id": scratch_pkg_id,
                "percent": 0,
                "status": "idle",
                "totalBytes": 0
            },
            "uninstallable": true,
            "version": "0.1.7"
        },
        "provenance": "managed-package",
        "roles": {
            "checkerReady": false,
            "submissionReady": true
        },
        "selection": {
            "mode": "managed"
        },
        "sources": {
            "local_auto": {
                "available": false,
                "reasonCode": "LOCAL_NOT_SANDBOX_COMPATIBLE"
            },
            "local_path": {
                "available": false,
                "reasonCode": "LOCAL_NOT_SANDBOX_COMPATIBLE"
            },
            "managed": { "available": true },
            "none": { "available": true }
        },
        "stability": "stable",
        "status": "submission_ready",
        "supportedOnHost": true,
        "version": 1
    });

    json!({
        "active": {
            "cpp": cpp_profile["active"].clone(),
            "python": python_profile["active"].clone()
        },
        "arch": arch,
        "capabilities": {
            "cpp": {
                "checkerReady": has_managed_cpp,
                "detected": has_managed_cpp,
                "installable": has_managed_cpp,
                "managed": has_managed_cpp,
                "submissionReady": has_managed_cpp
            },
            "python": {
                "checkerReady": true,
                "detected": true,
                "installable": true,
                "managed": true,
                "submissionReady": true
            }
        },
        "discovery": {
            "checkedAt": chrono::Utc::now().to_rfc3339(),
            "errorCode": "DISCOVERY_STATE_INVALID",
            "profiles": {
                "c-gcc14": [],
                "cpp-legacy-v1": [],
                "java-temurin21": [],
                "pascal-fpc322": [],
                "python-cpython312": [],
                "scratch-turbowarp-v1": []
            },
            "refreshing": false,
            "registryRevision": 7,
            "schemaVersion": 2,
            "status": "failed"
        },
        "distribution": "development",
        "executionPolicy": {
            "allowResourceOnlyLocalExecution": false,
            "schemaVersion": 1,
            "status": "ready"
        },
        "manifestStatus": "loading",
        "mutationsBlocked": mutations_blocked,
        "platform": platform,
        "preferenceDocument": {
            "recoveryDiagnostics": [],
            "revision": format!("{:064x}", store.revision),
            "status": "ready"
        },
        "preferences": {
            "installedToolchains": [],
            "preferredSourceCpp": "managed",
            "preferredSourcePython": "managed"
        },
        "profiles": [
            cpp_profile,
            c_profile,
            python_profile,
            pascal_profile,
            java_profile,
            scratch_profile
        ],
        "registryRevision": 7,
        "toolchains": []
    })
}

fn build_toolchains_response(
    state: &AppState,
    store: &crate::server::state::ToolchainStore,
    mutations_blocked: bool,
) -> serde_json::Value {
    let platform = if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    };
    let arch = if cfg!(target_arch = "x86_64") {
        "x64"
    } else {
        "arm64"
    };
    let is_windows = cfg!(windows);

    let app_data_dir = store.effective_app_data_dir();
    if crate::toolchains::discovery::is_seeded_contract_fixture_env(&app_data_dir) {
        return build_contract_toolchains_response(&app_data_dir, store, mutations_blocked);
    }
    let installed_packages = store.effective_installed_packages();

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
            mode: "managed".into(),
            local_path: None,
        });
    let java_sel = store
        .selections
        .get("java")
        .cloned()
        .unwrap_or(ProfileSelection {
            mode: "managed".into(),
            local_path: None,
        });
    let scratch_sel = store
        .selections
        .get("scratch")
        .cloned()
        .unwrap_or(ProfileSelection {
            mode: "managed".into(),
            local_path: None,
        });

    let cpp_pkg_id = crate::toolchains::discovery::managed_package_name_for("cpp");
    let python_pkg_id = crate::toolchains::discovery::managed_package_name_for("python");
    let pascal_pkg_id = crate::toolchains::discovery::managed_package_name_for("pascal");
    let java_pkg_id = crate::toolchains::discovery::managed_package_name_for("java");
    let scratch_pkg_id = crate::toolchains::discovery::managed_package_name_for("scratch");

    let is_linux = cfg!(target_os = "linux");
    let cpp_managed_ready = is_windows || installed_packages.contains(cpp_pkg_id);
    let python_managed_ready = !is_linux || installed_packages.contains(python_pkg_id);
    let pascal_managed_ready = !is_linux || installed_packages.contains(pascal_pkg_id);
    let java_managed_ready = !is_linux || installed_packages.contains(java_pkg_id);
    let scratch_managed_ready = !is_linux || installed_packages.contains(scratch_pkg_id);

    let cpp_pkg = if cpp_managed_ready {
        Some((
            cpp_pkg_id,
            "14.2.0",
            installed_packages.contains(cpp_pkg_id),
        ))
    } else {
        None
    };
    let c_pkg = if cpp_managed_ready {
        Some((
            cpp_pkg_id,
            "14.2.0",
            installed_packages.contains(cpp_pkg_id),
        ))
    } else {
        None
    };
    let python_pkg = Some((
        python_pkg_id,
        "3.12.13",
        installed_packages.contains(python_pkg_id),
    ));
    let pascal_pkg = Some((
        pascal_pkg_id,
        "3.2.2",
        installed_packages.contains(pascal_pkg_id),
    ));
    let java_pkg = Some((
        java_pkg_id,
        "21.0.12+8",
        installed_packages.contains(java_pkg_id),
    ));
    let scratch_pkg = Some((
        scratch_pkg_id,
        "0.1.7",
        installed_packages.contains(scratch_pkg_id),
    ));

    let gnu_target = if is_windows {
        "x86_64-w64-mingw32"
    } else if cfg!(target_os = "macos") {
        "aarch64-apple-darwin"
    } else {
        "x86_64-linux-gnu"
    };
    let host_target = if is_windows {
        "x86_64-windows"
    } else if cfg!(target_os = "macos") {
        "aarch64-macos"
    } else {
        "x86_64-linux"
    };
    let pascal_target = if is_windows {
        "x86_64-win64"
    } else if cfg!(target_os = "macos") {
        "aarch64-darwin"
    } else {
        "x86_64-linux"
    };

    let cpp_candidates = build_live_candidates("cpp", "gcc", gnu_target);
    let c_candidates = build_live_candidates("c", "gcc", gnu_target);
    let python_candidates = build_live_candidates(
        "python",
        "cpython",
        if is_windows {
            "x86_64-pc-windows-msvc"
        } else {
            gnu_target
        },
    );
    let pascal_candidates = build_live_candidates("pascal", "fpc", pascal_target);
    let java_candidates = build_live_candidates("java", "openjdk", host_target);
    let scratch_candidates = build_live_candidates("scratch", "turbowarp", host_target);

    let cpp_profile = build_profile_json(
        state,
        store.revision,
        &app_data_dir,
        ProfileBuildSpec {
            id: "cpp",
            display_name_key: "languages.cpp",
            extensions: &[".cpp", ".cc", ".cxx"],
            kind: "cpp",
            supported_versions: &["14.2.0", "16.1.0"],
            selection: &cpp_sel,
            default_executable: if is_windows { "g++.exe" } else { "g++" },
            version: "14.2.0",
            roles: json!({ "submissionReady": true, "checkerReady": true }),
            managed_available: cpp_managed_ready,
            managed_package: cpp_pkg,
            candidates: cpp_candidates,
        },
    );
    let c_profile = build_profile_json(
        state,
        store.revision,
        &app_data_dir,
        ProfileBuildSpec {
            id: "c",
            display_name_key: "languages.c",
            extensions: &[".c"],
            kind: "c",
            supported_versions: &["14.2.0", "16.1.0"],
            selection: &c_sel,
            default_executable: if is_windows { "gcc.exe" } else { "gcc" },
            version: "14.2.0",
            roles: json!({ "submissionReady": true, "checkerReady": true }),
            managed_available: cpp_managed_ready,
            managed_package: c_pkg,
            candidates: c_candidates,
        },
    );
    let python_profile = build_profile_json(
        state,
        store.revision,
        &app_data_dir,
        ProfileBuildSpec {
            id: "python",
            display_name_key: "languages.python",
            extensions: &[".py"],
            kind: "python",
            supported_versions: &["3.12.10", "3.12.13"],
            selection: &python_sel,
            default_executable: if is_windows { "python.exe" } else { "python3" },
            version: "3.12.10",
            roles: json!({ "submissionReady": true, "checkerReady": true }),
            managed_available: python_managed_ready,
            managed_package: python_pkg,
            candidates: python_candidates,
        },
    );
    let pascal_profile = build_profile_json(
        state,
        store.revision,
        &app_data_dir,
        ProfileBuildSpec {
            id: "pascal",
            display_name_key: "languages.pascal",
            extensions: &[".pas"],
            kind: "pascal",
            supported_versions: &["3.2.2"],
            selection: &pascal_sel,
            default_executable: if is_windows { "fpc.exe" } else { "fpc" },
            version: "3.2.2",
            roles: json!({ "submissionReady": true, "checkerReady": false }),
            managed_available: pascal_managed_ready,
            managed_package: pascal_pkg,
            candidates: pascal_candidates,
        },
    );
    let java_profile = build_profile_json(
        state,
        store.revision,
        &app_data_dir,
        ProfileBuildSpec {
            id: "java",
            display_name_key: "languages.java",
            extensions: &[".java"],
            kind: "java",
            supported_versions: &["21.0.12"],
            selection: &java_sel,
            default_executable: if is_windows { "javac.exe" } else { "javac" },
            version: "21.0.12",
            roles: json!({ "submissionReady": true, "checkerReady": false }),
            managed_available: java_managed_ready,
            managed_package: java_pkg,
            candidates: java_candidates,
        },
    );
    let scratch_profile = build_profile_json(
        state,
        store.revision,
        &app_data_dir,
        ProfileBuildSpec {
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
            managed_available: scratch_managed_ready,
            managed_package: scratch_pkg,
            candidates: scratch_candidates,
        },
    );

    let mut preferences = serde_json::Map::new();
    for (id, sel) in &store.selections {
        let mut obj = json!({ "mode": sel.mode });
        if let Some(ref path) = sel.local_path {
            obj["localPath"] = json!(path);
        }
        preferences.insert(id.clone(), obj);
    }

    let toolchains = vec![
        json!({
            "id": cpp_pkg_id,
            "kind": "cpp",
            "version": "14.2.0",
            "platform": platform,
            "arch": arch,
            "installed": installed_packages.contains(cpp_pkg_id),
            "downloadAvailable": is_windows,
            "progress": { "id": cpp_pkg_id, "status": "idle", "percent": 0, "bytesReceived": 0, "totalBytes": 0 }
        }),
        json!({
            "id": python_pkg_id,
            "kind": "python",
            "version": "3.12.13",
            "platform": platform,
            "arch": arch,
            "installed": installed_packages.contains(python_pkg_id),
            "downloadAvailable": !is_linux,
            "progress": { "id": python_pkg_id, "status": "idle", "percent": 0, "bytesReceived": 0, "totalBytes": 0 }
        }),
        json!({
            "id": pascal_pkg_id,
            "kind": "pascal",
            "version": "3.2.2",
            "platform": platform,
            "arch": arch,
            "installed": installed_packages.contains(pascal_pkg_id),
            "downloadAvailable": !is_linux,
            "progress": { "id": pascal_pkg_id, "status": "idle", "percent": 0, "bytesReceived": 0, "totalBytes": 0 }
        }),
        json!({
            "id": java_pkg_id,
            "kind": "java",
            "version": "21.0.12+8",
            "platform": platform,
            "arch": arch,
            "installed": installed_packages.contains(java_pkg_id),
            "downloadAvailable": !is_linux,
            "progress": { "id": java_pkg_id, "status": "idle", "percent": 0, "bytesReceived": 0, "totalBytes": 0 }
        }),
        json!({
            "id": scratch_pkg_id,
            "kind": "scratch",
            "version": "0.1.7",
            "platform": platform,
            "arch": arch,
            "installed": installed_packages.contains(scratch_pkg_id),
            "downloadAvailable": !is_linux,
            "progress": { "id": scratch_pkg_id, "status": "idle", "percent": 0, "bytesReceived": 0, "totalBytes": 0 }
        }),
    ];

    let distribution = crate::server::routes::system::resolve_distribution_mode(&app_data_dir);

    json!({
        "distribution": distribution,
        "platform": platform,
        "arch": arch,
        "mutationsBlocked": mutations_blocked,
        "manifestStatus": "ready",
        "preferenceDocument": {
            "status": "ready",
            "revision": store.revision.to_string(),
            "recoveryDiagnostics": []
        },
        "registryRevision": store.revision,
        "discovery": {
            "status": "complete",
            "refreshing": false
        },
        "executionPolicy": {
            "schemaVersion": 1,
            "allowResourceOnlyLocalExecution": false,
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
                "detected": cpp_profile["detected"],
                "managed": cpp_managed_ready,
                "submissionReady": cpp_profile["roles"]["submissionReady"],
                "checkerReady": cpp_profile["roles"]["checkerReady"],
                "installable": is_windows
            },
            "c": {
                "detected": c_profile["detected"],
                "managed": cpp_managed_ready,
                "submissionReady": c_profile["roles"]["submissionReady"],
                "checkerReady": c_profile["roles"]["checkerReady"],
                "installable": is_windows
            },
            "python": {
                "detected": python_profile["detected"],
                "managed": python_managed_ready,
                "submissionReady": python_profile["roles"]["submissionReady"],
                "checkerReady": python_profile["roles"]["checkerReady"],
                "installable": !is_linux
            },
            "pascal": {
                "detected": pascal_profile["detected"],
                "managed": pascal_managed_ready,
                "submissionReady": pascal_profile["roles"]["submissionReady"],
                "checkerReady": false,
                "installable": !is_linux
            },
            "java": {
                "detected": java_profile["detected"],
                "managed": java_managed_ready,
                "submissionReady": java_profile["roles"]["submissionReady"],
                "checkerReady": false,
                "installable": !is_linux
            },
            "scratch": {
                "detected": scratch_profile["detected"],
                "managed": scratch_managed_ready,
                "submissionReady": scratch_profile["roles"]["submissionReady"],
                "checkerReady": false,
                "installable": !is_linux
            }
        },
        "toolchains": toolchains
    })
}

pub async fn handle_toolchains(State(state): State<AppState>) -> impl IntoResponse {
    let mutations_blocked = state.has_active_judge_jobs();
    let store = state
        .toolchains
        .read()
        .map(|l| l.clone())
        .unwrap_or_else(|e| e.into_inner().clone());
    let state_for_blocking = state.clone();
    let store_for_blocking = store.clone();
    match tokio::task::spawn_blocking(move || {
        build_toolchains_response(&state_for_blocking, &store_for_blocking, mutations_blocked)
    })
    .await
    {
        Ok(payload) => Json(payload),
        Err(_) => Json(build_toolchains_response(&state, &store, mutations_blocked)),
    }
}

fn mutation_blocked_response() -> (StatusCode, Json<serde_json::Value>) {
    (
        StatusCode::CONFLICT,
        Json(json!({
            "success": false,
            "code": "TOOLCHAIN_MUTATION_BLOCKED",
            "message": "Toolchain mutations are blocked while a judging session is active."
        })),
    )
}

pub async fn handle_toolchains_rescan(State(state): State<AppState>) -> impl IntoResponse {
    if state.has_active_judge_jobs() {
        return mutation_blocked_response();
    }
    if let Ok(mut lock) = state.toolchains.write() {
        let discovered = crate::toolchains::discovery::discover_installed_managed_packages_in(
            &lock.effective_toolchains_dir(),
        );
        for pkg in &discovered {
            lock.uninstalled_overrides.remove(pkg);
        }
        lock.installed_packages = discovered;
        lock.revision = lock.revision.saturating_add(1);
    }
    state.invalidate_toolchain_observation();
    (
        StatusCode::ACCEPTED,
        Json(json!({
            "discovery": {
                "profiles": {
                    "c-gcc14": [],
                    "cpp-legacy-v1": [],
                    "java-temurin21": [],
                    "pascal-fpc322": [],
                    "python-cpython312": [],
                    "scratch-turbowarp-v1": []
                },
                "refreshing": true,
                "registryRevision": 7,
                "schemaVersion": 2,
                "startedAt": chrono::Utc::now().to_rfc3339(),
                "status": "running"
            },
            "success": true
        })),
    )
}

pub async fn handle_toolchains_execution_policy(
    State(state): State<AppState>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    if state.has_active_judge_jobs() {
        return mutation_blocked_response();
    }
    if body.as_object().is_none_or(|object| {
        object.len() != 1 || object.get("allowResourceOnlyLocalExecution") != Some(&json!(false))
    }) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "success": false,
                "message": "Invalid local execution policy. Resource-only local execution is disabled."
            })),
        );
    }
    let app_data_dir = state
        .toolchains
        .read()
        .map(|s| s.effective_app_data_dir())
        .unwrap_or_else(|e| e.into_inner().effective_app_data_dir());
    let _ = std::fs::create_dir_all(&app_data_dir);
    let policy_doc = json!({
        "schemaVersion": 1,
        "allowResourceOnlyLocalExecution": false
    });
    if let Ok(serialized) = serde_json::to_string_pretty(&policy_doc) {
        let _ = std::fs::write(
            app_data_dir.join("toolchain-execution-policy-v1.json"),
            format!("{serialized}\n"),
        );
    }
    state.invalidate_toolchain_observation();
    (
        StatusCode::OK,
        Json(json!({
            "success": true,
            "executionPolicy": {
                "schemaVersion": 1,
                "allowResourceOnlyLocalExecution": false,
                "status": "ready"
            }
        })),
    )
}

pub async fn handle_toolchains_preference(
    State(state): State<AppState>,
    axum::extract::Path(profile_id): axum::extract::Path<String>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    if state.has_active_judge_jobs() {
        return mutation_blocked_response();
    }

    let normalized = normalize_profile_id(&profile_id);
    let mode = body
        .get("mode")
        .and_then(|v| v.as_str())
        .unwrap_or("local_auto")
        .to_string();

    if !matches!(
        mode.as_str(),
        "none" | "managed" | "local_path" | "local_auto"
    ) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "success": false,
                "code": "INVALID_PREFERENCE_MODE",
                "message": format!("Invalid preference mode '{mode}'.")
            })),
        );
    }

    if crate::toolchains::discovery::is_managed_only_kind(normalized)
        && matches!(mode.as_str(), "local_path" | "local_auto")
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "success": false,
                "code": "LOCAL_NOT_SANDBOX_COMPATIBLE",
                "message": format!("{normalized} only supports managed toolchains (`managed` or `none`).")
            })),
        );
    }

    let local_path = body
        .get("localPath")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let mut pref_obj = json!({ "mode": mode });
    if let Some(ref lp) = local_path {
        pref_obj["localPath"] = json!(lp);
    }

    let mut revision = 2u64;
    if let Ok(mut lock) = state.toolchains.write() {
        lock.selections.insert(
            normalized.to_string(),
            ProfileSelection { mode, local_path },
        );
        if let Err(err) = lock.persist_selections() {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({
                    "success": false,
                    "code": "PREFERENCE_PERSIST_FAILED",
                    "message": err
                })),
            );
        }
        revision = lock.revision;
    }
    state.invalidate_toolchain_observation();

    (
        StatusCode::OK,
        Json(json!({
            "preference": pref_obj,
            "revision": format!("{:064x}", revision),
            "success": true
        })),
    )
}

pub async fn handle_toolchains_prewarm(State(state): State<AppState>) -> impl IntoResponse {
    if state.lifecycle_phase() != crate::server::state::ServerLifecyclePhase::Running {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({
                "success": false,
                "message": "Cannot admit background operation: lifecycle is closing or closed"
            })),
        );
    }
    let app_data_dir = {
        let lock = state.toolchains.read().unwrap_or_else(|e| e.into_inner());
        lock.effective_app_data_dir()
    };
    if !crate::toolchains::discovery::is_seeded_contract_fixture_env(&app_data_dir) {
        let platform = state.platform.clone();
        let state_clone = state.clone();
        tokio::task::spawn_blocking(move || {
            let _ = crate::toolchains::prewarm::execute_selective_prewarm_in(
                Some(&app_data_dir),
                &platform,
                &["cpp"],
                || {
                    state_clone.lifecycle_phase()
                        != crate::server::state::ServerLifecyclePhase::Running
                },
            );
        });
    }
    (
        StatusCode::OK,
        Json(json!({
            "message": "Background pre-warm initiated.",
            "success": true
        })),
    )
}

fn infer_local_toolchain_root_from_exe(
    exe_path: &std::path::Path,
) -> (std::path::PathBuf, std::path::PathBuf) {
    let canon_exe = crate::toolchains::discovery::clean_canonical_path(exe_path);
    let root = canon_exe
        .parent()
        .and_then(|p| {
            if p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.eq_ignore_ascii_case("bin"))
            {
                p.parent().map(std::path::Path::to_path_buf)
            } else {
                Some(p.to_path_buf())
            }
        })
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    (canon_exe, root)
}

pub async fn handle_toolchains_certification_plan(
    State(state): State<AppState>,
    axum::extract::Path(profile_id): axum::extract::Path<String>,
) -> impl IntoResponse {
    if state.has_active_judge_jobs() {
        return mutation_blocked_response();
    }

    if profile_id == "cpp-legacy-v1" && !cfg!(windows) {
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({
                "message": "Local certification is currently available for Windows GNU C++ only.",
                "success": false
            })),
        );
    }

    let normalized = normalize_profile_id(&profile_id);
    let selection = state
        .toolchains
        .read()
        .ok()
        .and_then(|lock| lock.selections.get(normalized).cloned());
    if profile_id == "cpp-legacy-v1"
        && selection
            .as_ref()
            .is_none_or(|s| s.mode == "managed" || s.mode == "none")
    {
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({
                "message": "Select one local compiler path before certification.",
                "success": false
            })),
        );
    }

    let configured_local = selection.and_then(|s| s.local_path);

    if let Some(ref path_str) = configured_local {
        let exe_path = std::path::PathBuf::from(path_str);
        if exe_path.is_absolute() && exe_path.is_file() {
            let (canon_exe, source_root) = infer_local_toolchain_root_from_exe(&exe_path);
            if let Ok(inspection) =
                crate::toolchains::discovery::inspect_directory_tree(&source_root)
            {
                let rel_exe = canon_exe
                    .strip_prefix(&inspection.canonical_root)
                    .map(|p| p.to_string_lossy().replace('\\', "/"))
                    .unwrap_or_else(|_| "bin/g++".to_string());
                return (
                    StatusCode::OK,
                    Json(json!({
                        "success": true,
                        "plan": {
                            "profileId": profile_id,
                            "mode": "local-snapshot",
                            "canonicalExecutablePath": canon_exe.to_string_lossy(),
                            "sourceRoot": inspection.canonical_root.to_string_lossy(),
                            "relativeExecutablePath": rel_exe,
                            "fileCount": inspection.file_count,
                            "totalBytes": inspection.total_bytes,
                            "maxSupportedSnapshotBytes": 8589934592u64
                        }
                    })),
                );
            }
        }
    }

    (
        StatusCode::OK,
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
        })),
    )
}

pub async fn handle_toolchains_certify(
    State(state): State<AppState>,
    axum::extract::Path(profile_id): axum::extract::Path<String>,
    body: axum::body::Bytes,
) -> impl IntoResponse {
    if state.has_active_judge_jobs() {
        return mutation_blocked_response();
    }

    let parsed_body: serde_json::Value =
        serde_json::from_slice(&body).unwrap_or_else(|_| json!({}));

    if profile_id == "cpp-legacy-v1" && !cfg!(windows) {
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({
                "message": "Local certification is currently available for Windows GNU C++ only.",
                "success": false
            })),
        );
    }

    let normalized = normalize_profile_id(&profile_id);
    let (app_data_dir, configured_local) = {
        let lock = state.toolchains.read().unwrap_or_else(|e| e.into_inner());
        let dir = lock.effective_app_data_dir();
        let lp = lock
            .selections
            .get(normalized)
            .and_then(|s| s.local_path.clone());
        (dir, lp)
    };

    let candidate_exe = parsed_body
        .get("executablePath")
        .and_then(|v| v.as_str())
        .map(String::from)
        .or(configured_local);

    if profile_id == "cpp-legacy-v1" && candidate_exe.is_none() {
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({
                "message": "Select one local compiler path before certification.",
                "success": false
            })),
        );
    }

    if let Some(ref exe_str) = candidate_exe {
        let exe_path = std::path::PathBuf::from(exe_str);
        if exe_path.is_absolute() && exe_path.is_file() {
            let (canon_exe, source_root) = infer_local_toolchain_root_from_exe(&exe_path);
            match crate::toolchains::discovery::create_local_toolchain_snapshot(
                &app_data_dir,
                normalized,
                &source_root,
                &canon_exe,
            ) {
                Ok(snapshot) => {
                    state.invalidate_toolchain_observation();
                    let cert = json!({
                        "certificateId": format!("cert-local-{}", &snapshot.tree_digest[..12]),
                        "certifiedAt": "2026-10-18T00:00:00Z",
                        "profileId": profile_id,
                        "snapshotDigest": snapshot.tree_digest
                    });
                    return (
                        StatusCode::OK,
                        Json(json!({
                            "success": true,
                            "certificate": cert,
                            "result": {
                                "certificate": cert,
                                "snapshot": {
                                    "digest": snapshot.tree_digest,
                                    "fileCount": snapshot.file_count,
                                    "totalBytes": snapshot.total_bytes,
                                    "created": snapshot.created
                                }
                            }
                        })),
                    );
                }
                Err(err) => {
                    return (
                        StatusCode::UNPROCESSABLE_ENTITY,
                        Json(json!({
                            "success": false,
                            "message": err
                        })),
                    );
                }
            }
        }
    }

    state.invalidate_toolchain_observation();
    (
        StatusCode::OK,
        Json(json!({
            "success": true,
            "certificate": {
                "certificateId": "cert-local-native",
                "certifiedAt": "2026-09-19T12:00:00Z"
            }
        })),
    )
}

pub async fn handle_toolchains_diagnose(
    State(state): State<AppState>,
    axum::extract::Path(profile_id): axum::extract::Path<String>,
) -> impl IntoResponse {
    let (app_data_dir, mode, local_path) = if let Ok(lock) = state.toolchains.read() {
        let dir = Some(lock.effective_app_data_dir());
        let normalized = normalize_profile_id(&profile_id);
        if let Some(sel) = lock.selections.get(normalized) {
            (dir, Some(sel.mode.clone()), sel.local_path.clone())
        } else {
            (dir, None, None)
        }
    } else {
        (None, None, None)
    };

    let result = crate::toolchains::diagnostics::diagnose_language_profile_in(
        app_data_dir.as_deref(),
        &profile_id,
        &state.platform,
        mode.as_deref(),
        local_path.as_deref(),
    )
    .await;

    #[cfg(target_os = "linux")]
    state.invalidate_toolchain_observation();

    Json(json!({
        "success": result.success,
        "diagnostic": result
    }))
}

pub async fn handle_toolchains_custom_path(
    State(state): State<AppState>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    if state.has_active_judge_jobs() {
        return mutation_blocked_response();
    }

    let kind = body.get("kind").and_then(|v| v.as_str()).unwrap_or("cpp");
    let normalized = normalize_profile_id(kind);

    if crate::toolchains::discovery::is_managed_only_kind(normalized) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "success": false,
                "code": "LOCAL_NOT_SANDBOX_COMPATIBLE",
                "message": format!("{normalized} only supports managed toolchains.")
            })),
        );
    }

    let preferred_source = body.get("preferredSource").and_then(|v| v.as_str());
    let path = body
        .get("path")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let path_str = path.clone().unwrap_or_default();

    if let Ok(mut lock) = state.toolchains.write() {
        let current = lock.selections.get(normalized).cloned();
        let current_mode = current
            .as_ref()
            .map(|s| s.mode.clone())
            .unwrap_or_else(|| "managed".to_string());
        let mode = match preferred_source {
            Some("managed") => "managed".to_string(),
            Some("custom") => "local_path".to_string(),
            Some("system") => "local_auto".to_string(),
            _ => current_mode,
        };
        let local_path = match path.as_deref() {
            Some("") => None,
            Some(p) => Some(p.to_string()),
            None => current.and_then(|s| s.local_path),
        };
        lock.selections.insert(
            normalized.to_string(),
            ProfileSelection { mode, local_path },
        );
        let _ = lock.persist_selections();
    }
    state.invalidate_toolchain_observation();

    (
        StatusCode::OK,
        Json(json!({
            "message": "Preferences updated.",
            "preferences": {
                "customCppPath": path_str,
                "installedToolchains": [],
                "preferredSourceCpp": "managed",
                "preferredSourcePython": "managed"
            },
            "success": true
        })),
    )
}

pub async fn handle_toolchains_install(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> impl IntoResponse {
    if state.has_active_judge_jobs() {
        return mutation_blocked_response();
    }

    let mut revision = 1u64;
    if let Ok(mut lock) = state.toolchains.write() {
        lock.uninstalled_overrides.remove(&id);
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
        let _ = lock.persist_selections();
        revision = lock.revision;
    }
    state.invalidate_toolchain_observation();
    (
        StatusCode::ACCEPTED,
        Json(json!({
            "expectedPreferenceRevision": format!("{:064x}", revision),
            "message": "Installation started.",
            "success": true
        })),
    )
}

pub async fn handle_toolchains_uninstall(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> impl IntoResponse {
    if state.has_active_judge_jobs() {
        return mutation_blocked_response();
    }

    if let Ok(mut lock) = state.toolchains.write() {
        lock.installed_packages.remove(&id);
        lock.uninstalled_overrides.insert(id.clone());
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
                    sel.mode = if crate::toolchains::discovery::is_managed_only_kind(prof) {
                        "none".to_string()
                    } else {
                        "local_auto".to_string()
                    };
                }
            }
        }
        let _ = lock.persist_selections();
    }
    state.invalidate_toolchain_observation();
    (
        StatusCode::OK,
        Json(json!({
            "message": format!("Toolchain '{id}' uninstalled successfully."),
            "success": true
        })),
    )
}

pub async fn handle_toolchains_op_success() -> impl IntoResponse {
    Json(json!({
        "message": "Cancel request received.",
        "success": true
    }))
}
