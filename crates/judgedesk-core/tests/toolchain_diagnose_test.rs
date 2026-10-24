use judgedesk_core::server::{start_embedded_server_with_state, AppState, ProfileSelection};
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
        .expect("Connect to server");

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

async fn run_single_profile_test(profile: &str, is_compiled: bool) {
    let _test_environment = common::OwnedTestEnvironment::new();
    common::ensure_test_environment();
    let state = _test_environment.with_isolated_roots(AppState::default);
    assert!(
        state.platform.root().starts_with(_test_environment.root()),
        "executor failed to enter the isolated test root: {:?}",
        state.platform.health()
    );
    let platform = state.platform.clone();
    let (addr, server_task) = start_embedded_server_with_state(0, state)
        .await
        .expect("Failed to start embedded server");
    let port = addr.port();

    let (_status, body) = http_request(
        port,
        "POST",
        &format!("/api/toolchains/profiles/{profile}/diagnose"),
        None,
        None,
    )
    .await;

    let json: serde_json::Value =
        serde_json::from_str(&body).unwrap_or_else(|_| panic!("Valid JSON for {profile}: {body}"));
    assert_eq!(json["success"], true, "{profile} diagnostic failed: {body}");
    let diag = &json["diagnostic"];
    assert_eq!(
        diag["success"], true,
        "{profile} diagnostic.success was not true"
    );
    assert_eq!(diag["profileId"], profile);
    assert_eq!(diag["language"], profile);
    assert_eq!(diag["phase"], "execution");

    if is_compiled {
        let compile_ms = diag["compileTimeMs"].as_u64().expect("valid compileTimeMs");
        assert!(compile_ms > 0, "{profile} compileTimeMs must be > 0");
    } else {
        assert!(
            diag["compileTimeMs"].is_null(),
            "{profile} should not report compileTimeMs"
        );
    }

    let exec_ms = diag["executionTimeMs"]
        .as_u64()
        .expect("valid executionTimeMs");
    let peak_kb = diag["peakMemoryKb"].as_u64().expect("valid peakMemoryKb");
    assert!(exec_ms > 0, "{profile} executionTimeMs must be > 0");
    assert!(peak_kb > 0, "{profile} peakMemoryKb must be > 0");

    server_task.abort();
    let _ = server_task.await;
    platform
        .shutdown()
        .await
        .expect("drain diagnostic executor");
}

#[tokio::test]
async fn test_genuine_toolchain_diagnostics_cpp() {
    run_single_profile_test("cpp", true).await;
}

#[tokio::test]
async fn test_genuine_toolchain_diagnostics_c() {
    run_single_profile_test("c", true).await;
}

#[tokio::test]
async fn test_genuine_toolchain_diagnostics_python() {
    run_single_profile_test("python", false).await;
}

#[tokio::test]
async fn test_genuine_toolchain_diagnostics_pascal() {
    run_single_profile_test("pascal", true).await;
}

#[tokio::test]
async fn test_genuine_toolchain_diagnostics_java() {
    run_single_profile_test("java", true).await;
}

#[tokio::test]
async fn test_genuine_toolchain_diagnostics_scratch() {
    run_single_profile_test("scratch", false).await;
}

#[derive(serde::Serialize, serde::Deserialize, Debug)]
struct DiagnosticRow {
    profile: String,
    status_code: u16,
    response_success: bool,
    diagnostic: Option<judgedesk_core::toolchains::diagnostics::ToolchainDiagnosticResult>,
    response_error: Option<String>,
    passed: bool,
}

#[derive(serde::Serialize, serde::Deserialize, Debug)]
struct DiagnosticReport {
    rows: Vec<DiagnosticRow>,
    exit_code: i32,
}

async fn run_diagnostic_orchestrator(state: AppState) -> DiagnosticReport {
    let platform = state.platform.clone();
    let (addr, server_task) = start_embedded_server_with_state(0, state)
        .await
        .expect("start diagnostic server");
    let profiles = [
        ("cpp", true),
        ("c", true),
        ("python", false),
        ("pascal", true),
        ("java", true),
        ("scratch", false),
    ];
    #[derive(serde::Deserialize)]
    struct DiagnosticResponse {
        success: bool,
        diagnostic: judgedesk_core::toolchains::diagnostics::ToolchainDiagnosticResult,
    }
    let mut rows = Vec::new();
    for (profile, compiled) in profiles {
        let (status_code, body) = http_request(
            addr.port(),
            "POST",
            &format!("/api/toolchains/profiles/{profile}/diagnose"),
            None,
            None,
        )
        .await;
        let row = match serde_json::from_str::<DiagnosticResponse>(&body) {
            Ok(response) => {
                let diagnostic = response.diagnostic;
                let passed = status_code == 200
                    && response.success
                    && diagnostic.success
                    && diagnostic.profile_id == profile
                    && diagnostic.language == profile
                    && diagnostic.phase == "execution"
                    && if compiled {
                        diagnostic.compile_time_ms.is_some_and(|ms| ms > 0)
                    } else {
                        diagnostic.compile_time_ms.is_none()
                    }
                    && diagnostic.execution_time_ms.is_some_and(|ms| ms > 0)
                    && diagnostic.peak_memory_kb.is_some_and(|kb| kb > 0);
                DiagnosticRow {
                    profile: profile.to_string(),
                    status_code,
                    response_success: response.success,
                    diagnostic: Some(diagnostic),
                    response_error: None,
                    passed,
                }
            }
            Err(error) => DiagnosticRow {
                profile: profile.to_string(),
                status_code,
                response_success: false,
                diagnostic: None,
                response_error: Some(format!("Invalid response: {error}; {body}")),
                passed: false,
            },
        };
        println!(
            "TOOLCHAIN_DIAGNOSTIC_ROW={}",
            serde_json::to_string(&row).expect("serialize diagnostic row")
        );
        rows.push(row);
    }
    server_task.abort();
    let _ = server_task.await;
    platform
        .shutdown()
        .await
        .expect("drain diagnostic executor");
    let exit_code = i32::from(rows.iter().any(|row| !row.passed));
    let report = DiagnosticReport { rows, exit_code };
    println!(
        "TOOLCHAIN_DIAGNOSTIC_ORCHESTRATOR_SUMMARY={}",
        serde_json::to_string(&report).expect("serialize diagnostic report")
    );
    report
}

#[tokio::test]
async fn test_genuine_toolchain_diagnostics_orchestrator() {
    let environment = common::OwnedTestEnvironment::new();
    common::ensure_test_environment();
    let state = environment.with_isolated_roots(AppState::default);
    assert!(state.platform.root().starts_with(environment.root()));
    let report = run_diagnostic_orchestrator(state).await;
    assert_eq!(report.exit_code, 0, "{report:#?}");
    assert_eq!(report.rows.len(), 6);
    assert!(report.rows.iter().all(|row| row.passed));
}

struct CIncludePathRestore {
    include_path: Option<std::ffi::OsString>,
    cpath: Option<std::ffi::OsString>,
}

impl Drop for CIncludePathRestore {
    fn drop(&mut self) {
        match self.include_path.take() {
            Some(value) => std::env::set_var("C_INCLUDE_PATH", value),
            None => std::env::remove_var("C_INCLUDE_PATH"),
        }
        match self.cpath.take() {
            Some(value) => std::env::set_var("CPATH", value),
            None => std::env::remove_var("CPATH"),
        }
    }
}

#[tokio::test]
async fn test_genuine_toolchain_diagnostics_orchestrator_continues_after_profile_failure() {
    let environment = common::OwnedTestEnvironment::new();
    common::ensure_test_environment();
    let state = environment.with_isolated_roots(AppState::default);
    assert!(state.platform.root().starts_with(environment.root()));
    // The selected local wrapper may only execute the host compiler exposed by
    // its sandbox, not a managed package outside that selected local root.
    let mode = if cfg!(target_os = "linux") {
        Some("local_auto")
    } else {
        None
    };
    let compiler =
        judgedesk_core::toolchains::discovery::resolve_toolchain_for_profile("c", mode, None);
    assert!(compiler.ready, "a real C compiler is required");
    assert!(compiler.executable_path.is_file());
    let include_dir = environment.root().join("owned-c-include");
    std::fs::create_dir(&include_dir).expect("create owned include directory");
    const FAILURE_MARKER: &str = "JUDGEDESK_OWNED_C_INCLUDE_FAILURE";
    std::fs::write(
        include_dir.join("stdio.h"),
        format!("#error {FAILURE_MARKER}\n"),
    )
    .expect("write owned invalid C header");
    let previous = std::env::var_os("C_INCLUDE_PATH");
    let previous_cpath = std::env::var_os("CPATH");
    let restore = CIncludePathRestore {
        include_path: previous.clone(),
        cpath: previous_cpath.clone(),
    };
    std::env::remove_var("CPATH");
    std::env::set_var("C_INCLUDE_PATH", &include_dir);
    #[cfg(target_os = "linux")]
    let selected_compiler = {
        use std::os::unix::fs::PermissionsExt;
        // Host include variables must not cross the sandbox boundary. Inject
        // the intentional failure through the selected compiler itself instead.
        let wrapper = include_dir.join("cc");
        let compiler_path = compiler.executable_path.to_string_lossy();
        let header = include_dir.join("stdio.h");
        std::fs::write(&wrapper, format!(
            "#!/bin/sh\nfor arg in \"$@\"; do\n  if [ \"$arg\" = -static ]; then exec '{}' -include '{}' \"$@\"; fi\ndone\nexec '{}' \"$@\"\n",
            compiler_path, header.display(), compiler_path
        )).unwrap();
        std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).unwrap();
        wrapper
    };
    #[cfg(not(target_os = "linux"))]
    let selected_compiler = compiler.executable_path.clone();
    {
        let mut toolchains = state.toolchains.write().expect("toolchain state lock");
        toolchains.selections.insert(
            "c".to_string(),
            ProfileSelection {
                mode: "local_path".to_string(),
                local_path: Some(selected_compiler.to_string_lossy().into_owned()),
            },
        );
    }
    let report = run_diagnostic_orchestrator(state).await;
    drop(restore);
    assert_eq!(std::env::var_os("C_INCLUDE_PATH"), previous);
    assert_eq!(std::env::var_os("CPATH"), previous_cpath);
    assert_eq!(
        report.exit_code, 1,
        "required profile failure must fail the runner"
    );
    assert_eq!(
        report
            .rows
            .iter()
            .map(|row| row.profile.as_str())
            .collect::<Vec<_>>(),
        vec!["cpp", "c", "python", "pascal", "java", "scratch"]
    );
    assert_eq!(
        report
            .rows
            .iter()
            .filter(|row| !row.passed)
            .map(|row| row.profile.as_str())
            .collect::<Vec<_>>(),
        vec!["c"]
    );
    for row in &report.rows {
        let diagnostic = row.diagnostic.as_ref().expect("real diagnostic response");
        assert_eq!(row.status_code, 200);
        assert_eq!(diagnostic.profile_id, row.profile);
        assert_eq!(diagnostic.language, row.profile);
        if row.profile == "c" {
            assert!(!row.response_success);
            assert!(!diagnostic.success);
            assert_eq!(diagnostic.source_mode.as_deref(), Some("local_path"));
            assert_eq!(diagnostic.phase, "compilation");
            assert!(diagnostic.compile_time_ms.is_some());
            let error = diagnostic
                .error
                .as_deref()
                .expect("real compiler diagnostic");
            assert!(
                error.contains(FAILURE_MARKER),
                "unexpected failure: {error}"
            );
            assert!(
                error.contains("stdio.h"),
                "owned header must cause failure: {error}"
            );
            assert!(!error.contains("unknown proxy name"));
            assert!(diagnostic.execution_time_ms.is_none());
            assert!(diagnostic.peak_memory_kb.is_none());
        } else {
            assert!(row.passed, "{row:#?}");
        }
    }
}

#[cfg(windows)]
#[tokio::test]
async fn test_windows_verbatim_resource_dir_and_executable_paths_diagnose_cpp_and_c() {
    let environment = common::OwnedTestEnvironment::new();
    common::ensure_test_environment();
    let state = environment.with_isolated_roots(AppState::default);

    let base_cpp =
        judgedesk_core::toolchains::discovery::resolve_toolchain_for_profile("cpp", None, None);
    assert!(
        base_cpp.ready && base_cpp.executable_path.is_file(),
        "expected ready C++ toolchain on Windows test host"
    );
    let base_c =
        judgedesk_core::toolchains::discovery::resolve_toolchain_for_profile("c", None, None);
    assert!(
        base_c.ready && base_c.executable_path.is_file(),
        "expected ready C toolchain on Windows test host"
    );

    // 1. Verify bundled_resource_toolchains_dirs_for strips `\\?\` when Tauri provides a verbatim THEMIS_RESOURCE_DIR
    let canonical_root =
        std::fs::canonicalize(environment.root()).expect("canonicalize isolated test root");
    assert!(
        canonical_root.to_string_lossy().starts_with(r"\\?\"),
        "std::fs::canonicalize on Windows must produce a verbatim path: {}",
        canonical_root.display()
    );
    let prev_res = std::env::var_os("THEMIS_RESOURCE_DIR");
    std::env::set_var("THEMIS_RESOURCE_DIR", &canonical_root);
    let bundled_dirs = judgedesk_core::toolchains::discovery::bundled_resource_toolchains_dirs_for(
        &environment.root().join("app-data").join("toolchains"),
    );
    match prev_res {
        Some(v) => std::env::set_var("THEMIS_RESOURCE_DIR", v),
        None => std::env::remove_var("THEMIS_RESOURCE_DIR"),
    }
    assert!(
        !bundled_dirs.is_empty()
            && bundled_dirs
                .iter()
                .all(|d| !d.to_string_lossy().starts_with(r"\\?\")),
        "bundled_resource_toolchains_dirs_for must strip \\\\?\\ prefix: {bundled_dirs:?}"
    );

    // 2. Simulate a fresh Windows Full install where app_data_dir/toolchains is empty
    // and managed toolchains are resolved from a verbatim `\\?\` THEMIS_RESOURCE_DIR.
    if let Some(ref pkg_root) = base_cpp.package_root {
        if let Some(resource_base) = pkg_root.parent().and_then(|p| p.parent()) {
            let verbatim_resource_base = std::fs::canonicalize(resource_base)
                .expect("canonicalize resource base to verbatim path");
            assert!(
                verbatim_resource_base
                    .to_string_lossy()
                    .starts_with(r"\\?\"),
                "expected verbatim resource base: {}",
                verbatim_resource_base.display()
            );
            let fresh_app_data =
                std::env::temp_dir().join(format!("jd_fresh_win_appdata_{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&fresh_app_data);
            std::fs::create_dir_all(fresh_app_data.join("toolchains"))
                .expect("create empty fresh app_data toolchains dir");

            let prev_res = std::env::var_os("THEMIS_RESOURCE_DIR");
            std::env::set_var("THEMIS_RESOURCE_DIR", &verbatim_resource_base);

            let resolved_managed_cpp =
                judgedesk_core::toolchains::discovery::find_managed_toolchain_in(
                    &fresh_app_data.join("toolchains"),
                    "cpp",
                )
                .expect("resolve managed cpp from verbatim THEMIS_RESOURCE_DIR");
            assert_eq!(resolved_managed_cpp.source_mode, "managed");
            assert!(
                !resolved_managed_cpp
                    .executable_path
                    .to_string_lossy()
                    .starts_with(r"\\?\"),
                "managed executable_path must not start with \\\\?\\: {}",
                resolved_managed_cpp.executable_path.display()
            );
            assert!(
                resolved_managed_cpp
                    .package_root
                    .as_ref()
                    .is_some_and(|p| !p.to_string_lossy().starts_with(r"\\?\")),
                "managed package_root must not start with \\\\?\\: {:?}",
                resolved_managed_cpp.package_root
            );

            let prev_path = std::env::var_os("PATH");
            if let Some(ref raw_path) = prev_path {
                let filtered: Vec<_> = std::env::split_paths(raw_path)
                    .filter(|p| {
                        let lower = p.to_string_lossy().to_ascii_lowercase();
                        !lower.contains("mingw")
                            && !lower.contains("gcc")
                            && !lower.contains("msys")
                            && !lower.contains("ucrt")
                            && !lower.contains("clang")
                            && !lower.contains("llvm")
                    })
                    .collect();
                if let Ok(joined) = std::env::join_paths(filtered) {
                    std::env::set_var("PATH", joined);
                }
            }

            let managed_cpp_diag =
                judgedesk_core::toolchains::diagnostics::diagnose_language_profile_in(
                    Some(&fresh_app_data),
                    "cpp",
                    &state.platform,
                    Some("managed"),
                    None,
                )
                .await;
            let managed_c_diag =
                judgedesk_core::toolchains::diagnostics::diagnose_language_profile_in(
                    Some(&fresh_app_data),
                    "c",
                    &state.platform,
                    Some("managed"),
                    None,
                )
                .await;

            match prev_path {
                Some(v) => std::env::set_var("PATH", v),
                None => std::env::remove_var("PATH"),
            }
            match prev_res {
                Some(v) => std::env::set_var("THEMIS_RESOURCE_DIR", v),
                None => std::env::remove_var("THEMIS_RESOURCE_DIR"),
            }
            let _ = std::fs::remove_dir_all(&fresh_app_data);

            assert!(
                managed_cpp_diag.success,
                "managed C++ diagnostic from verbatim THEMIS_RESOURCE_DIR failed: {managed_cpp_diag:?}"
            );
            assert!(
                managed_c_diag.success,
                "managed C diagnostic from verbatim THEMIS_RESOURCE_DIR failed: {managed_c_diag:?}"
            );
        }
    }

    // 3. Verify C++ and C diagnostics succeed even if local_path carries `\\?\`
    // and system PATH has no external MinGW/GCC directories (preventing cc1plus/cc1 fallback).
    let prev_path = std::env::var_os("PATH");
    if let Some(ref raw_path) = prev_path {
        let filtered: Vec<_> = std::env::split_paths(raw_path)
            .filter(|p| {
                let lower = p.to_string_lossy().to_ascii_lowercase();
                !lower.contains("mingw")
                    && !lower.contains("gcc")
                    && !lower.contains("msys")
                    && !lower.contains("ucrt")
                    && !lower.contains("clang")
                    && !lower.contains("llvm")
            })
            .collect();
        if let Ok(joined) = std::env::join_paths(filtered) {
            std::env::set_var("PATH", joined);
        }
    }

    let verbatim_cpp_exe = std::fs::canonicalize(&base_cpp.executable_path)
        .expect("canonicalize cpp executable to verbatim path");
    assert!(verbatim_cpp_exe.to_string_lossy().starts_with(r"\\?\"));

    let verbatim_c_exe = std::fs::canonicalize(&base_c.executable_path)
        .expect("canonicalize c executable to verbatim path");
    assert!(verbatim_c_exe.to_string_lossy().starts_with(r"\\?\"));

    let cpp_diag = judgedesk_core::toolchains::diagnostics::diagnose_language_profile_in(
        Some(environment.root()),
        "cpp",
        &state.platform,
        Some("local_path"),
        Some(&verbatim_cpp_exe.to_string_lossy()),
    )
    .await;

    let c_diag = judgedesk_core::toolchains::diagnostics::diagnose_language_profile_in(
        Some(environment.root()),
        "c",
        &state.platform,
        Some("local_path"),
        Some(&verbatim_c_exe.to_string_lossy()),
    )
    .await;

    match prev_path {
        Some(v) => std::env::set_var("PATH", v),
        None => std::env::remove_var("PATH"),
    }

    assert!(
        cpp_diag.success,
        "C++ diagnostic with verbatim \\\\?\\ path failed: {cpp_diag:?}"
    );
    assert_eq!(cpp_diag.phase, "execution");
    assert!(
        c_diag.success,
        "C diagnostic with verbatim \\\\?\\ path failed: {c_diag:?}"
    );
    assert_eq!(c_diag.phase, "execution");

    state
        .platform
        .shutdown()
        .await
        .expect("drain diagnostic executor");
}
