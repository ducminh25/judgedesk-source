use judgedesk_core::server::{start_embedded_server_with_state, AppState, DirectoryPicker};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

mod common;

struct TestDirectoryPicker;

impl DirectoryPicker for TestDirectoryPicker {
    fn select_directory(&self, _default_path: Option<&str>) -> Result<Option<String>, String> {
        if let Ok(val) = std::env::var("JUDGEDESK_TEST_SELECT_FILE")
            .or_else(|_| std::env::var("JUDGEDESK_TEST_SELECT_DIRECTORY"))
        {
            if val == "__CANCEL__" {
                return Ok(None);
            }
            if let Ok(content) = std::fs::read_to_string(&val) {
                let trimmed = content.trim();
                if trimmed == "__CANCEL__" {
                    return Ok(None);
                }
                return Ok(Some(trimmed.to_string()));
            }
            return Ok(Some(val));
        }
        Ok(None)
    }
}

async fn http_request(
    port: u16,
    method: &str,
    path: &str,
    body: Option<&[u8]>,
    content_type: Option<&str>,
    extra_headers: Option<&[(&str, &str)]>,
) -> (u16, String) {
    let mut stream = TcpStream::connect(format!("127.0.0.1:{port}"))
        .await
        .expect("Connect to server");

    let ct_header = content_type
        .map(|ct| format!("Content-Type: {ct}\r\n"))
        .unwrap_or_default();
    let mut extra_str = String::new();
    if let Some(headers) = extra_headers {
        for (k, v) in headers {
            extra_str.push_str(&format!("{k}: {v}\r\n"));
        }
    }
    let body_len = body.map(|b| b.len()).unwrap_or(0);

    let req_header = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{ct_header}{extra_str}Content-Length: {body_len}\r\nConnection: close\r\n\r\n"
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
async fn test_api_contract_manifest_coverage() {
    let manifest_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../docs/verification/pure-rust-core/api-contract-manifest.json");
    assert!(
        manifest_path.exists(),
        "api-contract-manifest.json must exist"
    );

    let content = std::fs::read_to_string(&manifest_path).expect("Read manifest");
    let manifest: serde_json::Value = serde_json::from_str(&content).expect("Parse JSON manifest");

    let routes = manifest["routes"].as_array().expect("routes array");
    assert_eq!(routes.len(), 29, "Expected 29 routes in canonical contract");

    for route in routes {
        assert!(route.get("id").is_some(), "Every route must have an id");
        assert!(
            route.get("method").is_some(),
            "Every route must have a method"
        );
        assert!(route.get("path").is_some(), "Every route must have a path");
    }
}

#[tokio::test]
async fn test_rust_core_contract_endpoints() {
    let test_environment = common::OwnedTestEnvironment::new();
    common::ensure_test_environment();
    let mut state = test_environment.with_isolated_roots(AppState::default);
    assert!(state.platform.root().starts_with(test_environment.root()));
    state.directory_picker = Arc::new(TestDirectoryPicker);
    let (addr, server_task) = start_embedded_server_with_state(0, state)
        .await
        .expect("start server");
    let port = addr.port();

    // 1. Status endpoint contract
    let (status, body) = http_request(port, "GET", "/api/status", None, None, None).await;
    assert_eq!(status, 200);
    let parsed: serde_json::Value = serde_json::from_str(&body).expect("parse status json");
    assert_eq!(parsed["success"], true);
    assert!(parsed.get("gpp").is_some(), "status must contain gpp");
    assert!(parsed.get("python").is_some(), "status must contain python");
    assert!(
        parsed.get("platform").is_some(),
        "status must contain platform"
    );

    // 2. Distribution endpoint contract
    let (d_status, d_body) = http_request(port, "GET", "/api/distribution", None, None, None).await;
    assert_eq!(d_status, 200);
    let d_parsed: serde_json::Value =
        serde_json::from_str(&d_body).expect("parse distribution json");
    assert!(d_parsed.get("platform").is_some());
    assert!(d_parsed.get("arch").is_some());

    // 3. Select directory test contract via process env configuration
    std::env::set_var("JUDGEDESK_TEST_SELECT_DIRECTORY", "__CANCEL__");
    let (s_status, s_body) = http_request(
        port,
        "POST",
        "/api/select-directory",
        Some(b"{\"defaultPath\":\"\"}"),
        Some("application/json"),
        None,
    )
    .await;
    assert_eq!(s_status, 200);
    let s_parsed: serde_json::Value =
        serde_json::from_str(&s_body).expect("parse select-directory json");
    assert_eq!(s_parsed["success"], false);
    assert_eq!(s_parsed["error"], "Canceled");

    // 4. Batch-judge NDJSON stream framing contract
    let temp_dir =
        std::env::temp_dir().join(format!("judgedesk-contract-proof-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&temp_dir);
    let thisinh_dir = temp_dir.join("thisinh");
    let test_dir = temp_dir.join("tests");
    let _ = std::fs::create_dir_all(&thisinh_dir);
    let _ = std::fs::create_dir_all(&test_dir);

    let judge_payload = serde_json::json!({
        "thisinhPath": thisinh_dir.to_string_lossy(),
        "testPath": test_dir.to_string_lossy(),
        "jobId": "contract_proof_job_1",
        "targetContestants": [],
        "targetProblems": []
    });
    let judge_str = serde_json::to_string(&judge_payload).unwrap();
    let (j_status, j_body) = http_request(
        port,
        "POST",
        "/api/batch-judge",
        Some(judge_str.as_bytes()),
        Some("application/json"),
        None,
    )
    .await;

    assert_eq!(j_status, 200);
    let first_line = j_body
        .lines()
        .find(|l| l.contains("\"metadata\""))
        .unwrap_or_default();
    assert!(
        !first_line.is_empty(),
        "Batch judge response must contain metadata line in NDJSON stream"
    );
    let parsed_meta: serde_json::Value =
        serde_json::from_str(first_line).expect("parse metadata json");
    assert_eq!(parsed_meta["type"], "metadata");
    assert!(parsed_meta["data"]["toolchains"].get("cpp").is_some());

    // 5. Cancellation endpoint contract
    let cancel_payload = serde_json::json!({ "jobId": "contract_proof_job_1" });
    let cancel_str = serde_json::to_string(&cancel_payload).unwrap();
    let (c_status, c_body) = http_request(
        port,
        "POST",
        "/api/batch-judge/cancel",
        Some(cancel_str.as_bytes()),
        Some("application/json"),
        None,
    )
    .await;
    assert_eq!(c_status, 200);
    let c_parsed: serde_json::Value = serde_json::from_str(&c_body).expect("parse cancel json");
    assert_eq!(c_parsed["success"], true);

    let _ = std::fs::remove_dir_all(&temp_dir);
    server_task.abort();
}
