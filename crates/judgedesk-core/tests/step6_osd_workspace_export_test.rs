mod common;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use judgedesk_core::executor_client::ExecutorClient;
use judgedesk_core::osd::{
    claim_osd_source_file, dispose_claimed_source, parse_osd_filename, stage_claimed_source,
    verify_claimed_source_integrity, wait_for_claimed_source_stability, write_osd_error_log,
    write_osd_log, OsdInvalidReason, OsdJob, OsdParseResult,
};
use judgedesk_core::rational::Rational;
use judgedesk_core::scoring::{ProblemSummary, TestCaseRun};
use judgedesk_core::server::routes::osd::ProblemResultForLog;
use judgedesk_core::server::{start_embedded_server_with_state, AppState, WorkbookOpener};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

struct RecordingWorkbookOpener {
    opened: Arc<Mutex<Vec<PathBuf>>>,
}

impl WorkbookOpener for RecordingWorkbookOpener {
    fn open_workbook(&self, book_path: &Path) -> Result<(), String> {
        self.opened
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(book_path.to_path_buf());
        Ok(())
    }
}

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

async fn http_request(
    port: u16,
    method: &str,
    path: &str,
    body: Option<&[u8]>,
    content_type: Option<&str>,
) -> (u16, String) {
    let mut stream = TcpStream::connect(format!("127.0.0.1:{port}"))
        .await
        .expect("connect to test server");

    let ct_header = content_type
        .map(|ct| format!("Content-Type: {ct}\r\n"))
        .unwrap_or_default();
    let body_len = body.map(|b| b.len()).unwrap_or(0);
    let req = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{ct_header}Content-Length: {body_len}\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(req.as_bytes()).await.unwrap();
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

#[test]
fn wp6_1a_osd_parser_supports_dotted_and_dotless_themis_filenames_and_rejects_unsafe_components() {
    let valid_problems = vec!["SUM".to_string(), "GRAPH".to_string()];

    // 1. Standard dotted filename and case-insensitive problem match
    let parsed_dotted = parse_osd_filename("1650000000[HS01][sum].cpp", &valid_problems);
    assert_eq!(
        parsed_dotted,
        OsdParseResult::Valid {
            prefix: "1650000000".to_string(),
            contestant: "HS01".to_string(),
            problem: "SUM".to_string(),
            language: "cpp".to_string(),
            ext: ".cpp".to_string(),
        }
    );

    // 2. Dotless Themis Web filenames across all 6 release languages
    let dotless_cases = [
        ("0[HS01][SUM]cpp", "cpp", ".cpp"),
        ("0[HS01][SUM]c", "c", ".c"),
        ("0[HS01][SUM]py", "python", ".py"),
        ("0[HS01][SUM]pas", "pascal", ".pas"),
        ("0[HS01][SUM]java", "java", ".java"),
        ("0[HS01][SUM]sb3", "scratch", ".sb3"),
    ];
    for (filename, expected_lang, expected_ext) in dotless_cases {
        let res = parse_osd_filename(filename, &valid_problems);
        assert_eq!(
            res,
            OsdParseResult::Valid {
                prefix: "0".to_string(),
                contestant: "HS01".to_string(),
                problem: "SUM".to_string(),
                language: expected_lang.to_string(),
                ext: expected_ext.to_string(),
            },
            "failed on dotless filename {filename}"
        );
    }

    // 3. Rejections: unsafe components, reserved Windows device names, bullet separator, unknown problem, unsupported extension
    for unsafe_name in [
        "0[..][SUM]cpp",
        "0[.][SUM]cpp",
        "0[CON][SUM]cpp",
        "0[com1.txt][SUM]cpp",
        "0[HS01.][SUM]cpp",
        "0[ HS01][SUM]cpp",
        "0[HS01‣A][SUM]cpp",
        "0[HS/01][SUM]cpp",
        "0[HS\\01][SUM]cpp",
        "random_file.cpp",
    ] {
        assert_eq!(
            parse_osd_filename(unsafe_name, &valid_problems),
            OsdParseResult::Invalid {
                reason: OsdInvalidReason::InvalidFormat
            },
            "expected InvalidFormat for {unsafe_name}"
        );
    }

    assert_eq!(
        parse_osd_filename("0[HS01][SUM].rs", &valid_problems),
        OsdParseResult::Invalid {
            reason: OsdInvalidReason::UnsupportedExtension
        }
    );
    assert_eq!(
        parse_osd_filename("0[HS01][UNKNOWN].cpp", &valid_problems),
        OsdParseResult::Invalid {
            reason: OsdInvalidReason::UnknownProblem
        }
    );
}

#[tokio::test]
async fn wp6_1a_osd_durable_source_claim_stability_and_themis_crlf_log_writer() {
    let env = common::OwnedTestEnvironment::new();
    let osd_dir = env.root().join("osd_inbox");
    fs::create_dir_all(&osd_dir).unwrap();

    // 1. Atomic claim -> stability -> snapshot staging -> integrity verification -> leaf disposal
    let incoming_file = osd_dir.join("0[HS01][SUM]cpp");
    let source_bytes = b"#include <iostream>\nint main() { return 0; }\n";
    fs::write(&incoming_file, source_bytes).unwrap();

    let claimed = claim_osd_source_file(&osd_dir, &incoming_file, "SUM.cpp")
        .expect("claim source file into owned directory");
    assert!(!incoming_file.exists(), "original inbox file must be moved");
    assert!(claimed.incoming_path.is_file());

    let stable = wait_for_claimed_source_stability(&claimed, 10, 5)
        .await
        .expect("wait for stability");
    assert_eq!(stable.size, source_bytes.len() as u64);

    let staged = stage_claimed_source(&claimed, &stable).expect("stage claimed source");
    assert!(!claimed.incoming_path.exists());
    assert!(staged.staged_path.is_file());
    assert_eq!(staged.sha256.len(), 64);

    verify_claimed_source_integrity(&staged).expect("verify staged source integrity");

    // Mutating staged file must fail integrity check
    fs::write(&staged.staged_path, b"tampered").unwrap();
    assert!(
        verify_claimed_source_integrity(&staged).is_err(),
        "tampered staged file must fail integrity check"
    );

    dispose_claimed_source(&claimed).expect("dispose claimed source");
    assert!(
        !claimed.owned_dir.exists(),
        "owned leaf directory must be removed"
    );
    assert!(
        osd_dir.is_dir(),
        "parent osd_dir must remain intact after leaf disposal"
    );

    // 2. Themis Web CRLF log writer formatting (exact 6 decimals, ‣ separator, ℱ error prefix)
    let job = OsdJob {
        id: "osd_test_1".to_string(),
        original_file_name: "0[HS01][SUM]cpp".to_string(),
        contestant: "HS01".to_string(),
        problem: "SUM".to_string(),
        language: "cpp".to_string(),
        ext: ".cpp".to_string(),
        received_at: 1_700_000_000_000,
    };

    let result = ProblemResultForLog {
        problem_name: "SUM".to_string(),
        compile_status: "OK".to_string(),
        compile_error: None,
        test_cases: vec![
            TestCaseRun {
                name: "Test01".to_string(),
                status: "AC".to_string(),
                score: json!("10/3"),
                score_exact: Some(Rational::new(10, 3)),
                execution_time: Some(42),
                peak_memory: Some(1024),
                checker_message: None,
                expected_output_preview: None,
                actual_output_preview: None,
                error_detail: None,
                execution: None,
            },
            TestCaseRun {
                name: "Test02".to_string(),
                status: "TLE".to_string(),
                score: json!(0),
                score_exact: Some(Rational::ZERO),
                execution_time: Some(1001),
                peak_memory: Some(1024),
                checker_message: None,
                expected_output_preview: None,
                actual_output_preview: None,
                error_detail: None,
                execution: None,
            },
        ],
        summary: ProblemSummary {
            total: 2,
            passed: 1,
            score: 3.333333,
            max_score: 10.0,
            score_exact: Some(Rational::new(10, 3)),
            max_score_exact: Some(Rational::new(10, 1)),
            status: "PARTIAL".to_string(),
        },
    };

    let log_path = write_osd_log(&osd_dir, &job, &result).expect("write OSD log");
    let raw_log = fs::read_to_string(&log_path).unwrap();
    assert!(
        raw_log.contains("\r\n") && !raw_log.replace("\r\n", "").contains('\n'),
        "OSD log must use CRLF line endings exclusively"
    );
    assert!(raw_log.starts_with("HS01‣SUM: 3.333333\r\nSUM.cpp\r\nDịch thành công\r\n\r\n"));
    assert!(raw_log
        .contains("HS01‣SUM‣Test01: 3.333333\r\nThời gian ≈ 0.042000 giây\r\nKết quả khớp\r\n"));
    assert!(raw_log.contains("HS01‣SUM‣Test02: 0.000000\r\nChạy quá thời gian\r\n"));

    let err_log_path = write_osd_error_log(
        &osd_dir,
        "0[HS01][SUM]cpp",
        "HS01",
        "SUM",
        ".cpp",
        "Từ chối bài nộp",
        "File nộp không ổn định.",
    )
    .expect("write OSD error log");
    let raw_err_log = fs::read_to_string(&err_log_path).unwrap();
    assert_eq!(
        raw_err_log,
        "HS01‣SUM: ℱ Từ chối bài nộp\r\nSUM.cpp\r\nErr\r\nFile nộp không ổn định.\r\n"
    );
}

#[tokio::test]
async fn wp6_1b_and_6_1c_osd_watcher_debounce_latest_job_wins_queue_sse_stream_and_stop_drain() {
    let env = common::OwnedTestEnvironment::new();
    common::ensure_test_environment();
    let exe_path = common::executor_binary_path();
    let live_client = env
        .with_isolated_roots(|| ExecutorClient::spawn_sync(&exe_path))
        .expect("spawn live executor");

    let mut state = env.with_isolated_roots(|| AppState::new(Arc::new(live_client)));
    let app_data_dir = env.root().join("appdata");
    fs::create_dir_all(&app_data_dir).unwrap();
    state.set_app_data_dir(&app_data_dir);

    let (addr, server_task) = start_embedded_server_with_state(0, state.clone())
        .await
        .expect("start embedded server");
    let port = addr.port();

    let osd_inbox = env.root().join("osd_inbox");
    let contestants_dir = env.root().join("contestants");
    let problems_dir = env.root().join("problems");
    let sum_tc1 = problems_dir.join("SUM").join("Test01");
    fs::create_dir_all(&osd_inbox).unwrap();
    fs::create_dir_all(&contestants_dir).unwrap();
    fs::create_dir_all(&sum_tc1).unwrap();
    fs::write(sum_tc1.join("SUM.inp"), "7 8\n").unwrap();
    fs::write(sum_tc1.join("SUM.out"), "15\n").unwrap();
    fs::write(
        problems_dir.join("SUM").join("Config.cfg"),
        r#"{"useStdIO":true,"defaultScore":10}"#,
    )
    .unwrap();

    // 1. Initial GET /api/osd/status
    let (status_code, status_body) = http_request(port, "GET", "/api/osd/status", None, None).await;
    assert_eq!(status_code, 200);
    let status_json: Value = serde_json::from_str(&status_body).unwrap();
    assert_eq!(status_json["success"], true);
    assert_eq!(status_json["status"]["active"], false);

    // 2. Start OSD watching via POST /api/osd/start
    let start_payload = json!({
        "osdPath": osd_inbox,
        "contestantsPath": contestants_dir,
        "testPath": problems_dir,
        "enableLog": true
    })
    .to_string();
    let (start_code, start_body) = http_request(
        port,
        "POST",
        "/api/osd/start",
        Some(start_payload.as_bytes()),
        Some("application/json"),
    )
    .await;
    assert_eq!(start_code, 200, "OSD start failed: {start_body}");
    let start_json: Value = serde_json::from_str(&start_body).unwrap();
    assert_eq!(start_json["status"]["active"], true);
    assert_eq!(start_json["status"]["enableLog"], true);

    // 3. Connect to GET /api/osd/events and verify initial SSE osd_status frame
    let mut sse_stream = TcpStream::connect(format!("127.0.0.1:{port}"))
        .await
        .unwrap();
    let sse_req = format!(
        "GET /api/osd/events HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAccept: text/event-stream\r\n\r\n"
    );
    sse_stream.write_all(sse_req.as_bytes()).await.unwrap();
    let mut sse_buf = vec![0u8; 4096];
    let n = tokio::time::timeout(Duration::from_secs(3), sse_stream.read(&mut sse_buf))
        .await
        .expect("SSE initial read timeout")
        .expect("SSE read");
    let sse_initial = String::from_utf8_lossy(&sse_buf[..n]).to_string();
    assert!(
        sse_initial
            .to_ascii_lowercase()
            .contains("content-type: text/event-stream"),
        "expected text/event-stream header: {sse_initial}"
    );
    assert!(
        sse_initial.contains("\"type\":\"osd_status\""),
        "expected initial osd_status SSE event: {sse_initial}"
    );

    // 4. Drop two dotless Themis Web submissions for HS01 SUM in sequence to verify judging + $History archiving + log generation
    let sub1 = osd_inbox.join("0[HS01][SUM]cpp");
    fs::write(
        &sub1,
        "#include <iostream>\nint main() { int a, b; if (std::cin >> a >> b) std::cout << (a + b) << '\\n'; return 0; }\n",
    )
    .unwrap();

    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        let (_, body) = http_request(port, "GET", "/api/osd/status", None, None).await;
        let v: Value = serde_json::from_str(&body).unwrap();
        if v["status"]["totalProcessed"].as_u64().unwrap_or(0) >= 1 {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for first OSD job to complete: {v}"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    assert!(
        contestants_dir.join("HS01").join("SUM.cpp").is_file(),
        "Contestants/HS01/SUM.cpp must be created"
    );
    let log_file = osd_inbox.join("logs").join("0[HS01][SUM]cpp.log");
    assert!(log_file.is_file(), "Themis Web log file must be written");
    let log_text = fs::read_to_string(&log_file).unwrap();
    assert!(log_text.contains("HS01‣SUM: 10.000000\r\n"));
    assert!(log_text.contains("Dịch thành công\r\n"));

    // Drop a second submission for HS01 SUM so the first is archived into $History
    let sub2 = osd_inbox.join("1[HS01][SUM]cpp");
    fs::write(
        &sub2,
        "#include <iostream>\nint main() { int a, b; if (std::cin >> a >> b) std::cout << (a + b) << \"\\n\"; return 0; }\n",
    )
    .unwrap();
    let deadline2 = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        let (_, body) = http_request(port, "GET", "/api/osd/status", None, None).await;
        let v: Value = serde_json::from_str(&body).unwrap();
        if v["status"]["totalProcessed"].as_u64().unwrap_or(0) >= 2 {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline2,
            "timed out waiting for second OSD job to complete: {v}"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    let history_dir = contestants_dir.join("HS01").join("$History");
    assert!(
        history_dir.is_dir() && fs::read_dir(&history_dir).unwrap().count() >= 1,
        "previous submission must be archived in Contestants/HS01/$History"
    );

    // 5. Case-insensitive contestant alias collision (hs01 vs HS01) must be rejected into Rejected/
    let alias_sub = osd_inbox.join("2[hs01][SUM]cpp");
    fs::write(&alias_sub, "int main() { return 0; }\n").unwrap();
    let deadline3 = tokio::time::Instant::now() + Duration::from_secs(10);
    let rejected_dir = osd_inbox.join("Rejected");
    loop {
        if rejected_dir.is_dir() && fs::read_dir(&rejected_dir).unwrap().count() >= 1 {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline3,
            "timed out waiting for case-alias submission to move to Rejected/"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    // 6. Stop OSD watching via POST /api/osd/stop and verify config paths are retained in status while active=false
    let (stop_code, stop_body) = http_request(port, "POST", "/api/osd/stop", None, None).await;
    assert_eq!(stop_code, 200);
    let stop_json: Value = serde_json::from_str(&stop_body).unwrap();
    assert_eq!(stop_json["status"]["active"], false);
    assert_eq!(
        stop_json["status"]["osdPath"].as_str(),
        Some(osd_inbox.to_string_lossy().as_ref())
    );
    assert_eq!(
        stop_json["status"]["contestantsPath"].as_str(),
        Some(contestants_dir.to_string_lossy().as_ref())
    );
    assert_eq!(
        stop_json["status"]["testPath"].as_str(),
        Some(problems_dir.to_string_lossy().as_ref())
    );

    drop(sse_stream);
    let _ = http_request(port, "POST", "/api/shutdown", None, None).await;
    let _ = tokio::time::timeout(Duration::from_secs(3), server_task).await;
}

#[tokio::test]
async fn wp6_2_workspace_problem_routes_utf8_multibyte_preview_and_polygon_compile_normalization() {
    let env = common::OwnedTestEnvironment::new();
    let state = env.with_isolated_roots(|| {
        AppState::new(Arc::new(ExecutorClient::unavailable(
            "wp6.2 discovery route test",
        )))
    });
    let (addr, server_task) = start_embedded_server_with_state(0, state).await.unwrap();
    let port = addr.port();

    let prob_dir = env.root().join("UTF8_PROB");
    let tc1 = prob_dir.join("Test01");
    fs::create_dir_all(&tc1).unwrap();
    // "012345678901234567890123456789012" is 33 ASCII bytes; followed by 'đ' (2 bytes: C4 91) or 'ế' (3 bytes: E1 BA BF)
    // At index 33..36, 'ế' spans bytes 33, 34, 35! A 35-byte read slices 'ế' after 2 of its 3 bytes!
    let utf8_input = "012345678901234567890123456789012ế_tail\n";
    assert_eq!(&utf8_input.as_bytes()[33..36], "ế".as_bytes());
    fs::write(tc1.join("UTF8_PROB.inp"), utf8_input.as_bytes()).unwrap();
    fs::write(tc1.join("UTF8_PROB.out"), "ok\n").unwrap();

    let enc_prob = urlencode(&prob_dir.to_string_lossy());
    let (status, body) = http_request(
        port,
        "GET",
        &format!("/api/fetch-polygon-tests?path={enc_prob}&problem=UTF8_PROB"),
        None,
        None,
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let json_body: Value = serde_json::from_str(&body).unwrap();
    let preview = json_body["data"][0]["preview"].as_str().unwrap();
    assert!(
        !preview.contains('\u{FFFD}'),
        "preview must never contain UTF-8 replacement char U+FFFD: {preview}"
    );
    assert_eq!(
        preview, "012345678901234567890123456789012...",
        "preview must truncate cleanly at the last valid UTF-8 codepoint boundary within 35 bytes"
    );

    // Verify missing problem query parameter returns 400 PATH_REQUIRED
    let (missing_prob_status, missing_prob_body) = http_request(
        port,
        "GET",
        &format!("/api/fetch-polygon-tests?path={enc_prob}"),
        None,
        None,
    )
    .await;
    assert_eq!(missing_prob_status, 400);
    let missing_prob_json: Value = serde_json::from_str(&missing_prob_body).unwrap();
    assert_eq!(missing_prob_json["code"], "PATH_REQUIRED");

    // Verify NOT_A_DIRECTORY returns 400 when path points to a file
    let file_path = tc1.join("UTF8_PROB.inp");
    let enc_file = urlencode(&file_path.to_string_lossy());
    let (not_dir_status, not_dir_body) = http_request(
        port,
        "GET",
        &format!("/api/fetch-contestants?path={enc_file}"),
        None,
        None,
    )
    .await;
    assert_eq!(not_dir_status, 400);
    let not_dir_json: Value = serde_json::from_str(&not_dir_body).unwrap();
    assert_eq!(not_dir_json["code"], "NOT_A_DIRECTORY");

    // Verify POST /api/polygon-config without `compile` normalizes and persists default `compile` object
    let save_payload = json!({
        "path": prob_dir,
        "config": {
            "enableGroups": false,
            "tests": {},
            "groups": {}
        }
    })
    .to_string();
    let (post_status, _) = http_request(
        port,
        "POST",
        "/api/polygon-config",
        Some(save_payload.as_bytes()),
        Some("application/json"),
    )
    .await;
    assert_eq!(post_status, 200);

    let (get_status, get_body) = http_request(
        port,
        "GET",
        &format!("/api/polygon-config?path={enc_prob}"),
        None,
        None,
    )
    .await;
    assert_eq!(get_status, 200);
    let get_json: Value = serde_json::from_str(&get_body).unwrap();
    assert_eq!(
        get_json,
        json!({
            "success": true,
            "data": {
                "compile": {
                    "flags": {
                        "c": ["-std=c11", "-O2", "-pipe"],
                        "cpp": ["-std=c++14", "-O2", "-pipe"]
                    },
                    "profile": "themis",
                    "schemaVersion": 1
                },
                "enableGroups": false,
                "groups": {},
                "tests": {}
            }
        })
    );

    server_task.abort();
}

#[tokio::test]
async fn wp6_3_score_export_open_excel_wire_validation_and_isolated_temp_export_layout() {
    let env = common::OwnedTestEnvironment::new();
    let opened = Arc::new(Mutex::new(Vec::new()));
    let mut state = env.with_isolated_roots(|| {
        AppState::new(Arc::new(ExecutorClient::unavailable(
            "wp6.3 export route test",
        )))
    });
    state.workbook_opener = Arc::new(RecordingWorkbookOpener {
        opened: Arc::clone(&opened),
    });

    let (addr, server_task) = start_embedded_server_with_state(0, state).await.unwrap();
    let port = addr.port();

    const MAGIC: &[u8; 8] = b"JDXLSX01";
    const CONTENT_TYPE: &str = "application/vnd.judgedesk.score-export-v1";

    // 1. Wrong Content-Type -> 415
    let (status_ct, _) = http_request(
        port,
        "POST",
        "/api/open-excel",
        Some(b"JDXLSX01\x02\x00\x00\x00{}PK"),
        Some("application/octet-stream"),
    )
    .await;
    assert_eq!(status_ct, 415);

    // 2. Invalid diagnostic JSON -> 400
    let bad_diag = b"not-valid-json";
    let mut bad_json_payload = Vec::new();
    bad_json_payload.extend_from_slice(MAGIC);
    bad_json_payload.extend_from_slice(&(bad_diag.len() as u32).to_le_bytes());
    bad_json_payload.extend_from_slice(bad_diag);
    bad_json_payload.extend_from_slice(b"PK\x03\x04");
    let (status_bad_json, _) = http_request(
        port,
        "POST",
        "/api/open-excel",
        Some(&bad_json_payload),
        Some(CONTENT_TYPE),
    )
    .await;
    assert_eq!(status_bad_json, 400);

    // 3. Empty workbook bytes -> 400
    let valid_diag = br#"{"version":"1.5.5"}"#;
    let mut empty_wb_payload = Vec::new();
    empty_wb_payload.extend_from_slice(MAGIC);
    empty_wb_payload.extend_from_slice(&(valid_diag.len() as u32).to_le_bytes());
    empty_wb_payload.extend_from_slice(valid_diag);
    let (status_empty_wb, _) = http_request(
        port,
        "POST",
        "/api/open-excel",
        Some(&empty_wb_payload),
        Some(CONTENT_TYPE),
    )
    .await;
    assert_eq!(status_empty_wb, 400);

    // 4. Valid payload with default export_dir writes to <TEMP>/judgedesk/exports/<UUID>/{Book.xlsx,diagnostics.json}
    let mut valid_payload = empty_wb_payload.clone();
    valid_payload.extend_from_slice(b"PK\x03\x04\x14\x00\x06\x00");
    let (status_ok, ok_body) = env
        .with_isolated_roots(|| async {
            http_request(
                port,
                "POST",
                "/api/open-excel",
                Some(&valid_payload),
                Some(CONTENT_TYPE),
            )
            .await
        })
        .await;
    assert_eq!(status_ok, 200, "{ok_body}");
    let ok_json: Value = serde_json::from_str(&ok_body).unwrap();
    assert_eq!(ok_json["success"], true);
    let book_path_str = ok_json["path"].as_str().unwrap().replace('\\', "/");
    let diag_path_str = ok_json["diagnosticsPath"]
        .as_str()
        .unwrap()
        .replace('\\', "/");
    assert!(
        book_path_str.contains("/judgedesk/exports/") && book_path_str.ends_with("/Book.xlsx"),
        "unexpected book path: {book_path_str}"
    );
    assert!(
        diag_path_str.contains("/judgedesk/exports/")
            && diag_path_str.ends_with("/diagnostics.json"),
        "unexpected diagnostics path: {diag_path_str}"
    );
    assert!(Path::new(ok_json["path"].as_str().unwrap()).is_file());
    assert!(Path::new(ok_json["diagnosticsPath"].as_str().unwrap()).is_file());

    // Clean up exported UUID directory
    if let Some(parent) = Path::new(ok_json["path"].as_str().unwrap()).parent() {
        let _ = fs::remove_dir_all(parent);
    }

    server_task.abort();
}
