use judgedesk_core::server::{start_embedded_server_with_state, AppState, WorkbookOpener};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

struct TestWorkbookOpener {
    opened: Arc<Mutex<Vec<PathBuf>>>,
}

impl WorkbookOpener for TestWorkbookOpener {
    fn open_workbook(&self, book_path: &Path) -> Result<(), String> {
        self.opened.lock().unwrap().push(book_path.to_path_buf());
        Ok(())
    }
}

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

mod common;

#[tokio::test]
async fn test_embedded_axum_server_full_suite() {
    let _test_environment = common::OwnedTestEnvironment::new();
    common::ensure_test_environment();
    let test_root =
        std::env::temp_dir().join(format!("test_server_contest_{}", std::process::id()));
    let test_export_dir = test_root.join("exports");
    fs::create_dir_all(&test_export_dir).unwrap();

    let opened_workbooks = Arc::new(Mutex::new(Vec::new()));
    let mut state = _test_environment.with_isolated_roots(AppState::default);
    assert!(state.platform.root().starts_with(_test_environment.root()));
    state.export_dir = Some(test_export_dir.clone());
    state.workbook_opener = Arc::new(TestWorkbookOpener {
        opened: Arc::clone(&opened_workbooks),
    });

    let (addr, mut server_task) = start_embedded_server_with_state(0, state)
        .await
        .expect("Failed to start embedded server");
    let port = addr.port();
    assert!(port > 0);

    // 1. GET /api/status
    let (status, body) = http_request(port, "GET", "/api/status", None, None).await;
    assert_eq!(status, 200);
    assert!(body.contains("\"success\":true"));
    assert!(body.contains("\"secureRunner\""));
    assert!(body.contains("\"build\""));
    assert!(body.contains("\"sandbox\""));

    // 2. GET /api/distribution
    let (status, body) = http_request(port, "GET", "/api/distribution", None, None).await;
    assert_eq!(status, 200);
    assert!(body.contains("\"distribution\":\"full\""));
    assert!(body.contains("\"platform\":"));

    // 3. Toolchain routes
    let (status, body) = http_request(port, "GET", "/api/toolchains", None, None).await;
    assert_eq!(status, 200);
    assert!(body.contains("\"profiles\":"));
    assert!(body.contains("\"discovery\":"));
    assert!(body.contains("\"capabilities\":"));
    assert!(body.contains("\"id\":\"cpp\""));
    assert!(body.contains("\"id\":\"c\""));
    assert!(body.contains("\"id\":\"python\""));
    assert!(body.contains("\"id\":\"pascal\""));
    assert!(body.contains("\"id\":\"java\""));
    assert!(body.contains("\"id\":\"scratch\""));
    #[cfg(windows)]
    assert!(body.contains("\"gcc-windows-x64\""));

    let (status, body) = http_request(port, "POST", "/api/toolchains/rescan", None, None).await;
    assert_eq!(status, 202);
    assert!(body.contains("\"success\":true"));

    let (status, body) = http_request(
        port,
        "PUT",
        "/api/toolchains/execution-policy",
        Some(b"{\"allowResourceOnlyLocalExecution\":true}"),
        Some("application/json"),
    )
    .await;
    assert_eq!(status, 200);
    assert!(body.contains("\"success\":true"));

    let (status, body) = http_request(
        port,
        "PUT",
        "/api/toolchains/profiles/cpp/preference",
        Some(b"{\"mode\":\"local_path\",\"localPath\":\"C:\\\\TestMinGW\\\\bin\\\\g++.exe\"}"),
        Some("application/json"),
    )
    .await;
    assert_eq!(status, 200);
    assert!(body.contains("\"success\":true"));

    let (status, body) = http_request(port, "GET", "/api/toolchains", None, None).await;
    assert_eq!(status, 200);
    assert!(body.contains("\"mode\":\"local_path\""));
    assert!(body.contains("TestMinGW"));

    let (status, body) = http_request(
        port,
        "PUT",
        "/api/toolchains/profiles/cpp/preference",
        Some(b"{\"mode\":\"local_auto\"}"),
        Some("application/json"),
    )
    .await;
    assert_eq!(status, 200);
    assert!(body.contains("\"success\":true"));

    let (status, body) = http_request(
        port,
        "POST",
        "/api/toolchains/profiles/cpp/certify",
        Some(b"{\"executablePath\":\"g++\"}"),
        Some("application/json"),
    )
    .await;
    assert_eq!(status, 200);
    assert!(body.contains("\"certificate\""));

    let (status, body) = http_request(port, "POST", "/api/toolchains/prewarm", None, None).await;
    assert_eq!(status, 200);
    assert!(body.contains("\"message\":\"Background pre-warm initiated.\""));

    let (status, body) = http_request(
        port,
        "POST",
        "/api/toolchains/profiles/cpp/certification-plan",
        None,
        None,
    )
    .await;
    assert_eq!(status, 200);
    assert!(body.contains("\"plan\""));
    assert!(body.contains("\"maxSupportedSnapshotBytes\""));

    let (status, body) = http_request(
        port,
        "POST",
        "/api/toolchains/profiles/cpp/diagnose",
        None,
        None,
    )
    .await;
    assert_eq!(status, 200);
    assert!(body.contains("\"diagnostic\""));
    assert!(body.contains("\"compilerAvailable\"") || body.contains("\"language\":\"cpp\""));

    let (status, body) = http_request(
        port,
        "POST",
        "/api/toolchains/custom-path",
        Some(b"{\"kind\":\"cpp\",\"path\":\"C:/MinGW/bin/g++.exe\"}"),
        Some("application/json"),
    )
    .await;
    assert_eq!(status, 200);
    assert!(body.contains("\"success\":true"));

    // 4. Setup mock contest directory for discovery and batch judging
    let thisinh_dir = test_root.join("thisinh");
    let test_dir = test_root.join("testcases");

    let contestant_dir = thisinh_dir.join("contestant_1");
    fs::create_dir_all(&contestant_dir).unwrap();

    let problem_dir = test_dir.join("sum");
    let tc1_dir = problem_dir.join("1");
    fs::create_dir_all(&tc1_dir).unwrap();

    fs::write(tc1_dir.join("sum.inp"), "3 4\n").unwrap();
    fs::write(tc1_dir.join("sum.out"), "7\n").unwrap();

    // Problem config
    fs::write(
        problem_dir.join("Config.cfg"),
        r#"{
            "timeLimit": 1000,
            "memoryLimit": 256,
            "checkerType": "C1",
            "useStdIn": true,
            "useStdOut": true
        }"#,
    )
    .unwrap();

    // Problem "sub" without submission (tests SKIPPED handling)
    let sub_dir = test_dir.join("sub");
    let sub_tc_dir = sub_dir.join("1");
    fs::create_dir_all(&sub_tc_dir).unwrap();
    fs::write(sub_tc_dir.join("sub.inp"), "10\n").unwrap();
    fs::write(sub_tc_dir.join("sub.out"), "10\n").unwrap();

    // Contestant submission for sum only
    fs::write(
        contestant_dir.join("sum.cpp"),
        r#"#include <iostream>
using namespace std;
int main() {
    int a, b;
    if (cin >> a >> b) {
        cout << (a + b) << endl;
    }
    return 0;
}
"#,
    )
    .unwrap();

    fn urlencode(s: &str) -> String {
        let mut out = String::new();
        for b in s.bytes() {
            if b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.' || b == b'~' {
                out.push(b as char);
            } else {
                out.push_str(&format!("%{:02X}", b));
            }
        }
        out
    }

    // 5. Test discovery endpoints
    let enc_thisinh = urlencode(&thisinh_dir.to_string_lossy());
    let (status, body) = http_request(
        port,
        "GET",
        &format!("/api/fetch-contestants?path={enc_thisinh}"),
        None,
        None,
    )
    .await;
    assert_eq!(status, 200);
    assert!(body.contains("contestant_1"));

    let enc_test = urlencode(&test_dir.to_string_lossy());
    let (status, body) = http_request(
        port,
        "GET",
        &format!("/api/fetch-problems?path={enc_test}"),
        None,
        None,
    )
    .await;
    assert_eq!(status, 200);
    assert!(body.contains("sum"));
    assert!(body.contains("sub"));

    let enc_problem = urlencode(&problem_dir.to_string_lossy());
    let (status, body) = http_request(
        port,
        "GET",
        &format!("/api/fetch-polygon-tests?path={enc_problem}&problem=sum"),
        None,
        None,
    )
    .await;
    assert_eq!(status, 200);
    assert!(body.contains("\"name\":\"1\""));
    assert!(body.contains("\"preview\":\"3 4"));

    // 6. Test polygon-config GET and POST
    let (status, body) = http_request(
        port,
        "GET",
        &format!("/api/polygon-config?path={enc_problem}"),
        None,
        None,
    )
    .await;
    assert_eq!(status, 200);
    assert!(body.contains("\"timeLimit\":1000"));

    let save_body = serde_json::json!({
        "path": problem_dir.to_string_lossy(),
        "config": {
            "timeLimit": 1500,
            "memoryLimit": 512,
            "checkerType": "C1",
            "useStdIn": true,
            "useStdOut": true
        }
    });
    let save_str = serde_json::to_string(&save_body).unwrap();
    let (status, body) = http_request(
        port,
        "POST",
        "/api/polygon-config",
        Some(save_str.as_bytes()),
        Some("application/json"),
    )
    .await;
    assert_eq!(status, 200);
    assert!(body.contains("\"success\":true"));

    // Verify config was persisted
    let reloaded_cfg = fs::read_to_string(problem_dir.join("Config.cfg")).unwrap();
    assert!(reloaded_cfg.contains("\"timeLimit\": 1500"));

    // 7. Test batch judging with NDJSON streaming (including both submitted 'sum' and missing 'sub')!
    let judge_payload = serde_json::json!({
        "thisinhPath": thisinh_dir.to_string_lossy(),
        "testPath": test_dir.to_string_lossy(),
        "jobId": "test_job_1",
        "targetContestants": ["contestant_1"],
        "targetProblems": ["sum", "sub"]
    });
    let judge_str = serde_json::to_string(&judge_payload).unwrap();
    let (status, body) = http_request(
        port,
        "POST",
        "/api/batch-judge",
        Some(judge_str.as_bytes()),
        Some("application/json"),
    )
    .await;
    assert_eq!(status, 200);
    assert!(body.contains("\"metadata\""));
    assert!(body.contains("\"problem_completed\""));
    assert!(body.contains("\"problemName\":\"sum\""));
    assert!(body.contains("\"status\":\"AC\""));
    // Verify missing problem emitted SKIPPED
    assert!(body.contains("\"problemName\":\"sub\""));
    assert!(body.contains("\"compileStatus\":\"SKIPPED\""));
    assert!(body.contains("\"done\""));

    // 8. Test open-excel with wire payload
    const MAGIC: [u8; 8] = [0x4a, 0x44, 0x58, 0x4c, 0x53, 0x58, 0x30, 0x31];
    let diag = b"{\"sample\":\"diagnostic\"}";
    let mut wire_payload = Vec::new();
    wire_payload.extend_from_slice(&MAGIC);
    wire_payload.extend_from_slice(&(diag.len() as u32).to_le_bytes());
    wire_payload.extend_from_slice(diag);
    wire_payload.extend_from_slice(b"fake-xlsx-content");

    let (status, body) = http_request(
        port,
        "POST",
        "/api/open-excel",
        Some(&wire_payload),
        Some("application/vnd.judgedesk.score-export-v1"),
    )
    .await;
    assert_eq!(status, 200);
    assert!(body.contains("\"success\":true"));
    assert!(body.contains("\"diagnosticsPath\""));

    let expected_book = test_export_dir.join("Book.xlsx");
    let expected_diag = test_export_dir.join("diagnostics.json");
    assert!(
        expected_book.exists(),
        "Book.xlsx must exist inside owned export directory"
    );
    assert!(
        expected_diag.exists(),
        "diagnostics.json must exist inside owned export directory"
    );

    {
        let opened = opened_workbooks.lock().unwrap();
        assert_eq!(
            opened.len(),
            1,
            "Injected workbook opener must be called exactly once"
        );
        assert_eq!(
            opened[0], expected_book,
            "Opener must be called with path inside owned root"
        );
    }

    // 9. Cleanup and shutdown
    let (status, body) = http_request(port, "POST", "/api/shutdown", None, None).await;
    assert_eq!(status, 200);
    assert!(body.contains("\"success\":true"));

    // Await graceful termination of server_task with timeout; fail closed on timeout, panic, cancellation, or error
    let shutdown_result =
        tokio::time::timeout(std::time::Duration::from_millis(3000), &mut server_task)
            .await
            .expect(
                "Server task failed to shut down gracefully within 3000ms deadline (timed out)",
            );
    match shutdown_result {
        Ok(()) => {}
        Err(join_err) => {
            if join_err.is_panic() {
                panic!("Server task panicked during execution or shutdown: {join_err}");
            } else if join_err.is_cancelled() {
                panic!("Server task was unexpectedly cancelled: {join_err}");
            } else {
                panic!("Server task join failed: {join_err}");
            }
        }
    }

    // Verify port is released by attempting to bind to it with retries
    let mut port_released = false;
    for _ in 0..30 {
        if std::net::TcpListener::bind(("127.0.0.1", port)).is_ok() {
            port_released = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert!(
        port_released,
        "Server port {port} must be released after shutdown"
    );

    // Assert that no external export_* directories were created in std::env::temp_dir()
    if let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if name_str.starts_with("export_") {
                panic!(
                    "Found unexpected external export root in temp dir: {}",
                    entry.path().display()
                );
            }
        }
    }

    let _ = fs::remove_dir_all(&test_root);
    assert!(!test_root.exists(), "test_root must be fully cleaned up");
}
