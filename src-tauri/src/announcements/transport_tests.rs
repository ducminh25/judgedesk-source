use super::transport::{client, fetch, Download, DownloadError};
use reqwest::header::HeaderMap;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
type TestResult = Result<(), Box<dyn std::error::Error>>;

pub(super) async fn server(response: Vec<u8>) -> TestResultServer {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}/feed", listener.local_addr()?);
    let task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await?;
        let mut input = [0; 8192];
        let _ = socket.read(&mut input).await?;
        socket.write_all(&response).await?;
        Ok::<_, std::io::Error>(())
    });
    Ok((url, task))
}
type TestResultServer =
    Result<(String, tokio::task::JoinHandle<std::io::Result<()>>), Box<dyn std::error::Error>>;

#[tokio::test]
async fn transport_enforces_status_encoding_and_streamed_caps() -> TestResult {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    for (reply, expected) in [
        ("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n", DownloadError::Status(404)),
        ("HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:9\r\nContent-Length: 0\r\n\r\n", DownloadError::Status(302)),
        ("HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: 0\r\n\r\n", DownloadError::Encoding),
        ("HTTP/1.1 200 OK\r\nContent-Length: 9\r\n\r\n123456789", DownloadError::Size),
        ("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\n12345\r\n4\r\n6789\r\n0\r\n\r\n", DownloadError::Size),
    ] {
        let (url, task) = server(reply.as_bytes().to_vec()).await?;
        assert_eq!(fetch(&client, &url, HeaderMap::new(), 8).await.err(), Some(expected));
        task.await??;
    }
    Ok(())
}

#[tokio::test]
async fn transport_preserves_304_and_validators_without_calling_it_empty_content() -> TestResult {
    let client = reqwest::Client::new();
    for status in ["200 OK", "304 Not Modified"] {
        let reply = format!("HTTP/1.1 {status}\r\nETag: \"hello\"\r\nLast-Modified: Wed, 21 Oct 2015 07:28:00 GMT\r\nContent-Length: 0\r\n\r\n");
        let (url, task) = server(reply.into_bytes()).await?;
        let result = fetch(&client, &url, HeaderMap::new(), 8).await?;
        match result {
            Download::Modified {
                bytes,
                etag,
                last_modified,
                ..
            } => {
                assert!(status.starts_with("200"));
                assert!(bytes.is_empty());
                assert_eq!(etag.as_deref(), Some("\"hello\""));
                assert!(last_modified.is_some());
            }
            Download::NotModified { etag, .. } => {
                assert!(status.starts_with("304"));
                assert_eq!(etag.as_deref(), Some("\"hello\""));
            }
        }
        task.await??;
    }
    Ok(())
}

#[tokio::test]
async fn production_client_refuses_plaintext_before_connecting() -> TestResult {
    let error = client()?
        .get("http://127.0.0.1:9/")
        .send()
        .await
        .err()
        .ok_or("plaintext accepted")?;
    assert!(error.is_builder());
    Ok(())
}
