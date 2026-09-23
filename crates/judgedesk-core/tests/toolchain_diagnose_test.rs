use judgedesk_core::server::{start_embedded_server_with_state, AppState};
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

#[tokio::test]
async fn test_genuine_toolchain_diagnostics_all_languages() {
    let _test_environment = common::OwnedTestEnvironment::new();
    common::ensure_test_environment();
    let state = _test_environment.with_isolated_roots(AppState::default);
    assert!(state.platform.root().starts_with(_test_environment.root()));
    let (addr, _server_task) = start_embedded_server_with_state(0, state)
        .await
        .expect("Failed to start embedded server");
    let port = addr.port();

    // 1. C++
    println!("--- Testing C++ Diagnostic ---");
    let (_status, body) = http_request(
        port,
        "POST",
        "/api/toolchains/profiles/cpp/diagnose",
        None,
        None,
    )
    .await;
    let json: serde_json::Value = serde_json::from_str(&body).expect("Valid JSON for C++");
    assert_eq!(json["success"], true, "C++ diagnostic failed: {body}");
    let diag = &json["diagnostic"];
    assert_eq!(diag["success"], true);
    assert_eq!(diag["profileId"], "cpp");
    assert_eq!(diag["language"], "cpp");
    assert_eq!(diag["phase"], "execution");
    let cpp_compile = diag["compileTimeMs"].as_u64().expect("valid compileTimeMs");
    let cpp_exec = diag["executionTimeMs"]
        .as_u64()
        .expect("valid executionTimeMs");
    let cpp_mem = diag["peakMemoryKb"].as_u64().expect("valid peakMemoryKb");
    assert!(cpp_compile > 0, "C++ compileTimeMs must be > 0");
    assert!(cpp_exec > 0, "C++ executionTimeMs must be > 0");
    assert!(cpp_mem > 0, "C++ peakMemoryKb must be > 0");
    println!("C++ OK: compile={cpp_compile}ms, exec={cpp_exec}ms, mem={cpp_mem}KB");

    // 2. C
    println!("--- Testing C Diagnostic ---");
    let (_status, body) = http_request(
        port,
        "POST",
        "/api/toolchains/profiles/c/diagnose",
        None,
        None,
    )
    .await;
    let json: serde_json::Value = serde_json::from_str(&body).expect("Valid JSON for C");
    assert_eq!(json["success"], true, "C diagnostic failed: {body}");
    let diag = &json["diagnostic"];
    assert_eq!(diag["success"], true);
    assert_eq!(diag["profileId"], "c");
    assert_eq!(diag["language"], "c");
    assert_eq!(diag["phase"], "execution");
    let c_compile = diag["compileTimeMs"].as_u64().expect("valid compileTimeMs");
    let c_exec = diag["executionTimeMs"]
        .as_u64()
        .expect("valid executionTimeMs");
    let c_mem = diag["peakMemoryKb"].as_u64().expect("valid peakMemoryKb");
    assert!(c_compile > 0, "C compileTimeMs must be > 0");
    assert!(c_exec > 0, "C executionTimeMs must be > 0");
    assert!(c_mem > 0, "C peakMemoryKb must be > 0");
    println!("C OK: compile={c_compile}ms, exec={c_exec}ms, mem={c_mem}KB");

    // 3. Python
    println!("--- Testing Python Diagnostic ---");
    let (_status, body) = http_request(
        port,
        "POST",
        "/api/toolchains/profiles/python/diagnose",
        None,
        None,
    )
    .await;
    let json: serde_json::Value = serde_json::from_str(&body).expect("Valid JSON for Python");
    assert_eq!(json["success"], true, "Python diagnostic failed: {body}");
    let diag = &json["diagnostic"];
    assert_eq!(diag["success"], true);
    assert_eq!(diag["profileId"], "python");
    assert_eq!(diag["language"], "python");
    assert_eq!(diag["phase"], "execution");
    assert!(
        diag["compileTimeMs"].is_null(),
        "Python should not report compileTimeMs"
    );
    let py_exec = diag["executionTimeMs"]
        .as_u64()
        .expect("valid executionTimeMs");
    let py_mem = diag["peakMemoryKb"].as_u64().expect("valid peakMemoryKb");
    assert!(py_exec > 0, "Python executionTimeMs must be > 0");
    assert!(py_mem > 0, "Python peakMemoryKb must be > 0");
    println!("Python OK: exec={py_exec}ms, mem={py_mem}KB");

    // 4. Pascal
    println!("--- Testing Pascal Diagnostic ---");
    let (_status, body) = http_request(
        port,
        "POST",
        "/api/toolchains/profiles/pascal/diagnose",
        None,
        None,
    )
    .await;
    let json: serde_json::Value = serde_json::from_str(&body).expect("Valid JSON for Pascal");
    assert_eq!(json["success"], true, "Pascal diagnostic failed: {body}");
    let diag = &json["diagnostic"];
    assert_eq!(diag["success"], true);
    assert_eq!(diag["profileId"], "pascal");
    assert_eq!(diag["language"], "pascal");
    assert_eq!(diag["phase"], "execution");
    let pas_compile = diag["compileTimeMs"].as_u64().expect("valid compileTimeMs");
    let pas_exec = diag["executionTimeMs"]
        .as_u64()
        .expect("valid executionTimeMs");
    let pas_mem = diag["peakMemoryKb"].as_u64().expect("valid peakMemoryKb");
    assert!(pas_compile > 0, "Pascal compileTimeMs must be > 0");
    assert!(pas_exec > 0, "Pascal executionTimeMs must be > 0");
    assert!(pas_mem > 0, "Pascal peakMemoryKb must be > 0");
    println!("Pascal OK: compile={pas_compile}ms, exec={pas_exec}ms, mem={pas_mem}KB");

    // 5. Java
    println!("--- Testing Java Diagnostic ---");
    let (_status, body) = http_request(
        port,
        "POST",
        "/api/toolchains/profiles/java/diagnose",
        None,
        None,
    )
    .await;
    let json: serde_json::Value = serde_json::from_str(&body).expect("Valid JSON for Java");
    assert_eq!(json["success"], true, "Java diagnostic failed: {body}");
    let diag = &json["diagnostic"];
    assert_eq!(diag["success"], true);
    assert_eq!(diag["profileId"], "java");
    assert_eq!(diag["language"], "java");
    assert_eq!(diag["phase"], "execution");
    let java_compile = diag["compileTimeMs"].as_u64().expect("valid compileTimeMs");
    let java_exec = diag["executionTimeMs"]
        .as_u64()
        .expect("valid executionTimeMs");
    let java_mem = diag["peakMemoryKb"].as_u64().expect("valid peakMemoryKb");
    assert!(java_compile > 0, "Java compileTimeMs must be > 0");
    assert!(java_exec > 0, "Java executionTimeMs must be > 0");
    assert!(java_mem > 0, "Java peakMemoryKb must be > 0");
    println!("Java OK: compile={java_compile}ms, exec={java_exec}ms, mem={java_mem}KB");

    // 6. Scratch
    println!("--- Testing Scratch Diagnostic ---");
    let (_status, body) = http_request(
        port,
        "POST",
        "/api/toolchains/profiles/scratch/diagnose",
        None,
        None,
    )
    .await;
    let json: serde_json::Value = serde_json::from_str(&body).expect("Valid JSON for Scratch");
    assert_eq!(json["success"], true, "Scratch diagnostic failed: {body}");
    let diag = &json["diagnostic"];
    assert_eq!(diag["success"], true);
    assert_eq!(diag["profileId"], "scratch");
    assert_eq!(diag["language"], "scratch");
    assert_eq!(diag["phase"], "execution");
    assert!(
        diag["compileTimeMs"].is_null(),
        "Scratch should not report compileTimeMs"
    );
    let scr_exec = diag["executionTimeMs"]
        .as_u64()
        .expect("valid executionTimeMs");
    let scr_mem = diag["peakMemoryKb"].as_u64().expect("valid peakMemoryKb");
    assert!(scr_exec > 0, "Scratch executionTimeMs must be > 0");
    assert!(scr_mem > 0, "Scratch peakMemoryKb must be > 0");
    println!("Scratch OK: exec={scr_exec}ms, mem={scr_mem}KB");
}
