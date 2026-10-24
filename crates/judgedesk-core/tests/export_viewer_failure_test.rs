mod common;

use judgedesk_core::executor_client::ExecutorClient;
use judgedesk_core::server::{start_embedded_server_with_state, AppState, WorkbookOpener};
use std::{path::Path, sync::Arc};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

struct BrokenViewer;
impl WorkbookOpener for BrokenViewer {
    fn open_workbook(&self, _: &Path) -> Result<(), String> {
        Err("viewer loader failed".into())
    }
}

#[tokio::test]
async fn saved_export_remains_retrievable_when_viewer_fails() {
    let env = common::OwnedTestEnvironment::new();
    let mut state = env.with_isolated_roots(|| {
        AppState::new(Arc::new(ExecutorClient::unavailable("export test")))
    });
    state.export_dir = Some(env.root().join("exports"));
    state.workbook_opener = Arc::new(BrokenViewer);
    let (address, task) = start_embedded_server_with_state(0, state)
        .await
        .expect("start server");
    let body = b"JDXLSX01\x02\x00\x00\x00{}PK-workbook";
    let mut stream = tokio::net::TcpStream::connect(address)
        .await
        .expect("connect");
    stream.write_all(format!("POST /api/open-excel HTTP/1.1\r\nHost: {address}\r\nContent-Type: application/vnd.judgedesk.score-export-v1\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).as_bytes()).await.expect("headers");
    stream.write_all(body).await.expect("body");
    let mut response = Vec::new();
    stream.read_to_end(&mut response).await.expect("response");
    let response = String::from_utf8(response).expect("utf8");
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    let json: serde_json::Value =
        serde_json::from_str(response.split_once("\r\n\r\n").expect("http body").1).expect("json");
    assert_eq!(json["saved"], true);
    assert_eq!(json["openStatus"], "failed");
    assert_eq!(
        std::fs::read(json["path"].as_str().expect("path")).expect("workbook"),
        b"PK-workbook"
    );
    assert_eq!(
        std::fs::read(json["diagnosticsPath"].as_str().expect("diagnostics")).expect("diagnostics"),
        b"{}"
    );
    task.abort();
}
