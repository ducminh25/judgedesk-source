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

async fn start_discovery_test_server(
    environment: &common::OwnedTestEnvironment,
) -> (u16, tokio::task::JoinHandle<()>) {
    let state = environment.with_isolated_roots(|| {
        AppState::new(Arc::new(
            judgedesk_core::executor_client::ExecutorClient::unavailable("discovery route test"),
        ))
    });
    let (addr, server_task) = start_embedded_server_with_state(0, state)
        .await
        .expect("start discovery test server");
    (addr.port(), server_task)
}

#[tokio::test]
async fn test_flat_problem_routes_ignore_auxiliary_directories() {
    let environment = common::OwnedTestEnvironment::new();
    let problem_dir = environment.root().join("SUM");
    fs::create_dir_all(problem_dir.join("__pycache__")).unwrap();
    fs::create_dir_all(problem_dir.join("docs")).unwrap();
    fs::write(problem_dir.join("1.inp"), "3 4\n").unwrap();
    fs::write(problem_dir.join("1.out"), "7\n").unwrap();
    fs::write(problem_dir.join("checker.cpp"), "// checker").unwrap();
    fs::write(problem_dir.join("interactor.py"), "# interactor").unwrap();
    let (port, server_task) = start_discovery_test_server(&environment).await;

    let (status, body) = http_request(
        port,
        "GET",
        &format!(
            "/api/fetch-problems?path={}",
            urlencode(&problem_dir.to_string_lossy())
        ),
        None,
        None,
    )
    .await;
    assert_eq!(status, 200);
    let response: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(response["data"], serde_json::json!(["SUM"]));
    assert_eq!(
        response["customCheckers"]["SUM"],
        serde_json::json!(["checker.cpp", "interactor.py"])
    );
    assert_eq!(
        response["interactors"]["SUM"],
        serde_json::json!(["interactor.py"])
    );
    server_task.abort();
}

#[tokio::test]
async fn test_flat_problem_routes_discover_interactive_input_only_root() {
    let environment = common::OwnedTestEnvironment::new();
    let problem_dir = environment.root().join("INTERACTIVE");
    fs::create_dir_all(&problem_dir).unwrap();
    fs::write(problem_dir.join("1.in"), "5\n").unwrap();
    fs::write(problem_dir.join("Config.cfg"), r#"{"isInteractive":true}"#).unwrap();
    let (port, server_task) = start_discovery_test_server(&environment).await;

    let (status, body) = http_request(
        port,
        "GET",
        &format!(
            "/api/fetch-problems?path={}",
            urlencode(&problem_dir.to_string_lossy())
        ),
        None,
        None,
    )
    .await;
    assert_eq!(status, 200);
    let response: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(response["data"], serde_json::json!(["INTERACTIVE"]));
    server_task.abort();
}

async fn assert_interactive_discovery_routes(config_name: Option<&str>, query_flag: bool) {
    let environment = common::OwnedTestEnvironment::new();
    let problem_dir = environment.root().join("INPUT_ONLY");
    fs::create_dir_all(problem_dir.join("INPUT_ONLY").join("docs")).unwrap();
    fs::write(problem_dir.join("1.inp"), "5\n").unwrap();
    if let Some(name) = config_name {
        fs::write(problem_dir.join(name), r#"{"isInteractive":true}"#).unwrap();
    }
    let (port, server_task) = start_discovery_test_server(&environment).await;
    let synthetic_path = urlencode(&problem_dir.join("INPUT_ONLY").to_string_lossy());
    let query = if query_flag {
        "&isInteractive=true"
    } else {
        ""
    };
    let mut responses = Vec::new();
    for route in ["fetch-tests", "fetch-polygon-tests"] {
        let (status, body) = http_request(
            port,
            "GET",
            &format!("/api/{route}?path={synthetic_path}&problem=INPUT_ONLY{query}"),
            None,
            None,
        )
        .await;
        let response: serde_json::Value = serde_json::from_str(&body).unwrap();
        responses.push((status, response));
    }
    assert_eq!(
        responses,
        vec![
            (200, serde_json::json!({ "success": true, "data": ["1"] })),
            (
                200,
                serde_json::json!({
                    "success": true,
                    "data": [{ "name": "1", "preview": "5\n", "size": 2 }]
                })
            ),
        ]
    );
    server_task.abort();
}

#[tokio::test]
async fn test_flat_problem_routes_use_saved_cfg_interactive_mode() {
    assert_interactive_discovery_routes(Some("Config.cfg"), false).await;
}

#[tokio::test]
async fn test_flat_problem_routes_use_saved_json_interactive_mode() {
    assert_interactive_discovery_routes(Some("config.json"), false).await;
}

#[tokio::test]
async fn test_flat_problem_routes_use_requested_interactive_mode() {
    assert_interactive_discovery_routes(None, true).await;
}

#[tokio::test]
async fn test_flat_problem_routes_resolve_synthetic_test_path() {
    let environment = common::OwnedTestEnvironment::new();
    let problem_dir = environment.root().join("SUM");
    fs::create_dir_all(&problem_dir).unwrap();
    fs::write(problem_dir.join("2.inp"), "3 4\n").unwrap();
    fs::write(problem_dir.join("2.out"), "7\n").unwrap();
    let (port, server_task) = start_discovery_test_server(&environment).await;

    let (status, body) = http_request(
        port,
        "GET",
        &format!(
            "/api/fetch-tests?path={}",
            urlencode(&problem_dir.join("sum").to_string_lossy())
        ),
        None,
        None,
    )
    .await;
    assert_eq!(status, 200);
    let response: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(response["data"], serde_json::json!(["2"]));

    let (status, body) = http_request(
        port,
        "GET",
        &format!(
            "/api/fetch-polygon-tests?path={}&problem=SUM",
            urlencode(&problem_dir.join("sum").to_string_lossy())
        ),
        None,
        None,
    )
    .await;
    assert_eq!(status, 200);
    let response: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(
        response["data"],
        serde_json::json!([{ "name": "2", "preview": "3 4\n", "size": 4 }])
    );
    server_task.abort();
}

#[tokio::test]
async fn test_flat_problem_routes_read_config_from_synthetic_path() {
    let environment = common::OwnedTestEnvironment::new();
    let problem_dir = environment.root().join("SUM");
    fs::create_dir_all(problem_dir.join("SUM").join("docs")).unwrap();
    fs::write(problem_dir.join("1.inp"), "3 4\n").unwrap();
    fs::write(problem_dir.join("1.out"), "7\n").unwrap();
    let config = serde_json::json!({ "timeLimit": 1500, "memoryLimit": 256 });
    fs::write(
        problem_dir.join("Config.cfg"),
        serde_json::to_vec(&config).unwrap(),
    )
    .unwrap();
    let (port, server_task) = start_discovery_test_server(&environment).await;

    let (status, body) = http_request(
        port,
        "GET",
        &format!(
            "/api/polygon-config?path={}",
            urlencode(&problem_dir.join("SUM").to_string_lossy())
        ),
        None,
        None,
    )
    .await;
    assert_eq!(status, 200);
    let response: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(response["data"], config);
    server_task.abort();
}

#[tokio::test]
async fn test_flat_problem_routes_write_config_to_synthetic_path() {
    let environment = common::OwnedTestEnvironment::new();
    let problem_dir = environment.root().join("SUM");
    fs::create_dir_all(problem_dir.join("SUM").join("docs")).unwrap();
    fs::write(problem_dir.join("1.inp"), "3 4\n").unwrap();
    fs::write(problem_dir.join("1.out"), "7\n").unwrap();
    let config = serde_json::json!({ "timeLimit": 1500, "memoryLimit": 256 });
    let payload = serde_json::to_vec(&serde_json::json!({
        "path": problem_dir.join("SUM"),
        "config": config,
    }))
    .unwrap();
    let (port, server_task) = start_discovery_test_server(&environment).await;

    let (status, body) = http_request(
        port,
        "POST",
        "/api/polygon-config",
        Some(&payload),
        Some("application/json"),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let stored: serde_json::Value =
        serde_json::from_slice(&fs::read(problem_dir.join("Config.cfg")).unwrap()).unwrap();
    assert_eq!(stored, config);
    assert!(!problem_dir.join("SUM").join("Config.cfg").exists());
    assert!(!problem_dir.join("Config.cfg.tmp").exists());

    let unrelated_path = problem_dir.join("missing");
    let (status, body) = http_request(
        port,
        "GET",
        &format!(
            "/api/polygon-config?path={}",
            urlencode(&unrelated_path.to_string_lossy())
        ),
        None,
        None,
    )
    .await;
    assert_eq!(status, 200);
    let response: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert!(response["data"].is_null());
    let unrelated_payload = serde_json::to_vec(&serde_json::json!({
        "path": unrelated_path,
        "config": { "timeLimit": 9999 },
    }))
    .unwrap();
    let (status, _) = http_request(
        port,
        "POST",
        "/api/polygon-config",
        Some(&unrelated_payload),
        Some("application/json"),
    )
    .await;
    assert_eq!(status, 500);
    let stored: serde_json::Value =
        serde_json::from_slice(&fs::read(problem_dir.join("Config.cfg")).unwrap()).unwrap();
    assert_eq!(stored, config);
    server_task.abort();
}

#[tokio::test]
async fn test_polygon_validation_preview_and_failed_save_never_write_config() {
    let environment = common::OwnedTestEnvironment::new();
    let problem_dir = environment.root().join("SUM");
    fs::create_dir_all(&problem_dir).unwrap();
    fs::write(problem_dir.join("1.inp"), b"1  2\n").unwrap();
    fs::write(problem_dir.join("1.out"), b"3\n").unwrap();
    let original = b"{\"testWellFormed\": false}\n";
    fs::write(problem_dir.join("Config.cfg"), original).unwrap();
    let (port, server_task) = start_discovery_test_server(&environment).await;
    for (preview, expected_status) in [(true, 200), (false, 422)] {
        let payload = serde_json::to_vec(&serde_json::json!({
            "path": problem_dir,
            "config": { "testWellFormed": true },
            "validateOnly": preview,
        }))
        .unwrap();
        let (status, body) = http_request(
            port,
            "POST",
            "/api/polygon-config",
            Some(&payload),
            Some("application/json"),
        )
        .await;
        assert_eq!(status, expected_status, "{body}");
        let response: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(response["data"]["tests"], 1);
        assert_eq!(
            response["data"]["issues"][0],
            serde_json::json!({
                "code": "consecutive_spaces", "line": 1, "column": 3,
                "testName": "1", "fileName": "1.inp",
            })
        );
        assert_eq!(fs::read(problem_dir.join("Config.cfg")).unwrap(), original);
        assert_eq!(fs::read(problem_dir.join("1.inp")).unwrap(), b"1  2\n");
    }
    fs::write(problem_dir.join("1.inp"), b"1 2\r\n").unwrap();
    let payload = serde_json::to_vec(&serde_json::json!({
        "path": problem_dir, "config": { "testWellFormed": true },
    }))
    .unwrap();
    let (status, body) = http_request(
        port,
        "POST",
        "/api/polygon-config",
        Some(&payload),
        Some("application/json"),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let stored: serde_json::Value =
        serde_json::from_slice(&fs::read(problem_dir.join("Config.cfg")).unwrap()).unwrap();
    assert_eq!(stored["testWellFormed"], true);
    assert_eq!(fs::read_dir(&problem_dir).unwrap().count(), 3);
    server_task.abort();
}

#[tokio::test]
async fn test_flat_problem_routes_preview_selected_layout_and_reject_missing_child() {
    let environment = common::OwnedTestEnvironment::new();
    let problem_dir = environment.root().join("SUM");
    fs::create_dir_all(problem_dir.join("1")).unwrap();
    fs::write(problem_dir.join("1").join("sum.inp"), "legacy input\n").unwrap();
    fs::write(problem_dir.join("1").join("sum.out"), "legacy output\n").unwrap();
    fs::write(problem_dir.join("1.inp"), "flat input\n").unwrap();
    fs::write(problem_dir.join("1.out"), "flat output\n").unwrap();
    fs::write(problem_dir.join("2.inp"), "second input\n").unwrap();
    fs::write(problem_dir.join("2.out"), "second output\n").unwrap();
    let (port, server_task) = start_discovery_test_server(&environment).await;

    let (status, body) = http_request(
        port,
        "GET",
        &format!(
            "/api/fetch-polygon-tests?path={}&problem=SUM",
            urlencode(&problem_dir.to_string_lossy())
        ),
        None,
        None,
    )
    .await;
    assert_eq!(status, 200);
    let response: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(
        response["data"],
        serde_json::json!([{ "name": "1", "preview": "legacy input\n", "size": 13 }])
    );

    let (status, _) = http_request(
        port,
        "GET",
        &format!(
            "/api/fetch-polygon-tests?path={}&problem=SUM",
            urlencode(&problem_dir.join("missing").to_string_lossy())
        ),
        None,
        None,
    )
    .await;
    assert_eq!(status, 404);
    server_task.abort();
}

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
