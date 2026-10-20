mod common;

use std::sync::Arc;
use std::time::{Duration, Instant};

use judgedesk_core::discovery::normalize_problem_config;
use judgedesk_core::executor_client::ExecutorClient;
use judgedesk_core::server::{start_embedded_server_with_state, AppState, ServerLifecyclePhase};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

fn spawn_test_executor(env: &common::OwnedTestEnvironment) -> ExecutorClient {
    common::ensure_test_environment();
    let exe_path = common::executor_binary_path();
    env.with_isolated_roots(|| ExecutorClient::spawn_sync(&exe_path).expect("spawn test executor"))
}

fn decode_http_body(raw_body: &str) -> String {
    // Handle both chunked transfer-encoding and plain bodies
    let mut out = String::new();
    let mut rest = raw_body;
    let mut looks_chunked = false;
    if let Some((first_line, after_first)) = rest.split_once("\r\n") {
        if usize::from_str_radix(first_line.trim(), 16).is_ok()
            && !first_line.trim().starts_with('{')
        {
            looks_chunked = true;
            let _ = after_first;
        }
    }
    if !looks_chunked {
        return raw_body.to_string();
    }
    while let Some((len_line, remainder)) = rest.split_once("\r\n") {
        let Ok(chunk_len) = usize::from_str_radix(len_line.trim(), 16) else {
            break;
        };
        if chunk_len == 0 {
            break;
        }
        if remainder.len() < chunk_len {
            out.push_str(remainder);
            break;
        }
        out.push_str(&remainder[..chunk_len]);
        rest = &remainder[chunk_len..];
        if let Some(stripped) = rest.strip_prefix("\r\n") {
            rest = stripped;
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
        decode_http_body(&resp_str[pos + 4..])
    } else {
        resp_str
    };

    (status_code, body_part)
}

#[test]
fn step4_problem_config_precedence_and_normalization() {
    // 1. Default config when neither stored nor request config is provided
    let def_cfg = normalize_problem_config("A_PLUS_B", None, None);
    assert_eq!(def_cfg.memory_limit_mb, 256);
    assert_eq!(def_cfg.time_limit_ms, 1000);
    assert!(!def_cfg.use_std_in);
    assert!(!def_cfg.use_std_out);
    assert_eq!(def_cfg.input_file, "A_PLUS_B.inp");
    assert_eq!(def_cfg.output_file, "A_PLUS_B.out");
    assert_eq!(def_cfg.checker_type, "C1");

    // 2. Request config overrides defaults, and clamps memoryLimit to [8, 1024]
    let req_json = json!({
        "useStdIO": true,
        "memoryLimit": 4096,
        "defaultScore": 5,
        "checkerType": "C4",
        "polygonConfig": {
            "enableGroups": false,
            "tests": {
                "Test01": { "points": 10, "timeLimit": 0.25 }
            },
            "groups": {}
        }
    });
    let req_cfg = normalize_problem_config("A_PLUS_B", Some(&req_json), None);
    assert_eq!(req_cfg.memory_limit_mb, 1024);
    assert!(req_cfg.use_std_in);
    assert!(req_cfg.use_std_out);
    assert_eq!(req_cfg.input_file_for_execution(), "");
    assert_eq!(req_cfg.output_file_for_execution(), "");
    assert_eq!(req_cfg.checker_type, "C4");
    assert_eq!(req_cfg.test_time_limit_ms("Test01"), 250);
    assert_eq!(req_cfg.test_time_limit_ms("Test02"), 1000);

    // 3. Stored config on disk overrides request config, and clamps low memoryLimit to 8 MB
    let stored_json = json!({
        "useStdIO": false,
        "inputFile": "custom.in",
        "outputFile": "custom.out",
        "memoryLimit": 2,
        "checkerType": "C2",
        "isInteractive": true,
        "interactor": "interactor.py"
    });
    let merged_cfg = normalize_problem_config("A_PLUS_B", Some(&req_json), Some(&stored_json));
    assert_eq!(merged_cfg.memory_limit_mb, 8);
    assert!(merged_cfg.is_interactive);
    assert_eq!(merged_cfg.interactor, "interactor.py");
    // Interactive problems force stdio even if stored useStdIO is false
    assert!(merged_cfg.use_std_in);
    assert!(merged_cfg.use_std_out);
    assert_eq!(merged_cfg.input_file_for_execution(), "");
    assert_eq!(merged_cfg.output_file_for_execution(), "");
    assert_eq!(merged_cfg.checker_type, "C2");
}

#[tokio::test]
async fn step4_job_registry_admission_and_instant_cancel_kills_infinite_loop() {
    let env = common::OwnedTestEnvironment::new();
    let client = spawn_test_executor(&env);
    let mut state = env.with_isolated_roots(|| AppState::new(Arc::new(client)));
    let app_data_dir = env.root().join("appdata");
    std::fs::create_dir_all(&app_data_dir).unwrap();
    state.set_app_data_dir(&app_data_dir);
    let (addr, _handle) = start_embedded_server_with_state(0, state.clone())
        .await
        .unwrap();
    let port = addr.port();

    // 1. Cancel-before-register tombstone: cancelling "job-pre-cancelled" before starting it
    // must reject a subsequent /api/batch-judge with JUDGE_CANCELLED.
    let cancel_payload = json!({ "jobId": "job-pre-cancelled" }).to_string();
    let (cancel_status, _) = http_request(
        port,
        "POST",
        "/api/batch-judge/cancel",
        Some(cancel_payload.as_bytes()),
        Some("application/json"),
    )
    .await;
    assert_eq!(cancel_status, 200);

    let ts_dir = env.root().join("thisinh");
    let test_dir = env.root().join("tests");
    std::fs::create_dir_all(&ts_dir).unwrap();
    std::fs::create_dir_all(&test_dir).unwrap();

    let pre_judge_payload = json!({
        "thisinhPath": ts_dir,
        "testPath": test_dir,
        "jobId": "job-pre-cancelled",
        "targetContestants": ["Alice"],
        "targetProblems": ["LOOP"]
    })
    .to_string();
    let (_, pre_text) = http_request(
        port,
        "POST",
        "/api/batch-judge",
        Some(pre_judge_payload.as_bytes()),
        Some("application/json"),
    )
    .await;
    assert!(
        pre_text.contains("JUDGE_CANCELLED"),
        "Expected pre-cancelled tombstone to emit JUDGE_CANCELLED, got: {pre_text}"
    );

    // 2. Setup an infinite-loop C++ submission with a 10-second time limit via request.problemConfigs
    let alice_dir = ts_dir.join("Alice");
    std::fs::create_dir_all(&alice_dir).unwrap();
    std::fs::write(
        alice_dir.join("LOOP.cpp"),
        "#include <bits/stdc++.h>\nusing namespace std;\nint main() { volatile unsigned long long x = 0; while (true) { ++x; } return 0; }\n",
    )
    .unwrap();

    let loop_prob_dir = test_dir.join("LOOP").join("Test01");
    std::fs::create_dir_all(&loop_prob_dir).unwrap();
    std::fs::write(loop_prob_dir.join("LOOP.inp"), "1\n").unwrap();
    std::fs::write(loop_prob_dir.join("LOOP.out"), "1\n").unwrap();

    let state_for_cancel = state.clone();
    let cancel_trigger = tokio::spawn(async move {
        // Wait until the infinite loop test execution (exec_*) is actively running in native-executor
        let deadline = Instant::now() + Duration::from_secs(12);
        while Instant::now() < deadline {
            if state_for_cancel
                .active_executor_run_ids()
                .iter()
                .any(|id| id.starts_with("exec_"))
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        assert!(
            state_for_cancel
                .active_executor_run_ids()
                .iter()
                .any(|id| id.starts_with("exec_")),
            "Expected active executor run (exec_*) for LOOP test case"
        );
        let cancel_started = Instant::now();
        let body = json!({ "jobId": "job-infinite-loop" }).to_string();
        let (st, _) = http_request(
            port,
            "POST",
            "/api/batch-judge/cancel",
            Some(body.as_bytes()),
            Some("application/json"),
        )
        .await;
        assert_eq!(st, 200);
        cancel_started
    });

    let judge_payload = json!({
        "thisinhPath": ts_dir,
        "testPath": test_dir,
        "jobId": "job-infinite-loop",
        "problemConfigs": {
            "LOOP": {
                "useStdIO": true,
                "polygonConfig": {
                    "enableGroups": false,
                    "tests": {
                        "Test01": { "points": 10, "timeLimit": 10.0 }
                    },
                    "groups": {}
                }
            }
        },
        "targetContestants": ["Alice"],
        "targetProblems": ["LOOP"]
    })
    .to_string();

    let (judge_status, stream_text) = http_request(
        port,
        "POST",
        "/api/batch-judge",
        Some(judge_payload.as_bytes()),
        Some("application/json"),
    )
    .await;
    assert_eq!(judge_status, 200);

    let cancel_started = cancel_trigger.await.unwrap();
    let cancel_to_stream_end = cancel_started.elapsed();
    assert!(
        cancel_to_stream_end < Duration::from_millis(1500),
        "Expected instant cancellation (<1500ms) instead of waiting for 10s TLE, took {:?}",
        cancel_to_stream_end
    );

    let events: Vec<Value> = stream_text
        .lines()
        .filter(|l| l.trim().starts_with('{'))
        .map(|l| serde_json::from_str::<Value>(l.trim()).unwrap())
        .collect();

    // Must emit exactly 1 terminal event (`error` or `done`, never both)
    let terminal_events: Vec<&Value> = events
        .iter()
        .filter(|ev| {
            let t = ev.get("type").and_then(|v| v.as_str()).unwrap_or("");
            t == "done" || t == "error"
        })
        .collect();
    assert_eq!(
        terminal_events.len(),
        1,
        "Expected exactly 1 terminal event on stream, got: {events:?}"
    );
    assert_eq!(
        terminal_events[0].get("type").and_then(|v| v.as_str()),
        Some("error")
    );
    let err_msg = terminal_events[0]
        .get("data")
        .and_then(|d| d.get("message"))
        .and_then(|m| m.as_str())
        .unwrap_or("");
    assert!(
        err_msg.contains("JUDGE_CANCELLED"),
        "Expected JUDGE_CANCELLED error event, got: {err_msg}"
    );
}

#[tokio::test]
async fn step4_server_lifecycle_4_phases_drain_and_metadata_python_export() {
    let env = common::OwnedTestEnvironment::new();
    let client = spawn_test_executor(&env);
    let mut state = env.with_isolated_roots(|| AppState::new(Arc::new(client)));
    let app_data_dir = env.root().join("appdata");
    std::fs::create_dir_all(&app_data_dir).unwrap();
    state.set_app_data_dir(&app_data_dir);
    assert_eq!(state.lifecycle_phase(), ServerLifecyclePhase::Running);

    let ts_dir = env.root().join("thisinh");
    let alice_dir = ts_dir.join("Alice");
    std::fs::create_dir_all(&alice_dir).unwrap();
    std::fs::write(
        alice_dir.join("ADD.cpp"),
        "#include <bits/stdc++.h>\nusing namespace std;\nint main() { int a, b; if (cin >> a >> b) cout << (a + b) << \"\\n\"; return 0; }\n",
    )
    .unwrap();

    let test_dir = env.root().join("tests");
    let add_dir = test_dir.join("ADD").join("Test01");
    std::fs::create_dir_all(&add_dir).unwrap();
    std::fs::write(add_dir.join("ADD.inp"), "19 23\n").unwrap();
    std::fs::write(add_dir.join("ADD.out"), "42\n").unwrap();

    let (addr, _handle) = start_embedded_server_with_state(0, state.clone())
        .await
        .unwrap();
    let port = addr.port();

    // Run a normal judge session with request.problemConfigs (useStdIO: true, defaultScore: 7)
    let judge_payload = json!({
        "thisinhPath": ts_dir,
        "testPath": test_dir,
        "jobId": "job-add-1",
        "problemConfigs": {
            "ADD": {
                "useStdIO": true,
                "defaultScore": 7
            }
        },
        "targetContestants": ["Alice"],
        "targetProblems": ["ADD"]
    })
    .to_string();

    let (judge_status, stream_text) = http_request(
        port,
        "POST",
        "/api/batch-judge",
        Some(judge_payload.as_bytes()),
        Some("application/json"),
    )
    .await;
    assert_eq!(judge_status, 200);

    let events: Vec<Value> = stream_text
        .lines()
        .filter(|l| l.trim().starts_with('{'))
        .map(|l| serde_json::from_str::<Value>(l.trim()).unwrap())
        .collect();

    // Check metadata includes toolchains.cpp and toolchains.python
    let meta_ev = events
        .iter()
        .find(|ev| ev.get("type").and_then(|v| v.as_str()) == Some("metadata"))
        .expect("Expected metadata event");
    let meta_data = meta_ev.get("data").unwrap();
    assert!(
        meta_data
            .get("toolchains")
            .and_then(|t| t.get("cpp"))
            .and_then(|c| c.get("source"))
            .is_some(),
        "Expected metadata.toolchains.cpp.source, got: {meta_data}"
    );
    assert!(
        meta_data
            .get("toolchains")
            .and_then(|t| t.get("python"))
            .and_then(|p| p.get("source"))
            .is_some(),
        "Expected metadata.toolchains.python.source, got: {meta_data}"
    );
    assert!(
        meta_data
            .get("toolchains")
            .and_then(|t| t.get("python"))
            .and_then(|p| p.get("checkerReady"))
            .is_some(),
        "Expected metadata.toolchains.python.checkerReady, got: {meta_data}"
    );

    // Check request.problemConfigs defaultScore=7 was honored
    let completed_ev = events
        .iter()
        .find(|ev| ev.get("type").and_then(|v| v.as_str()) == Some("problem_completed"))
        .expect("Expected problem_completed event");
    let summary_score = completed_ev
        .get("data")
        .and_then(|d| d.get("problemResult"))
        .and_then(|p| p.get("summary"))
        .and_then(|s| s.get("score"))
        .and_then(|v| v.as_f64());
    assert_eq!(summary_score, Some(7.0));

    // Now trigger /api/shutdown and verify lifecycle transitions to Stopped and rejects new jobs
    let (shutdown_status, _) = http_request(port, "POST", "/api/shutdown", None, None).await;
    assert_eq!(shutdown_status, 200);
    assert_eq!(state.lifecycle_phase(), ServerLifecyclePhase::Stopped);

    let post_payload = json!({
        "thisinhPath": ts_dir,
        "testPath": test_dir,
        "jobId": "job-after-shutdown",
        "targetContestants": ["Alice"],
        "targetProblems": ["ADD"]
    })
    .to_string();
    let (_, post_text) = http_request(
        port,
        "POST",
        "/api/batch-judge",
        Some(post_payload.as_bytes()),
        Some("application/json"),
    )
    .await;
    assert!(
        post_text.contains("SERVER_DRAINING"),
        "Expected SERVER_DRAINING after shutdown, got: {post_text}"
    );
}

#[test]
fn step4_wp41_compile_config_validation_presets_and_flag_guardrails() {
    use judgedesk_core::discovery::{
        create_compile_config, normalize_compile_config, parse_and_validate_custom_compile_flags,
        validate_custom_compile_flags,
    };

    // 1. Presets match Node shared/compile-config.ts
    let themis = create_compile_config("themis").expect("themis preset");
    assert_eq!(themis.schema_version, 1);
    assert_eq!(themis.profile, "themis");
    assert_eq!(themis.flags.cpp, vec!["-std=c++14", "-O2", "-pipe"]);
    assert_eq!(themis.flags.c, vec!["-std=c11", "-O2", "-pipe"]);

    let modern = create_compile_config("modern_ioi_icpc_2025").expect("modern preset");
    assert_eq!(modern.flags.cpp, vec!["-std=gnu++20", "-O2", "-pipe"]);
    assert_eq!(modern.flags.c, vec!["-std=gnu17", "-O2", "-pipe"]);

    let wf = create_compile_config("icpc_world_finals").expect("wf preset");
    assert_eq!(wf.flags.cpp, vec!["-std=gnu++20", "-O2", "-g"]);
    assert_eq!(wf.flags.c, vec!["-std=gnu11", "-O2", "-g"]);

    // 2. Custom flag tokenizer handles quotes and Unicode without shell evaluation
    let parsed = parse_and_validate_custom_compile_flags(
        r#"-std=gnu++20 -O3 "-DPROBLEM_NAME=Đề số 1" -DVALUE="a;b""#,
    )
    .expect("tokenize custom flags");
    assert_eq!(
        parsed,
        vec![
            "-std=gnu++20",
            "-O3",
            "-DPROBLEM_NAME=Đề số 1",
            "-DVALUE=a;b"
        ]
    );

    // 3. Forbidden flags rejected with INVALID_COMPILE_CONFIG
    for token in [
        "submission.cpp",
        "--",
        "-",
        "-o",
        "-oout.exe",
        "--output=out.exe",
        "-c",
        "-S",
        "-E",
        "-M",
        "-MMD",
        "-MFdeps.d",
        "-fsyntax-only",
        "-save-temps",
        "--serialize-diagnostics=diag",
        "-x",
        "-x=c++",
        "-include=evil.h",
        "-imacros=evil.h",
        "@flags.rsp",
        "-fplugin=C:/malicious.dll",
        "-fpass-plugin=pass.so",
        "-Xclang",
        "-mllvm",
        "-load=plugin.so",
        "-plugin=foo",
        "-B/custom/bin",
        "--sysroot=C:/other-toolchain",
        "-isysroot=/other/sdk",
        "--gcc-toolchain=/gcc",
        "-resource-dir=/res",
        "-specs=custom.spec",
        "-wrapper",
        "-fuse-ld=lld",
        "-stdlib=libc++",
        "-nostdinc",
        "-nostdlib",
        "-nodefaultlibs",
        "-Iother/include",
        "-Lother/lib",
        "-isystem/other",
        "-iquote/other",
        "-idirafter/other",
        "-F/Frameworks",
        "-iframework/Frameworks",
        "-static",
        "-s",
        "-lm",
        "-Wl,--stack,1",
        "-Xlinker",
        "-Wa,--noexecstack",
        "-Wp,-MD",
        "-Dbad\nflag",
    ] {
        let err = validate_custom_compile_flags(&json!([token]))
            .expect_err(&format!("token '{token}' must be rejected"));
        assert!(
            err.starts_with("INVALID_COMPILE_CONFIG:"),
            "Expected INVALID_COMPILE_CONFIG prefix for '{token}', got: {err}"
        );
    }

    // 4. Custom profile without flags must fail
    let missing_flags = normalize_compile_config(Some(&json!({
        "schemaVersion": 1,
        "profile": "custom"
    })))
    .expect_err("custom profile without flags must fail");
    assert!(missing_flags.contains("custom profile requires cpp and c flag arrays"));

    // 5. Stored compile snapshot overrides request preset without being regenerated
    let stored_snapshot = json!({
        "compile": {
            "schemaVersion": 1,
            "profile": "modern_ioi_icpc_2025",
            "flags": {
                "cpp": ["-std=gnu++20", "-O1"],
                "c": ["-std=gnu17", "-O1"]
            }
        }
    });
    let req_snapshot = json!({
        "compile": {
            "schemaVersion": 1,
            "profile": "icpc_world_finals"
        }
    });
    let norm = normalize_problem_config("SUM", Some(&req_snapshot), Some(&stored_snapshot));
    assert_eq!(norm.compile.profile, "modern_ioi_icpc_2025");
    assert_eq!(norm.compile.flags.cpp, vec!["-std=gnu++20", "-O1"]);
    assert_eq!(norm.compile.flags.c, vec!["-std=gnu17", "-O1"]);
}

#[tokio::test]
async fn step4_wp41_polygon_config_route_validates_and_wires_compile_flags_into_batch_judge() {
    let env = common::OwnedTestEnvironment::new();
    let client = spawn_test_executor(&env);
    let mut state = env.with_isolated_roots(|| AppState::new(Arc::new(client)));
    let app_data_dir = env.root().join("appdata");
    std::fs::create_dir_all(&app_data_dir).unwrap();
    state.set_app_data_dir(&app_data_dir);

    let (addr, _handle) = start_embedded_server_with_state(0, state).await.unwrap();
    let port = addr.port();

    let test_dir = env.root().join("tests");
    let prob_dir = test_dir.join("MACRO_ADD");
    let tc_dir = prob_dir.join("Test01");
    std::fs::create_dir_all(&tc_dir).unwrap();
    std::fs::write(tc_dir.join("MACRO_ADD.inp"), "3 4\n").unwrap();
    std::fs::write(tc_dir.join("MACRO_ADD.out"), "70\n").unwrap();

    // 1. POST /api/polygon-config with forbidden flag -> 400 INVALID_COMPILE_CONFIG and no file written
    let bad_save = json!({
        "path": prob_dir,
        "config": {
            "useStdIO": true,
            "compile": {
                "schemaVersion": 1,
                "profile": "custom",
                "flags": {
                    "cpp": ["-std=gnu++20", "-fplugin=evil.dll"],
                    "c": ["-std=gnu17"]
                }
            }
        }
    })
    .to_string();
    let (bad_status, bad_body) = http_request(
        port,
        "POST",
        "/api/polygon-config",
        Some(bad_save.as_bytes()),
        Some("application/json"),
    )
    .await;
    assert_eq!(
        bad_status, 400,
        "Invalid compile config must return 400: {bad_body}"
    );
    let bad_json: Value = serde_json::from_str(&bad_body).unwrap();
    assert_eq!(bad_json["code"], "INVALID_COMPILE_CONFIG");
    assert!(!prob_dir.join("Config.cfg").exists());

    // 2. POST /api/polygon-config with custom macro flag -DCUSTOM_SCALE=10 persists normalized compile snapshot
    let good_save = json!({
        "path": prob_dir,
        "config": {
            "useStdIO": true,
            "defaultScore": 10,
            "compile": {
                "schemaVersion": 1,
                "profile": "custom",
                "flags": {
                    "cpp": ["-std=gnu++20", "-O2", "-DCUSTOM_SCALE=10"],
                    "c": ["-std=gnu17", "-O2"]
                }
            }
        }
    })
    .to_string();
    let (good_status, good_body) = http_request(
        port,
        "POST",
        "/api/polygon-config",
        Some(good_save.as_bytes()),
        Some("application/json"),
    )
    .await;
    assert_eq!(good_status, 200, "Valid save failed: {good_body}");

    let (get_status, get_body) = http_request(
        port,
        "GET",
        &format!("/api/polygon-config?path={}", prob_dir.to_string_lossy()),
        None,
        None,
    )
    .await;
    assert_eq!(get_status, 200);
    let get_json: Value = serde_json::from_str(&get_body).unwrap();
    assert_eq!(get_json["data"]["compile"]["profile"], "custom");
    assert_eq!(
        get_json["data"]["compile"]["flags"]["cpp"],
        json!(["-std=gnu++20", "-O2", "-DCUSTOM_SCALE=10"])
    );

    // 3. Submission relies on CUSTOM_SCALE macro defined in compile.flags.cpp
    let ts_dir = env.root().join("thisinh");
    let alice_dir = ts_dir.join("Alice");
    std::fs::create_dir_all(&alice_dir).unwrap();
    std::fs::write(
        alice_dir.join("MACRO_ADD.cpp"),
        "#include <iostream>\nint main() { int a, b; if (std::cin >> a >> b) std::cout << (a + b) * CUSTOM_SCALE << \"\\n\"; return 0; }\n",
    )
    .unwrap();

    let judge_payload = json!({
        "thisinhPath": ts_dir,
        "testPath": test_dir,
        "targetContestants": ["Alice"],
        "targetProblems": ["MACRO_ADD"]
    })
    .to_string();
    let (judge_status, stream_text) = http_request(
        port,
        "POST",
        "/api/batch-judge",
        Some(judge_payload.as_bytes()),
        Some("application/json"),
    )
    .await;
    assert_eq!(judge_status, 200);

    let events: Vec<Value> = stream_text
        .lines()
        .filter(|l| l.trim().starts_with('{'))
        .map(|l| serde_json::from_str::<Value>(l.trim()).unwrap())
        .collect();
    let completed = events
        .iter()
        .find(|ev| ev["type"] == "problem_completed")
        .expect("problem_completed event");
    assert_eq!(
        completed["data"]["problemResult"]["compileStatus"], "OK",
        "Expected compileStatus OK with custom macro flag, got: {completed}"
    );
    assert_eq!(
        completed["data"]["problemResult"]["summary"]["status"],
        "AC"
    );
    assert_eq!(
        completed["data"]["problemResult"]["summary"]["score"],
        json!(10.0)
    );
}

#[tokio::test]
async fn step4_per_job_cancel_isolation_job_id_header_and_is_text_file_guard() {
    use judgedesk_core::discovery::test_wellformed::is_text_file;
    use judgedesk_core::server::state::JobAdmissionResult;
    use std::sync::atomic::Ordering;

    let env = common::OwnedTestEnvironment::new();

    // 1. Direct is_text_file unit check
    let text_file = env.root().join("valid.inp");
    let bin_file = env.root().join("binary.inp");
    std::fs::write(&text_file, "10 20\n").unwrap();
    std::fs::write(&bin_file, b"10\x0020\n").unwrap();
    assert!(is_text_file(&text_file));
    assert!(!is_text_file(&bin_file));

    let client = spawn_test_executor(&env);
    let mut state = env.with_isolated_roots(|| AppState::new(Arc::new(client)));
    let app_data_dir = env.root().join("appdata");
    std::fs::create_dir_all(&app_data_dir).unwrap();
    state.set_app_data_dir(&app_data_dir);

    // 2. Per-jobId cancellation isolation: cancelling an unknown jobId must NOT cancel a different active jobId
    let active_lease = match state.admit_judge_job(Some("job-active-1")) {
        JobAdmissionResult::Admitted(lease) => lease,
        JobAdmissionResult::Rejected { message, .. } => panic!("Expected admission: {message}"),
    };
    let cancelled_unrelated = state.cancel_judge_job(Some("job-unrelated-2"));
    assert_eq!(
        cancelled_unrelated, 0,
        "Cancelling unknown jobId must only record tombstone and not cancel active runs"
    );
    assert!(
        !active_lease.cancel_flag().load(Ordering::SeqCst),
        "Active job must not be cancelled when an unrelated jobId is cancelled"
    );
    drop(active_lease);

    let (addr, _handle) = start_embedded_server_with_state(0, state).await.unwrap();
    let port = addr.port();

    // 3. Invalid jobId (>256 chars or control chars) returns 400 on /api/batch-judge and /api/batch-judge/cancel
    let overlong_id = "j".repeat(257);
    let bad_judge = json!({
        "thisinhPath": env.root(),
        "testPath": env.root(),
        "jobId": overlong_id,
        "targetContestants": [],
        "targetProblems": []
    })
    .to_string();
    let (bad_judge_status, bad_judge_body) = http_request(
        port,
        "POST",
        "/api/batch-judge",
        Some(bad_judge.as_bytes()),
        Some("application/json"),
    )
    .await;
    assert_eq!(
        bad_judge_status, 400,
        "Expected 400 on >256 char jobId, got {bad_judge_status}: {bad_judge_body}"
    );

    let bad_cancel = json!({ "jobId": "bad\njob" }).to_string();
    let (bad_cancel_status, _) = http_request(
        port,
        "POST",
        "/api/batch-judge/cancel",
        Some(bad_cancel.as_bytes()),
        Some("application/json"),
    )
    .await;
    assert_eq!(
        bad_cancel_status, 400,
        "Expected 400 on control-char jobId in cancel"
    );

    // 4. Binary input file (with NUL byte) when testWellFormed=false produces compileStatus="JE"
    // without compiling student submission, and response includes X-JudgeDesk-Job-Id header
    let ts_dir = env.root().join("thisinh_bin");
    let alice_dir = ts_dir.join("Alice");
    std::fs::create_dir_all(&alice_dir).unwrap();
    // Even if student code would fail to compile (CE), unreadable input file must short-circuit with JE before compilation!
    std::fs::write(alice_dir.join("BINPROB.cpp"), "THIS IS NOT VALID C++").unwrap();

    let test_dir = env.root().join("tests_bin");
    let tc_dir = test_dir.join("BINPROB").join("Test01");
    std::fs::create_dir_all(&tc_dir).unwrap();
    std::fs::write(tc_dir.join("BINPROB.inp"), b"123\x00456\n").unwrap();
    std::fs::write(tc_dir.join("BINPROB.out"), "123\n").unwrap();

    let payload = json!({
        "thisinhPath": ts_dir,
        "testPath": test_dir,
        "jobId": "job-bin-check-42",
        "targetContestants": ["Alice"],
        "targetProblems": ["BINPROB"]
    })
    .to_string();

    let mut stream = TcpStream::connect(format!("127.0.0.1:{port}"))
        .await
        .unwrap();
    let req = format!(
        "POST /api/batch-judge HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        payload.len(),
        payload
    );
    stream.write_all(req.as_bytes()).await.unwrap();
    let mut raw_resp = Vec::new();
    stream.read_to_end(&mut raw_resp).await.unwrap();
    let raw_str = String::from_utf8_lossy(&raw_resp).to_string();
    let (headers_part, body_raw) = raw_str.split_once("\r\n\r\n").expect("HTTP headers");
    assert!(
        headers_part
            .to_ascii_lowercase()
            .contains("x-judgedesk-job-id: job-bin-check-42"),
        "Expected X-JudgeDesk-Job-Id header, got headers:\n{headers_part}"
    );
    let body_decoded = decode_http_body(body_raw);
    let events: Vec<Value> = body_decoded
        .lines()
        .filter(|l| l.trim().starts_with('{'))
        .map(|l| serde_json::from_str::<Value>(l.trim()).unwrap())
        .collect();
    let completed = events
        .iter()
        .find(|ev| ev["type"] == "problem_completed")
        .expect("problem_completed for BINPROB");
    let prob_res = &completed["data"]["problemResult"];
    assert_eq!(prob_res["compileStatus"], "JE");
    let compile_err = prob_res["compileError"].as_str().unwrap_or("");
    assert!(
        compile_err.contains("Unreadable input file: BINPROB.inp. Only text files are allowed."),
        "Expected unreadable input file JE message, got: {compile_err}"
    );
    assert_eq!(prob_res["summary"]["status"], "JE");
    assert_eq!(prob_res["summary"]["score"], json!(0.0));
}
