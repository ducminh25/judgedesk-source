use judgedesk_core::server::{start_embedded_server_with_state, AppState};
use judgedesk_core::toolchains::discovery::{
    resolve_macos_framework_python_executable, resolve_toolchain_for_profile,
    resolve_toolchain_for_profile_with_policy, ExecutionPolicyMode,
};
use std::fs;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

mod common;

async fn http_request(
    port: u16,
    method: &str,
    path: &str,
    body: Option<&[u8]>,
    content_type: Option<&str>,
) -> (u16, String) {
    let mut stream = TcpStream::connect(format!("127.0.0.1:{port}"))
        .await
        .expect("connect to server");

    let ct_header = content_type
        .map(|ct| format!("Content-Type: {ct}\r\n"))
        .unwrap_or_default();
    let body_len = body.map(|b| b.len()).unwrap_or(0);

    let req_header = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{ct_header}Content-Length: {body_len}\r\nConnection: close\r\n\r\n"
    );

    stream.write_all(req_header.as_bytes()).await.unwrap();
    if let Some(b) = body {
        stream.write_all(b).await.unwrap();
    }

    let mut response = Vec::new();
    stream.read_to_end(&mut response).await.unwrap();
    let resp_str = String::from_utf8_lossy(&response).to_string();

    let status_code = resp_str
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .unwrap_or(500);

    let body_part = if let Some(pos) = resp_str.find("\r\n\r\n") {
        resp_str[pos + 4..].to_string()
    } else {
        resp_str
    };

    (status_code, body_part)
}

#[tokio::test]
async fn test_step2_preferences_atomic_persistence_and_no_fake_package_seeding() {
    let env = common::OwnedTestEnvironment::new();
    let app_data_dir = env.root().join("app_data_step2");
    fs::create_dir_all(app_data_dir.join("toolchains")).unwrap();

    let mut state = env.with_isolated_roots(|| {
        AppState::new(Arc::new(
            judgedesk_core::executor_client::ExecutorClient::unavailable("step2 store test"),
        ))
    });
    state.set_app_data_dir(app_data_dir.clone());

    // 1. With empty toolchains directory, no fake packages may be seeded!
    {
        let store = state.toolchains.read().unwrap();
        assert!(
            store.installed_packages.is_empty(),
            "ToolchainStore must not seed fake packages when toolchains dir is empty, got: {:?}",
            store.installed_packages
        );
    }

    let (addr, server_task) = start_embedded_server_with_state(0, state.clone())
        .await
        .expect("start server");
    let port = addr.port();

    let (status, body) = http_request(port, "GET", "/api/toolchains", None, None).await;
    assert_eq!(status, 200);
    let json: serde_json::Value = serde_json::from_str(&body).unwrap();
    let toolchains_arr = json["toolchains"].as_array().expect("toolchains array");
    assert!(
        toolchains_arr
            .iter()
            .all(|pkg| pkg["installed"] == serde_json::json!(false)),
        "All managed packages must report installed=false when toolchains dir is empty: {toolchains_arr:?}"
    );

    // 2. Atomic write of toolchain-preferences.json (Schema v2 compatible with Node)
    let pref_payload = br#"{"mode":"local_path","localPath":"C:\\CustomGCC\\bin\\g++.exe"}"#;
    let (status, body) = http_request(
        port,
        "PUT",
        "/api/toolchains/profiles/cpp/preference",
        Some(pref_payload),
        Some("application/json"),
    )
    .await;
    assert_eq!(status, 200, "PUT preference failed: {body}");

    let prefs_file = app_data_dir.join("toolchain-preferences.json");
    assert!(
        prefs_file.is_file(),
        "toolchain-preferences.json must be persisted atomically at {}",
        prefs_file.display()
    );
    let raw_prefs: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&prefs_file).unwrap()).unwrap();
    assert_eq!(raw_prefs["schemaVersion"], 2);
    let cpp_entry = raw_prefs["profiles"]
        .get("cpp-legacy-v1")
        .or_else(|| raw_prefs["profiles"].get("cpp"))
        .expect("cpp profile entry in toolchain-preferences.json");
    assert_eq!(cpp_entry["mode"], "local_path");
    assert_eq!(cpp_entry["localPath"], "C:\\CustomGCC\\bin\\g++.exe");

    server_task.abort();
}

#[test]
fn test_step2_strict_source_no_fallback() {
    let env = common::OwnedTestEnvironment::new();
    let empty_app_data = env.root().join("empty_app_data");
    fs::create_dir_all(empty_app_data.join("toolchains")).unwrap();

    // Temporarily point THEMIS_APP_DATA_DIR to empty_app_data so no managed packages exist
    let prev = std::env::var_os("THEMIS_APP_DATA_DIR");
    std::env::set_var("THEMIS_APP_DATA_DIR", &empty_app_data);

    // 1. mode = "managed" when managed package is missing MUST NOT fall back to system/local_auto
    let resolved_managed = resolve_toolchain_for_profile("cpp", Some("managed"), None);
    assert!(
        !resolved_managed.ready,
        "managed mode must fail closed when managed package is missing, not fall back to system"
    );
    assert_eq!(resolved_managed.source_mode, "managed");

    // 2. mode = "local_path" with missing path MUST NOT fall back to managed or system
    let resolved_local = resolve_toolchain_for_profile(
        "cpp",
        Some("local_path"),
        Some("Z:\\nonexistent_toolchain_dir\\bin\\g++.exe"),
    );
    assert!(
        !resolved_local.ready,
        "local_path mode must fail closed when configured path is invalid"
    );
    assert_eq!(resolved_local.source_mode, "local_path");

    // 3. mode = "none" MUST return ready = false
    let resolved_none = resolve_toolchain_for_profile("cpp", Some("none"), None);
    assert!(!resolved_none.ready, "none mode must never resolve ready");
    assert_eq!(resolved_none.source_mode, "none");

    match prev {
        Some(v) => std::env::set_var("THEMIS_APP_DATA_DIR", v),
        None => std::env::remove_var("THEMIS_APP_DATA_DIR"),
    }
}

#[test]
fn test_step2_quick_verified_direct_and_macos_framework_python_resolution() {
    let env = common::OwnedTestEnvironment::new();

    // 1. Test macOS Framework Python launcher stub resolution to Resources/Python.app/Contents/MacOS/Python
    let framework_ver_root = env
        .root()
        .join("Library")
        .join("Frameworks")
        .join("Python.framework")
        .join("Versions")
        .join("3.12");
    let bin_dir = framework_ver_root.join("bin");
    let real_macos_dir = framework_ver_root
        .join("Resources")
        .join("Python.app")
        .join("Contents")
        .join("MacOS");
    fs::create_dir_all(&bin_dir).unwrap();
    fs::create_dir_all(&real_macos_dir).unwrap();

    let stub_python = bin_dir.join("python3");
    let direct_python = real_macos_dir.join("Python");
    fs::write(&stub_python, b"stub").unwrap();
    fs::write(&direct_python, b"real-mach-o").unwrap();

    let (resolved_exe, inferred_root) =
        resolve_macos_framework_python_executable(&stub_python).expect("resolve framework python");
    assert_eq!(
        resolved_exe,
        judgedesk_core::toolchains::discovery::clean_canonical_path(&direct_python),
        "Framework bin/python3 stub must resolve to Resources/Python.app/Contents/MacOS/Python"
    );
    assert_eq!(
        inferred_root,
        judgedesk_core::toolchains::discovery::clean_canonical_path(&framework_ver_root)
    );

    // 2. Test quick_verified_direct bounded probe rejects a fake/corrupt compiler binary
    let fake_bin_dir = env.root().join("fake_gcc").join("bin");
    fs::create_dir_all(&fake_bin_dir).unwrap();
    let fake_gcc = fake_bin_dir.join(if cfg!(windows) { "gcc.exe" } else { "gcc" });
    fs::write(&fake_gcc, b"not a valid compiler executable").unwrap();

    let bad_probe = resolve_toolchain_for_profile_with_policy(
        "c",
        Some("local_path"),
        Some(&fake_gcc.to_string_lossy()),
        ExecutionPolicyMode::QuickVerifiedDirect,
        None,
    );
    assert!(
        !bad_probe.ready,
        "quick_verified_direct must reject a binary that fails the bounded native probe"
    );
}

#[test]
fn test_step2_freeze_required_blocks_unmatched_thumbprint() {
    // Discover a real compiler or python executable on the host to test thumbprint enforcement
    let exe_str = if cfg!(target_os = "macos") && std::path::Path::new("/usr/bin/clang").is_file() {
        "/usr/bin/clang".to_string()
    } else {
        let real_c = resolve_toolchain_for_profile("c", None, None);
        assert!(
            real_c.ready,
            "real C toolchain required for freeze_required test"
        );
        real_c.executable_path.to_string_lossy().into_owned()
    };

    // 1. Mismatched thumbprint must be blocked by FreezeRequired
    let blocked = resolve_toolchain_for_profile_with_policy(
        "c",
        Some("local_path"),
        Some(&exe_str),
        ExecutionPolicyMode::FreezeRequired,
        Some("0000000000000000000000000000000000000000"),
    );
    assert!(
        !blocked.ready,
        "freeze_required must reject local binary when thumbprint mismatches"
    );
    let diag = blocked.diagnostic.unwrap_or_default();
    assert!(
        diag.contains("THUMBPRINT") || diag.contains("CERTIF"),
        "expected certificate/thumbprint diagnostic, got: {diag}"
    );

    // 2. Missing thumbprint in FreezeRequired mode must also fail closed
    let missing_cert = resolve_toolchain_for_profile_with_policy(
        "c",
        Some("local_path"),
        Some(&exe_str),
        ExecutionPolicyMode::FreezeRequired,
        None,
    );
    assert!(
        !missing_cert.ready,
        "freeze_required must reject local binary when no expected thumbprint is provided"
    );
}

#[tokio::test]
async fn test_step2_managed_only_languages_and_active_judging_mutation_lock() {
    let env = common::OwnedTestEnvironment::new();
    let app_data_dir = env.root().join("app_data_lock");
    fs::create_dir_all(app_data_dir.join("toolchains")).unwrap();

    let mut state = env.with_isolated_roots(|| {
        AppState::new(Arc::new(
            judgedesk_core::executor_client::ExecutorClient::unavailable("step2 lock test"),
        ))
    });
    state.set_app_data_dir(app_data_dir);

    let (addr, server_task) = start_embedded_server_with_state(0, state.clone())
        .await
        .expect("start server");
    let port = addr.port();

    // 1. Pascal, Java, and Scratch reject local_path/local_auto when managed_only (Windows/macOS),
    // and accept local_path/local_auto on Linux where system bwrap sandboxing supports them.
    for lang in ["pascal", "java", "scratch"] {
        let expected_status = if judgedesk_core::toolchains::discovery::is_managed_only_kind(lang) {
            400
        } else {
            200
        };
        let payload = format!(r#"{{"mode":"local_path","localPath":"C:\\fake\\{lang}.exe"}}"#);
        let (status, body) = http_request(
            port,
            "PUT",
            &format!("/api/toolchains/profiles/{lang}/preference"),
            Some(payload.as_bytes()),
            Some("application/json"),
        )
        .await;
        assert_eq!(
            status, expected_status,
            "{lang} preference local_path expected {expected_status}, got {status}: {body}"
        );

        let custom_payload = format!(r#"{{"kind":"{lang}","path":"C:\\fake\\{lang}.exe"}}"#);
        let (status2, body2) = http_request(
            port,
            "POST",
            "/api/toolchains/custom-path",
            Some(custom_payload.as_bytes()),
            Some("application/json"),
        )
        .await;
        assert_eq!(
            status2, expected_status,
            "{lang} custom-path expected {expected_status}, got {status2}: {body2}"
        );
    }

    // 2. Acquire an active judge session lease and verify all toolchain mutations return 409 Conflict
    let lease = state
        .try_acquire_judge_lease("active-judge-job-1")
        .expect("acquire judge lease");

    let (status, body) = http_request(port, "GET", "/api/toolchains", None, None).await;
    assert_eq!(status, 200);
    let json: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(
        json["mutationsBlocked"],
        serde_json::json!(true),
        "GET /api/toolchains must report mutationsBlocked=true during active judging"
    );

    let (status_pref, body_pref) = http_request(
        port,
        "PUT",
        "/api/toolchains/profiles/cpp/preference",
        Some(br#"{"mode":"managed"}"#),
        Some("application/json"),
    )
    .await;
    assert_eq!(
        status_pref, 409,
        "PUT preference must return 409 Conflict during active judging, got {status_pref}: {body_pref}"
    );

    let (status_inst, _) = http_request(
        port,
        "POST",
        "/api/toolchains/gcc-windows-x64/install",
        None,
        None,
    )
    .await;
    assert_eq!(
        status_inst, 409,
        "POST install must return 409 Conflict during active judging"
    );

    let (status_uninst, _) = http_request(
        port,
        "DELETE",
        "/api/toolchains/gcc-windows-x64",
        None,
        None,
    )
    .await;
    assert_eq!(
        status_uninst, 409,
        "DELETE toolchain must return 409 Conflict during active judging"
    );

    // Release the active judge lease -> mutations succeed again
    drop(lease);

    let (status_after, _) = http_request(
        port,
        "PUT",
        "/api/toolchains/profiles/cpp/preference",
        Some(br#"{"mode":"managed"}"#),
        Some("application/json"),
    )
    .await;
    assert_eq!(
        status_after, 200,
        "PUT preference must succeed once active judging finishes"
    );

    server_task.abort();
}

#[tokio::test]
async fn test_step2_status_reflects_live_toolchain_store_and_rescan_mutation_gate() {
    let env = common::OwnedTestEnvironment::new();
    let app_data_dir = env.root().join("app_data_live_status");
    let toolchains_dir = app_data_dir.join("toolchains");
    fs::create_dir_all(&toolchains_dir).unwrap();

    let mut state = env.with_isolated_roots(|| {
        AppState::new(Arc::new(
            judgedesk_core::executor_client::ExecutorClient::unavailable("step2 live status test"),
        ))
    });
    state.set_app_data_dir(app_data_dir.clone());

    let (addr, server_task) = start_embedded_server_with_state(0, state.clone())
        .await
        .expect("start server");
    let port = addr.port();

    // 1. Disable both cpp and python profiles -> /api/status must reflect live state (not hardcoded true)
    for profile in ["cpp", "python"] {
        let (st, body) = http_request(
            port,
            "PUT",
            &format!("/api/toolchains/profiles/{profile}/preference"),
            Some(br#"{"mode":"none"}"#),
            Some("application/json"),
        )
        .await;
        assert_eq!(st, 200, "disable {profile} failed: {body}");
    }

    let (status_code, status_body) = http_request(port, "GET", "/api/status", None, None).await;
    assert_eq!(status_code, 200);
    let status_json: serde_json::Value = serde_json::from_str(&status_body).unwrap();
    assert_eq!(status_json["gpp"]["source"], "none");
    assert_eq!(status_json["gpp"]["installed"], false);
    assert_eq!(status_json["gpp"]["submissionReady"], false);
    assert_eq!(status_json["python"]["source"], "none");
    assert_eq!(status_json["python"]["installed"], false);
    assert_eq!(status_json["python"]["submissionReady"], false);

    // 2. While a judge job is active, rescan, certification-plan, and certify must return 409 Conflict
    let lease = state
        .try_acquire_judge_lease("active-judge-rescan-lock")
        .expect("acquire judge lease");

    let (rescan_locked, _) = http_request(port, "POST", "/api/toolchains/rescan", None, None).await;
    assert_eq!(
        rescan_locked, 409,
        "POST /api/toolchains/rescan must return 409 Conflict during active judging"
    );

    let (plan_locked, _) = http_request(
        port,
        "POST",
        "/api/toolchains/profiles/cpp/certification-plan",
        None,
        None,
    )
    .await;
    assert_eq!(
        plan_locked, 409,
        "POST certification-plan must return 409 Conflict during active judging"
    );

    let (cert_locked, _) = http_request(
        port,
        "POST",
        "/api/toolchains/profiles/cpp/certify",
        Some(br#"{"executablePath":"g++"}"#),
        Some("application/json"),
    )
    .await;
    assert_eq!(
        cert_locked, 409,
        "POST certify must return 409 Conflict during active judging"
    );

    drop(lease);

    // 3. Seed a valid managed GCC package on disk, rescan, and verify discovery + /api/status update
    let pkg_id = if cfg!(windows) {
        "gcc-windows-x64"
    } else if cfg!(target_os = "macos") {
        "gcc-macos-arm64"
    } else {
        "gcc-linux-x64"
    };
    let exe_rel = if cfg!(windows) {
        "bin/g++.exe"
    } else {
        "bin/g++"
    };
    let pkg_dir = toolchains_dir.join(pkg_id);
    fs::create_dir_all(pkg_dir.join("bin")).unwrap();
    fs::write(pkg_dir.join(exe_rel), b"managed-gpp-binary").unwrap();
    let receipt = serde_json::json!({
        "schemaVersion": 1,
        "packageId": pkg_id,
        "version": "14.2.0-rescan-test",
        "archiveSha256": "a".repeat(64),
        "entrypointComponentId": "gcc.cxx",
        "components": [
            {
                "id": "gcc.cxx",
                "kind": "executable",
                "relativePath": exe_rel,
                "roles": ["compiler"]
            }
        ]
    });
    fs::write(
        pkg_dir.join(".judgedesk-package.json"),
        serde_json::to_string_pretty(&receipt).unwrap(),
    )
    .unwrap();

    let (rescan_ok, rescan_body) =
        http_request(port, "POST", "/api/toolchains/rescan", None, None).await;
    assert_eq!(rescan_ok, 202, "rescan failed: {rescan_body}");

    let (pref_ok, _) = http_request(
        port,
        "PUT",
        "/api/toolchains/profiles/cpp/preference",
        Some(br#"{"mode":"managed"}"#),
        Some("application/json"),
    )
    .await;
    assert_eq!(pref_ok, 200);

    let (_, tc_body) = http_request(port, "GET", "/api/toolchains", None, None).await;
    let tc_json: serde_json::Value = serde_json::from_str(&tc_body).unwrap();
    let gcc_entry = tc_json["toolchains"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["id"] == pkg_id)
        .expect("gcc package entry");
    assert_eq!(
        gcc_entry["installed"], true,
        "rescan must discover newly installed managed package on disk"
    );

    let (_, status_after_body) = http_request(port, "GET", "/api/status", None, None).await;
    let status_after_json: serde_json::Value = serde_json::from_str(&status_after_body).unwrap();
    assert_eq!(status_after_json["gpp"]["source"], "managed");
    assert_eq!(status_after_json["gpp"]["installed"], true);
    assert_eq!(status_after_json["gpp"]["managedInstalled"], true);
    assert_eq!(status_after_json["gpp"]["version"], "14.2.0-rescan-test");

    server_task.abort();
}

#[tokio::test]
async fn test_step2_local_toolchain_snapshot_freeze_certify_and_tamper_detection() {
    let env = common::OwnedTestEnvironment::new();
    let app_data_dir = env.root().join("app_data_snapshot");
    fs::create_dir_all(app_data_dir.join("toolchains")).unwrap();

    // Create an owned local toolchain tree with bin/ and include/
    let local_tc_root = env.root().join("owned_local_cpp");
    let local_bin_dir = local_tc_root.join("bin");
    let local_inc_dir = local_tc_root.join("include");
    fs::create_dir_all(&local_bin_dir).unwrap();
    fs::create_dir_all(&local_inc_dir).unwrap();

    let source_exe =
        if cfg!(target_os = "macos") && std::path::Path::new("/usr/bin/clang").is_file() {
            std::path::PathBuf::from("/usr/bin/clang")
        } else {
            let real_c = resolve_toolchain_for_profile("c", None, None);
            assert!(real_c.ready, "real C compiler required");
            real_c.executable_path
        };
    let exe_name = if cfg!(windows) { "g++.exe" } else { "g++" };
    let local_exe = local_bin_dir.join(exe_name);
    fs::copy(&source_exe, &local_exe).unwrap();
    fs::write(local_inc_dir.join("test_header.hpp"), b"#pragma once\n").unwrap();

    let mut state = env.with_isolated_roots(|| {
        AppState::new(Arc::new(
            judgedesk_core::executor_client::ExecutorClient::unavailable("step2 snapshot test"),
        ))
    });
    state.set_app_data_dir(app_data_dir.clone());

    let (addr, server_task) = start_embedded_server_with_state(0, state.clone())
        .await
        .expect("start server");
    let port = addr.port();

    let pref_body = serde_json::json!({
        "mode": "local_path",
        "localPath": local_exe.to_string_lossy()
    });
    let (st_pref, _) = http_request(
        port,
        "PUT",
        "/api/toolchains/profiles/cpp/preference",
        Some(pref_body.to_string().as_bytes()),
        Some("application/json"),
    )
    .await;
    assert_eq!(st_pref, 200);

    // 1. Request certification-plan -> must inspect the real local toolchain directory tree (2 files)
    let (st_plan, plan_body) = http_request(
        port,
        "POST",
        "/api/toolchains/profiles/cpp/certification-plan",
        None,
        None,
    )
    .await;
    assert_eq!(st_plan, 200, "certification-plan failed: {plan_body}");
    let plan_json: serde_json::Value = serde_json::from_str(&plan_body).unwrap();
    assert_eq!(
        plan_json["plan"]["fileCount"], 2,
        "certification-plan must count actual files in local toolchain root: {plan_json}"
    );

    // 2. Certify the local toolchain -> must create a real frozen snapshot under app_data_dir/toolchains/local_cpp_<digest>
    let cert_req = serde_json::json!({
        "executablePath": local_exe.to_string_lossy()
    });
    let (st_cert, cert_body) = http_request(
        port,
        "POST",
        "/api/toolchains/profiles/cpp/certify",
        Some(cert_req.to_string().as_bytes()),
        Some("application/json"),
    )
    .await;
    assert_eq!(st_cert, 200, "certify failed: {cert_body}");
    let cert_json: serde_json::Value = serde_json::from_str(&cert_body).unwrap();
    let digest = cert_json["result"]["snapshot"]["digest"]
        .as_str()
        .expect("snapshot digest")
        .to_string();
    assert_eq!(digest.len(), 64);
    assert_eq!(cert_json["result"]["snapshot"]["fileCount"], 2);
    assert_eq!(cert_json["result"]["snapshot"]["created"], true);

    let snapshot_dir = app_data_dir
        .join("toolchains")
        .join(format!("local_cpp_{digest}"));
    assert!(
        snapshot_dir
            .join(".judgedesk-local-snapshot.json")
            .is_file(),
        "frozen snapshot marker must exist on disk at {}",
        snapshot_dir.display()
    );

    // 3. Verify snapshot integrity passes before tampering and fails closed with TOOLCHAIN_DRIFTED after tampering
    let verified = judgedesk_core::toolchains::discovery::verify_local_toolchain_snapshot(
        &app_data_dir,
        "cpp",
        &digest,
    )
    .expect("snapshot must verify before tampering");
    assert_eq!(verified.file_count, 2);

    // Tamper with a file inside the frozen snapshot payload
    let payload_header = snapshot_dir
        .join("payload")
        .join("include")
        .join("test_header.hpp");
    fs::write(&payload_header, b"#pragma once\n// TAMPERED\n").unwrap();

    let tampered_err = judgedesk_core::toolchains::discovery::verify_local_toolchain_snapshot(
        &app_data_dir,
        "cpp",
        &digest,
    )
    .expect_err("tampered snapshot must fail verification");
    assert!(
        tampered_err.contains("TOOLCHAIN_DRIFTED"),
        "expected TOOLCHAIN_DRIFTED on tampered snapshot, got: {tampered_err}"
    );

    server_task.abort();
}
