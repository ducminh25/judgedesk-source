mod common;

use judgedesk_core::server::{
    start_embedded_server_with_state, start_embedded_server_with_state_and_session, AppState,
    DirectoryPicker, NativeDirectoryPicker, NativeWorkbookOpener, WorkbookOpener,
};
use judgedesk_core::storage::{ensure_safe_contained_path, OwnedWorkspace};
use std::fs;
use std::path::Path;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

async fn raw_http_request(port: u16, raw_request: &str) -> (u16, String, String) {
    let mut stream = TcpStream::connect(format!("127.0.0.1:{port}"))
        .await
        .expect("connect to embedded server");
    stream
        .write_all(raw_request.as_bytes())
        .await
        .expect("write HTTP request");

    let mut response = Vec::new();
    stream
        .read_to_end(&mut response)
        .await
        .expect("read HTTP response");
    let resp_str = String::from_utf8_lossy(&response).to_string();

    let status_code = resp_str
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .unwrap_or(500);

    let (headers_part, body_part) = if let Some(pos) = resp_str.find("\r\n\r\n") {
        (resp_str[..pos].to_string(), resp_str[pos + 4..].to_string())
    } else {
        (resp_str.clone(), String::new())
    };

    (status_code, headers_part, body_part)
}

#[tokio::test]
async fn test_step1_auth_middleware_enforces_session_host_and_origin() {
    let env = common::OwnedTestEnvironment::new();
    let state = env.with_isolated_roots(|| {
        AppState::new(Arc::new(
            judgedesk_core::executor_client::ExecutorClient::unavailable("step1 auth test"),
        ))
    });
    let token = "deadbeef".repeat(8); // 64 hex chars
    let (addr, handle) =
        start_embedded_server_with_state_and_session(0, state, Some(token.clone()))
            .await
            .expect("start desktop boundary server");
    let port = addr.port();
    let host = format!("127.0.0.1:{port}");

    // 1. Missing X-JudgeDesk-Session -> 401 API_SESSION_REQUIRED
    let (status, _, body) = raw_http_request(
        port,
        &format!(
            "GET /api/status HTTP/1.1\r\nHost: {host}\r\nOrigin: tauri://localhost\r\nConnection: close\r\n\r\n"
        ),
    )
    .await;
    assert_eq!(status, 401, "Missing session header must yield 401: {body}");
    let json_body: serde_json::Value = serde_json::from_str(&body).expect("valid error JSON");
    assert_eq!(json_body["code"], "API_SESSION_REQUIRED");

    // 2. Wrong Host header -> 403 API_HOST_REJECTED
    let (status, _, body) = raw_http_request(
        port,
        &format!(
            "GET /api/status HTTP/1.1\r\nHost: localhost:{port}\r\nOrigin: tauri://localhost\r\nX-JudgeDesk-Session: {token}\r\nConnection: close\r\n\r\n"
        ),
    )
    .await;
    assert_eq!(status, 403, "Non-127.0.0.1 Host must yield 403: {body}");
    let json_body: serde_json::Value = serde_json::from_str(&body).expect("valid error JSON");
    assert_eq!(json_body["code"], "API_HOST_REJECTED");

    // 3. Disallowed Origin -> 403 API_ORIGIN_REJECTED
    let (status, _, body) = raw_http_request(
        port,
        &format!(
            "GET /api/status HTTP/1.1\r\nHost: {host}\r\nOrigin: https://attacker.example\r\nX-JudgeDesk-Session: {token}\r\nConnection: close\r\n\r\n"
        ),
    )
    .await;
    assert_eq!(status, 403, "Untrusted Origin must yield 403: {body}");
    let json_body: serde_json::Value = serde_json::from_str(&body).expect("valid error JSON");
    assert_eq!(json_body["code"], "API_ORIGIN_REJECTED");

    // 4. Valid Host + Origin + Session Token -> 200 OK with security headers
    let (status, headers, body) = raw_http_request(
        port,
        &format!(
            "GET /api/status HTTP/1.1\r\nHost: {host}\r\nOrigin: http://tauri.localhost\r\nX-JudgeDesk-Session: {token}\r\nConnection: close\r\n\r\n"
        ),
    )
    .await;
    assert_eq!(status, 200, "Valid request must yield 200: {body}");
    let lower_headers = headers.to_ascii_lowercase();
    assert!(lower_headers.contains("access-control-allow-origin: http://tauri.localhost"));
    assert!(lower_headers.contains("x-content-type-options: nosniff"));
    assert!(lower_headers.contains("cache-control: no-store"));

    // 5. OPTIONS preflight with allowed Origin and no token -> 204 No Content
    let (status, _, _) = raw_http_request(
        port,
        &format!(
            "OPTIONS /api/status HTTP/1.1\r\nHost: {host}\r\nOrigin: http://127.0.0.1:5173\r\nConnection: close\r\n\r\n"
        ),
    )
    .await;
    assert_eq!(status, 204);

    handle.abort();
    let _ = handle.await;
}

#[test]
fn test_step1_owned_workspace_and_hostile_path_containment() {
    let env = common::OwnedTestEnvironment::new();
    let workspace_parent = env.root().join("workspaces");
    fs::create_dir_all(&workspace_parent).expect("create workspaces parent");

    let mut ws =
        OwnedWorkspace::create(&workspace_parent, "step1_ws").expect("create OwnedWorkspace");
    assert!(ws.root().is_dir());

    // 1. Valid contained file write and read
    let written = ws
        .write_file(
            Path::new("nested/solution.cpp"),
            b"int main() { return 0; }",
        )
        .expect("write contained file");
    assert!(written.starts_with(ws.root()));
    let content = ws
        .read_file(Path::new("nested/solution.cpp"))
        .expect("read contained file");
    assert_eq!(content, b"int main() { return 0; }");

    // 2. Relative traversal '..' and '.' must be rejected
    for hostile in [
        "../escape.txt",
        "nested/../../escape.txt",
        "./solution.cpp",
        "nested/./solution.cpp",
    ] {
        assert!(
            ensure_safe_contained_path(ws.root(), Path::new(hostile)).is_err(),
            "Traversal path '{hostile}' must be rejected"
        );
        assert!(
            ws.write_file(Path::new(hostile), b"bad").is_err(),
            "write_file must reject '{hostile}'"
        );
    }

    // 3. Outside absolute path must be rejected
    let outside_path = env.root().join("outside_secret.txt");
    fs::write(&outside_path, b"secret").expect("write outside file");
    assert!(
        ensure_safe_contained_path(ws.root(), &outside_path).is_err(),
        "Outside absolute path must be rejected"
    );

    // 4. Windows ADS (Alternate Data Streams) must be rejected
    for ads in [
        "solution.cpp:hidden",
        "nested/file.txt:$DATA",
        "stream:$INDEX_ALLOCATION",
    ] {
        assert!(
            ensure_safe_contained_path(ws.root(), Path::new(ads)).is_err(),
            "ADS path '{ads}' must be rejected"
        );
        assert!(
            ws.write_file(Path::new(ads), b"bad").is_err(),
            "write_file must reject ADS path '{ads}'"
        );
    }

    // 5. Symlink / Junction / Reparse Point inside workspace must be rejected
    let outside_dir = env.root().join("outside_target_dir");
    fs::create_dir_all(&outside_dir).expect("create outside_target_dir");
    let outside_sentinel = outside_dir.join("sentinel.txt");
    fs::write(&outside_sentinel, b"must-not-be-deleted").expect("write outside sentinel");

    #[cfg(windows)]
    {
        let junction_path = ws.root().join("junction_escape");
        let status = std::process::Command::new("cmd")
            .args([
                "/C",
                "mklink",
                "/J",
                &junction_path.to_string_lossy(),
                &outside_dir.to_string_lossy(),
            ])
            .output()
            .expect("create junction via mklink /J");
        assert!(
            status.status.success(),
            "mklink /J failed: {}",
            String::from_utf8_lossy(&status.stderr)
        );

        assert!(
            ensure_safe_contained_path(ws.root(), Path::new("junction_escape")).is_err(),
            "Junction directory itself must be rejected"
        );
        assert!(
            ensure_safe_contained_path(ws.root(), Path::new("junction_escape/sentinel.txt"))
                .is_err(),
            "File inside junction must be rejected"
        );
        assert!(
            ensure_safe_contained_path(ws.root(), Path::new("junction_escape/new_file.txt"))
                .is_err(),
            "Non-existent descendant inside junction must be rejected"
        );
        assert!(
            ws.read_file(Path::new("junction_escape/sentinel.txt"))
                .is_err(),
            "read_file through junction must be rejected"
        );
        assert!(
            ws.write_file(Path::new("junction_escape/new_file.txt"), b"exploit")
                .is_err(),
            "write_file through junction must be rejected"
        );
    }

    #[cfg(unix)]
    {
        let symlink_path = ws.root().join("symlink_escape");
        std::os::unix::fs::symlink(&outside_dir, &symlink_path).expect("create unix symlink");

        assert!(
            ensure_safe_contained_path(ws.root(), Path::new("symlink_escape")).is_err(),
            "Symlink directory itself must be rejected"
        );
        assert!(
            ensure_safe_contained_path(ws.root(), Path::new("symlink_escape/sentinel.txt"))
                .is_err(),
            "File inside symlink must be rejected"
        );
        assert!(
            ensure_safe_contained_path(ws.root(), Path::new("symlink_escape/new_file.txt"))
                .is_err(),
            "Non-existent descendant inside symlink must be rejected"
        );
    }

    // 6. Cleanup must remove the workspace without deleting files inside the junction/symlink target!
    let ws_root = ws.root().to_path_buf();
    ws.cleanup().expect("cleanup workspace safely");
    assert!(!ws_root.exists(), "Workspace directory must be removed");
    assert!(
        outside_sentinel.exists(),
        "Outside target file must NOT be deleted when cleaning up workspace containing junction/symlink"
    );
}

#[test]
fn test_step1_directory_picker_and_workbook_opener_reject_hostile_paths_and_prevent_shell_interpolation(
) {
    let env = common::OwnedTestEnvironment::new();
    let picker = NativeDirectoryPicker;

    // 1. Hostile paths rejected by NativeDirectoryPicker before spawning any process
    for bad_path in [
        "../outside",
        "C:\\nonexistent_dir_12345\\..\\escape",
        "valid_name:ads_stream",
    ] {
        assert!(
            picker.select_directory(Some(bad_path)).is_err(),
            "NativeDirectoryPicker must reject hostile default_path '{bad_path}'"
        );
        assert!(
            picker.build_command(Some(bad_path)).is_err(),
            "NativeDirectoryPicker::build_command must reject '{bad_path}'"
        );
    }

    // 2. Directory with shell metacharacters (' " $(...) ` ; &) is passed via env/argv without interpolation
    let tricky_name = if cfg!(windows) {
        "contest 'quote' $(calc) `tick` ; & dir"
    } else {
        "contest 'quote' \"double\" $(id) `tick` ; & dir"
    };
    let tricky_dir = env.root().join(tricky_name);
    fs::create_dir_all(&tricky_dir).expect("create directory with shell metacharacters");
    let tricky_str = tricky_dir.to_string_lossy().to_string();

    let cmd = picker
        .build_command(Some(&tricky_str))
        .expect("build_command for existing directory with metacharacters");
    let args: Vec<String> = cmd
        .get_args()
        .map(|a| a.to_string_lossy().to_string())
        .collect();

    #[cfg(windows)]
    {
        for arg in &args {
            assert!(
                !arg.contains("$(calc)") && !arg.contains("'quote'"),
                "PowerShell arguments must NOT interpolate default_path into script: {arg}"
            );
        }
        let envs: Vec<(String, String)> = cmd
            .get_envs()
            .filter_map(|(k, v)| {
                Some((
                    k.to_string_lossy().to_string(),
                    v?.to_string_lossy().to_string(),
                ))
            })
            .collect();
        assert!(
            envs.iter()
                .any(|(k, v)| k == "THEMIS_DEFAULT_PATH" && v.contains("$(calc)")),
            "Canonical default_path must be passed via THEMIS_DEFAULT_PATH env var"
        );
    }

    #[cfg(target_os = "macos")]
    {
        let script_arg = &args[1];
        assert!(
            !script_arg.contains("$(id)") && !script_arg.contains("'quote'"),
            "AppleScript -e argument must be static and NOT interpolate default_path: {script_arg}"
        );
        assert!(
            args.iter().any(|a| a.contains("$(id)")),
            "Canonical default_path must be passed as separate argv item"
        );
    }

    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        for static_arg in &args[..args.len().saturating_sub(1)] {
            assert!(
                !static_arg.contains("$(id)") && !static_arg.contains("'quote'"),
                "zenity static flag must NOT interpolate default_path: {static_arg}"
            );
        }
        assert!(
            args.last().is_some_and(|a| a.contains("$(id)")),
            "Canonical default_path must be passed as separate argv item"
        );
    }

    // 3. NativeWorkbookOpener rejects hostile paths, outside paths, non-xlsx files, and junctions
    let export_root = env.root().join("exports");
    fs::create_dir_all(&export_root).expect("create export_root");
    let opener = NativeWorkbookOpener::with_allowed_root(export_root.clone());

    let outside_xlsx = env.root().join("outside.xlsx");
    fs::write(&outside_xlsx, b"PK\x03\x04").expect("write outside xlsx");
    assert!(
        opener.open_workbook(&outside_xlsx).is_err(),
        "NativeWorkbookOpener must reject workbook outside allowed root"
    );

    let traversal_xlsx = export_root.join("..").join("outside.xlsx");
    assert!(
        opener.open_workbook(&traversal_xlsx).is_err(),
        "NativeWorkbookOpener must reject '..' traversal"
    );

    let wrong_ext = export_root.join("Book.exe");
    fs::write(&wrong_ext, b"MZ").expect("write wrong extension file");
    assert!(
        opener.open_workbook(&wrong_ext).is_err(),
        "NativeWorkbookOpener must reject non-.xlsx file"
    );

    // 4. Valid workbook inside directory with metacharacters builds safe command (never cmd /C start)
    let tricky_export_dir = export_root.join(tricky_name);
    fs::create_dir_all(&tricky_export_dir).expect("create tricky_export_dir");
    let valid_book = tricky_export_dir.join("Book.xlsx");
    fs::write(&valid_book, b"PK\x03\x04").expect("write valid Book.xlsx");

    let open_cmd = opener
        .build_command(&valid_book)
        .expect("build_command for valid contained Book.xlsx");
    let program = open_cmd
        .get_program()
        .to_string_lossy()
        .to_ascii_lowercase();
    assert!(
        program != "cmd" && program != "cmd.exe" && program != "powershell" && program != "sh",
        "NativeWorkbookOpener must NEVER invoke a shell ({program})"
    );
    let open_args: Vec<String> = open_cmd
        .get_args()
        .map(|a| a.to_string_lossy().to_string())
        .collect();
    assert!(
        !open_args
            .iter()
            .any(|a| a.eq_ignore_ascii_case("/c") || a.eq_ignore_ascii_case("start")),
        "NativeWorkbookOpener must not use '/C start': {open_args:?}"
    );
}

#[tokio::test]
async fn test_step1_unimplemented_phase_b_routes_return_truthful_501() {
    let env = common::OwnedTestEnvironment::new();
    let state = env.with_isolated_roots(|| {
        AppState::new(Arc::new(
            judgedesk_core::executor_client::ExecutorClient::unavailable("step1 route audit"),
        ))
    });
    let state_for_drain = state.clone();
    let (addr, handle) = start_embedded_server_with_state(0, state)
        .await
        .expect("start server");
    let port = addr.port();
    let host = format!("127.0.0.1:{port}");

    // WP7.2 implemented POST /api/toolchains/prewarm: verify 200 OK when running
    let (status, _, body) = raw_http_request(
        port,
        &format!("POST /api/toolchains/prewarm HTTP/1.1\r\nHost: {host}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"),
    )
    .await;
    assert_eq!(
        status, 200,
        "Route POST /api/toolchains/prewarm must return 200 OK when running, got {status}: {body}"
    );
    let parsed: serde_json::Value = serde_json::from_str(&body).expect("structured JSON response");
    assert_eq!(parsed["success"], true);
    assert_eq!(parsed["message"], "Background pre-warm initiated.");

    // And fail-closed 503 Service Unavailable once lifecycle enters draining
    state_for_drain
        .set_lifecycle_phase(judgedesk_core::server::state::ServerLifecyclePhase::Draining);
    let (drain_status, _, drain_body) = raw_http_request(
        port,
        &format!("POST /api/toolchains/prewarm HTTP/1.1\r\nHost: {host}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"),
    )
    .await;
    assert_eq!(drain_status, 503);
    let drain_parsed: serde_json::Value =
        serde_json::from_str(&drain_body).expect("structured JSON error");
    assert_eq!(drain_parsed["success"], false);

    handle.abort();
    let _ = handle.await;
}

#[test]
fn test_step1_wp17_structured_observability_redaction_and_bounded_rotation() {
    use judgedesk_core::server::observability::{
        redact_sensitive_text, BoundedRotatingLog, StructuredLogEvent, MAX_LOG_MESSAGE_BYTES,
    };

    let env = common::OwnedTestEnvironment::new();
    let session_canary = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
    let signing_canary = "SECRET_SIGNING_CANARY_DO_NOT_LEAK_998877";
    let answer_canary = "CONTEST_ANSWER_CANARY_42_PRIVATE";
    let path_canary = r"C:\Users\PrivateContestAdmin\SecretTests\01.out";

    // 1. DesktopApiBoundary Debug formatting must redact the session token
    let boundary =
        judgedesk_core::server::DesktopApiBoundary::new(41321, session_canary.to_string())
            .expect("valid boundary");
    let debug_repr = format!("{boundary:?}");
    assert!(
        !debug_repr.contains(session_canary),
        "DesktopApiBoundary Debug must never leak raw session token: {debug_repr}"
    );
    assert!(debug_repr.contains("[REDACTED]"));

    // 2. Redaction strips 64-hex tokens, header secrets, env secrets, and explicit source/answer/path canaries
    let raw_diagnostic = format!(
        "Auth failed: X-JudgeDesk-Session: {session_canary} env JUDGEDESK_API_TOKEN={session_canary} \
         signing={signing_canary} answer={answer_canary} path={path_canary} flood={}",
        "X".repeat(MAX_LOG_MESSAGE_BYTES + 1024)
    );
    let sanitized = redact_sensitive_text(
        &raw_diagnostic,
        &[signing_canary, answer_canary, path_canary],
    );
    assert!(
        !sanitized.contains(session_canary),
        "64-hex session token canary must be redacted: {sanitized}"
    );
    assert!(
        !sanitized.contains(signing_canary),
        "Signing key canary must be redacted: {sanitized}"
    );
    assert!(
        !sanitized.contains(answer_canary),
        "Answer content canary must be redacted: {sanitized}"
    );
    assert!(
        !sanitized.contains(path_canary),
        "Private path canary must be redacted: {sanitized}"
    );
    assert!(
        sanitized.len() <= MAX_LOG_MESSAGE_BYTES + 64,
        "Sanitized log message must be bounded"
    );

    // 3. StructuredLogEvent includes build identity, correlation labels, and redacts message payloads
    let event = StructuredLogEvent::new(
        "ERROR",
        "CHECKER_SANDBOX_ERROR",
        "checker",
        &raw_diagnostic,
        &[signing_canary, answer_canary, path_canary],
    )
    .with_correlation(
        Some("req-101"),
        Some("job-202"),
        Some("run-303"),
        Some("windows-lpac-job"),
    );

    let serialized = event.to_json_line();
    assert!(!serialized.contains(session_canary));
    assert!(!serialized.contains(signing_canary));
    assert!(!serialized.contains(answer_canary));
    assert!(!serialized.contains(path_canary));
    let parsed: serde_json::Value = serde_json::from_str(&serialized).expect("valid JSON log line");
    assert_eq!(parsed["level"], "ERROR");
    assert_eq!(parsed["code"], "CHECKER_SANDBOX_ERROR");
    assert_eq!(parsed["phase"], "checker");
    assert_eq!(parsed["requestId"], "req-101");
    assert_eq!(parsed["jobId"], "job-202");
    assert_eq!(parsed["runId"], "run-303");
    assert_eq!(parsed["executorMode"], "windows-lpac-job");
    assert_eq!(
        parsed["build"]["appVersion"],
        judgedesk_core::build_metadata::BUILD_METADATA.app_version
    );

    // 4. BoundedRotatingLog rotates when max_bytes is exceeded and preserves redaction across rotated files
    let log_path = env.root().join("logs").join("backend.log");
    let logger = BoundedRotatingLog::new(log_path.clone(), 1024);
    for idx in 0..10 {
        let ev = StructuredLogEvent::new(
            "WARN",
            "DRAIN_TRANSITION",
            "drain",
            &format!("transition #{idx} token={session_canary} secret={signing_canary}"),
            &[signing_canary],
        )
        .with_correlation(None, Some("job-drain"), None, None);
        logger.append(&ev).expect("append structured log");
    }

    let rotated_path = env.root().join("logs").join("backend.log.1");
    assert!(log_path.is_file(), "Active log file must exist");
    assert!(
        rotated_path.is_file(),
        "Rotated backup log file must exist after exceeding max_bytes"
    );
    let active_content = fs::read_to_string(&log_path).expect("read active log");
    let rotated_content = fs::read_to_string(&rotated_path).expect("read rotated log");
    assert!(!active_content.contains(session_canary));
    assert!(!active_content.contains(signing_canary));
    assert!(!rotated_content.contains(session_canary));
    assert!(!rotated_content.contains(signing_canary));
    assert!(
        active_content.len() <= 2048,
        "Active log must stay bounded after rotation"
    );
}
