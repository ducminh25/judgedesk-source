use judgedesk_core::rational::{add_rational, compare_rational, Rational};
use judgedesk_core::scoring::{
    calculate_problem_summary, PolygonGroupConfig, PolygonScoringConfig, PolygonTestConfig,
    ProblemScoringConfig, TestCaseRun,
};
use judgedesk_core::toolchains::pch::{compare_parity_snapshots, ParitySnapshot};
use serde_json::json;
use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap};

#[test]
fn wp8_2_comparator_mutation_sensitivity_catches_all_dimensions() {
    let mut base_headers = BTreeMap::new();
    base_headers.insert("content-type".to_string(), "application/json".to_string());
    let mut base_artifacts = BTreeMap::new();
    base_artifacts.insert(
        "toolchain-execution-policy-v1.json".to_string(),
        r#"{"schemaVersion":1,"allowResourceOnlyLocalExecution":false}"#.to_string(),
    );

    let baseline = ParitySnapshot {
        status: 200,
        headers: base_headers,
        body: json!({
            "success": true,
            "verdict": "AC",
            "score": "3.33"
        }),
        stream_events: vec![
            json!({"type": "progress", "data": {"action": "progress.initializing", "percent": 0}}),
            json!({"type": "done", "data": {"success": true}}),
        ],
        workspace_artifacts: base_artifacts,
    };

    // Identical snapshots must pass
    let identical = compare_parity_snapshots(&baseline, &baseline);
    assert!(identical.passed, "identical snapshots must match");
    assert!(identical.mismatch_dimensions.is_empty());

    // 1. Mutate HTTP status
    let mut diff_status = baseline.clone();
    diff_status.status = 202;
    let res_status = compare_parity_snapshots(&baseline, &diff_status);
    assert!(!res_status.passed);
    assert!(res_status
        .mismatch_dimensions
        .contains(&"status".to_string()));

    // 2. Mutate HTTP headers
    let mut diff_headers = baseline.clone();
    diff_headers
        .headers
        .insert("content-type".to_string(), "text/plain".to_string());
    let res_headers = compare_parity_snapshots(&baseline, &diff_headers);
    assert!(!res_headers.passed);
    assert!(res_headers
        .mismatch_dimensions
        .contains(&"headers".to_string()));

    // 3. Mutate JSON body / verdict / rational score
    let mut diff_body = baseline.clone();
    diff_body.body = json!({
        "success": true,
        "verdict": "WA",
        "score": "3.34"
    });
    let res_body = compare_parity_snapshots(&baseline, &diff_body);
    assert!(!res_body.passed);
    assert!(res_body.mismatch_dimensions.contains(&"body".to_string()));

    // 4. Mutate stream events
    let mut diff_stream = baseline.clone();
    diff_stream.stream_events.pop();
    let res_stream = compare_parity_snapshots(&baseline, &diff_stream);
    assert!(!res_stream.passed);
    assert!(res_stream
        .mismatch_dimensions
        .contains(&"stream_events".to_string()));

    // 5. Mutate durable workspace artifacts
    let mut diff_artifacts = baseline.clone();
    diff_artifacts.workspace_artifacts.insert(
        "toolchain-execution-policy-v1.json".to_string(),
        r#"{"schemaVersion":1,"allowResourceOnlyLocalExecution":true}"#.to_string(),
    );
    let res_artifacts = compare_parity_snapshots(&baseline, &diff_artifacts);
    assert!(!res_artifacts.passed);
    assert!(res_artifacts
        .mismatch_dimensions
        .contains(&"workspace_artifacts".to_string()));
}

#[test]
fn wp8_2_rational_scoring_and_verdict_aggregation_parity_zero_float_drift() {
    // 3 testcases worth 10/3 each -> exact sum must be 10/1, never 9.999999999999998
    let third = Rational::new(10, 3);
    let sum = add_rational(add_rational(third.clone(), third.clone()), third.clone());
    assert_eq!(sum, Rational::from_integer(10));
    assert!(sum.is_integer());

    // Exact rational comparison: 10/3 == 20/6
    let twenty_sixths = Rational::new(20, 6);
    assert_eq!(compare_rational(&third, &twenty_sixths), Ordering::Equal);

    let mut groups = HashMap::new();
    groups.insert(
        "g1".to_string(),
        PolygonGroupConfig {
            dependencies: vec![],
            policy: Some("COMPLETE_GROUP".to_string()),
        },
    );
    groups.insert(
        "g2".to_string(),
        PolygonGroupConfig {
            dependencies: vec!["g1".to_string()],
            policy: Some("COMPLETE_GROUP".to_string()),
        },
    );

    let mut tests = HashMap::new();
    tests.insert(
        "1".to_string(),
        PolygonTestConfig {
            group: Some("g1".to_string()),
            points: Some(json!("10/3")),
        },
    );
    tests.insert(
        "2".to_string(),
        PolygonTestConfig {
            group: Some("g1".to_string()),
            points: Some(json!("10/3")),
        },
    );
    tests.insert(
        "3".to_string(),
        PolygonTestConfig {
            group: Some("g1".to_string()),
            points: Some(json!("10/3")),
        },
    );
    tests.insert(
        "4".to_string(),
        PolygonTestConfig {
            group: Some("g2".to_string()),
            points: Some(json!(20)),
        },
    );
    tests.insert(
        "5".to_string(),
        PolygonTestConfig {
            group: Some("g2".to_string()),
            points: Some(json!(20)),
        },
    );

    let config = ProblemScoringConfig {
        polygon_config: Some(PolygonScoringConfig {
            enable_groups: true,
            groups,
            tests,
        }),
        total_score: None,
        default_score: None,
        test_scores: None,
    };

    let mut runs = vec![
        TestCaseRun {
            name: "1".to_string(),
            status: "AC".to_string(),
            score: json!("10/3"),
            score_exact: Some(Rational::new(10, 3)),
            ..Default::default()
        },
        TestCaseRun {
            name: "2".to_string(),
            status: "AC".to_string(),
            score: json!("10/3"),
            score_exact: Some(Rational::new(10, 3)),
            ..Default::default()
        },
        TestCaseRun {
            name: "3".to_string(),
            status: "AC".to_string(),
            score: json!("10/3"),
            score_exact: Some(Rational::new(10, 3)),
            ..Default::default()
        },
        TestCaseRun {
            name: "4".to_string(),
            status: "AC".to_string(),
            score: json!(20),
            score_exact: Some(Rational::from_integer(20)),
            ..Default::default()
        },
        TestCaseRun {
            name: "5".to_string(),
            status: "WA".to_string(),
            score: json!(0),
            score_exact: Some(Rational::ZERO),
            ..Default::default()
        },
    ];
    let dirs = vec![
        "1".to_string(),
        "2".to_string(),
        "3".to_string(),
        "4".to_string(),
        "5".to_string(),
    ];

    let summary = calculate_problem_summary("OK", &mut runs, &dirs, &config);
    assert_eq!(summary.status, "PARTIAL");
    assert_eq!(summary.score_exact, Some(Rational::from_integer(10)));
    assert_eq!(summary.max_score_exact, Some(Rational::from_integer(50)));
}

mod common;

async fn raw_http_request(
    port: u16,
    method: &str,
    path: &str,
    body: Option<&[u8]>,
) -> (u16, String, String) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;

    let mut stream = TcpStream::connect(format!("127.0.0.1:{port}"))
        .await
        .expect("connect");
    let body_len = body.map(|b| b.len()).unwrap_or(0);
    let ct = if body.is_some() {
        "Content-Type: application/json\r\n"
    } else {
        ""
    };
    let req = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{ct}Content-Length: {body_len}\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(req.as_bytes()).await.expect("write req");
    if let Some(b) = body {
        stream.write_all(b).await.expect("write body");
    }
    let mut resp = Vec::new();
    stream.read_to_end(&mut resp).await.expect("read resp");
    let text = String::from_utf8_lossy(&resp).to_string();
    let status = text
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|c| c.parse::<u16>().ok())
        .unwrap_or(500);
    let (headers_part, body_part) = if let Some(pos) = text.find("\r\n\r\n") {
        (text[..pos].to_string(), text[pos + 4..].to_string())
    } else {
        (String::new(), text)
    };
    let decoded_body = if headers_part
        .to_ascii_lowercase()
        .contains("transfer-encoding: chunked")
    {
        let mut out = String::new();
        let mut rem = body_part.as_str();
        while let Some(pos) = rem.find("\r\n") {
            let size_hex = rem[..pos].trim();
            let Ok(size) = usize::from_str_radix(size_hex, 16) else {
                break;
            };
            if size == 0 {
                break;
            }
            let start = pos + 2;
            if start + size > rem.len() {
                break;
            }
            out.push_str(&rem[start..start + size]);
            rem = &rem[(start + size + 2).min(rem.len())..];
        }
        out
    } else {
        body_part
    };
    (status, headers_part, decoded_body)
}

#[tokio::test]
async fn wp8_1_wp8_3_live_rust_server_contract_routes_and_ndjson_stream_parity() {
    use judgedesk_core::server::{start_embedded_server_with_state, AppState};

    let test_environment = common::OwnedTestEnvironment::new();
    common::ensure_test_environment();
    let app_data_dir = test_environment.root().join("contract_appdata");
    std::fs::create_dir_all(&app_data_dir).expect("mkdir appdata");
    std::fs::write(
        app_data_dir.join("toolchain-distribution-state-v1.json"),
        r#"{"schemaVersion":1,"distribution":"development"}"#,
    )
    .expect("write dist state");
    std::fs::write(
        app_data_dir.join("toolchain-discovery-v2.json"),
        r#"{"schemaVersion":2,"status":"running","refreshing":false,"registryRevision":7,"startedAt":"2026-09-20T10:00:00.000Z","profiles":{}}"#,
    )
    .expect("write discovery state");
    std::fs::write(
        app_data_dir.join("toolchains.json"),
        r#"{"schemaVersion":2,"profiles":{"cpp-legacy-v1":{"mode":"managed"},"python3-v1":{"mode":"managed"},"c-gcc14":{"mode":"managed"},"pascal-fpc322":{"mode":"managed"}}}"#,
    )
    .expect("write toolchains.json");

    let mut state = test_environment.with_isolated_roots(AppState::default);
    state.set_app_data_dir(&app_data_dir);
    let (addr, server_task) = start_embedded_server_with_state(0, state)
        .await
        .expect("start server");
    let port = addr.port();

    // 1. GET /api/toolchains
    let (tc_status, _tc_headers, tc_body) =
        raw_http_request(port, "GET", "/api/toolchains", None).await;
    assert_eq!(tc_status, 200);
    let tc_json: serde_json::Value = serde_json::from_str(&tc_body).expect("json");
    assert_eq!(tc_json["registryRevision"], 7);
    assert_eq!(tc_json["manifestStatus"], "loading");
    assert_eq!(
        tc_json["profiles"].as_array().map(|a| a.len()).unwrap_or(0),
        6
    );

    // 2. POST /api/batch-judge/cancel (pre-registration)
    let (c_status, _c_headers, c_body) = raw_http_request(
        port,
        "POST",
        "/api/batch-judge/cancel",
        Some(br#"{"jobId":"job_pre_cancel_test"}"#),
    )
    .await;
    assert_eq!(c_status, 200);
    let cancel_json: serde_json::Value = serde_json::from_str(&c_body).expect("json");
    assert_eq!(cancel_json["success"], true);
    assert_eq!(cancel_json["pending"], true);

    // 3. POST /api/batch-judge NDJSON stream + X-JudgeDesk-Job-Id header
    let contestants_dir = test_environment.root().join("contestants");
    let problems_dir = test_environment.root().join("problems");
    std::fs::create_dir_all(&contestants_dir).expect("mkdir contestants");
    std::fs::create_dir_all(&problems_dir).expect("mkdir problems");
    let batch_body = serde_json::json!({
        "thisinhPath": contestants_dir.to_string_lossy(),
        "testPath": problems_dir.to_string_lossy(),
        "jobId": "contract_canonical_batch_judge_job"
    })
    .to_string();
    let (b_status, b_headers, b_body) = raw_http_request(
        port,
        "POST",
        "/api/batch-judge",
        Some(batch_body.as_bytes()),
    )
    .await;
    assert_eq!(b_status, 200);
    assert!(
        b_headers
            .to_ascii_lowercase()
            .contains("x-judgedesk-job-id: contract_canonical_batch_judge_job"),
        "missing X-JudgeDesk-Job-Id header: {b_headers}"
    );
    let events: Vec<serde_json::Value> = b_body
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| serde_json::from_str(l).expect("ndjson line"))
        .collect();
    assert_eq!(events.len(), 4);
    assert_eq!(events[0]["type"], "progress");
    assert_eq!(events[0]["data"]["action"], "progress.initializing");
    assert_eq!(events[1]["type"], "metadata");
    assert_eq!(events[2]["type"], "progress");
    assert_eq!(events[2]["data"]["action"], "progress.scanning");
    assert_eq!(events[3]["type"], "done");
    assert_eq!(events[3]["data"]["success"], true);

    server_task.abort();
}
