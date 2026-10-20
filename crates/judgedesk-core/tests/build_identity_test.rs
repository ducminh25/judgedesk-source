mod common;

use judgedesk_core::executor_client::ExecutorClient;
use judgedesk_core::server::{start_embedded_server_with_state, AppState};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[tokio::test]
async fn status_reports_application_build_identity() {
    let owned = common::OwnedTestEnvironment::new();
    let state = owned.with_isolated_roots(|| {
        AppState::new(Arc::new(ExecutorClient::unavailable("identity test")))
    });
    let (addr, handle) = start_embedded_server_with_state(0, state).await.unwrap();
    let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    stream
        .write_all(b"GET /api/status HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        .await
        .unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).await.unwrap();
    let body: serde_json::Value =
        serde_json::from_str(response.split("\r\n\r\n").nth(1).unwrap()).unwrap();
    let package: serde_json::Value =
        serde_json::from_str(include_str!("../../../package.json")).unwrap();
    let mut shutdown = tokio::net::TcpStream::connect(addr).await.unwrap();
    shutdown.write_all(b"POST /api/shutdown HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
    let mut drained = Vec::new();
    shutdown.read_to_end(&mut drained).await.unwrap();
    handle.await.unwrap();
    assert!(tokio::net::TcpStream::connect(addr).await.is_err());
    assert_eq!(body["build"]["appVersion"], package["version"]);
    assert_eq!(body["build"]["backend"], "rust");
    assert_eq!(
        body["build"]["buildMode"],
        judgedesk_core::build_metadata::BUILD_METADATA.build_mode
    );
    assert!(matches!(
        body["build"]["sourceState"].as_str(),
        Some("dirty" | "clean" | "dev")
    ));
    assert!(body["build"]["target"]
        .as_str()
        .unwrap()
        .contains(std::env::consts::ARCH));
    let mut features = Vec::new();
    if cfg!(feature = "default") {
        features.push("default");
    }
    if cfg!(feature = "test-server") {
        features.push("test-server");
    }
    assert_eq!(body["build"]["features"], serde_json::json!(features));
    assert_eq!(
        body["build"],
        serde_json::to_value(judgedesk_core::build_metadata::BUILD_METADATA).unwrap()
    );
}

#[tokio::test]
async fn judge_stream_uses_the_same_application_identity() {
    use judgedesk_core::engine::session::{
        run_judge_session, JudgeSessionConfig, JudgeStreamEvent,
    };
    let owned = common::OwnedTestEnvironment::new();
    let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
    run_judge_session(
        JudgeSessionConfig {
            thisinh_path: owned.root().join("empty-contestants"),
            test_path: owned.root().join("empty-problems"),
            job_id: "identity".into(),
            target_contestants: Vec::new(),
            target_problems: Vec::new(),
            cancel_flag: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            platform: Arc::new(ExecutorClient::unavailable("identity test")),
            problem_configs: std::collections::HashMap::new(),
            app_data_dir: None,
            toolchain_selections: std::collections::HashMap::new(),
        },
        sender,
    )
    .await;
    let Some(JudgeStreamEvent::Metadata(metadata)) = receiver.recv().await else {
        panic!("first event must contain metadata")
    };
    assert_eq!(
        metadata["build"],
        serde_json::to_value(judgedesk_core::build_metadata::BUILD_METADATA).unwrap()
    );
}
