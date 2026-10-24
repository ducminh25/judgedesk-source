use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use ring::signature::KeyPair;
use std::{collections::BTreeMap, fs, path::PathBuf, sync::Arc};

type TestResult = Result<(), Box<dyn std::error::Error>>;
const UID: &str = "12345678-1234-4234-8234-123456789abc";
const OTHER: &str = "87654321-1234-4234-8234-123456789abc";
const NOW: &str = "2026-10-24T00:00:00.000Z";

#[tokio::test]
async fn a_304_corrupt_blob_is_not_reinterpreted_as_a_missing_cache_retry() -> TestResult {
    let f = Fixture::new()?;
    let store = Arc::new(f.open()?);
    let feed = store
        .accept_envelope(&f.sign(&f.payload(1)?)?, f.meta())?
        .feed
        .ok_or("feed")?;
    let path = f
        .root
        .join("announcements/feeds")
        .join(format!("{}.json", feed.payload_hash()));
    fs::write(&path, b"tampered")?;
    let (endpoint, server) = super::transport_tests::server(
        b"HTTP/1.1 304 Not Modified\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(),
    )
    .await?;
    let runtime = super::service::Runtime::new(
        store,
        reqwest::Client::new(),
        endpoint,
        "https://example.invalid/media/".into(),
    );
    assert_eq!(runtime.refresh().await.err().as_deref(), Some("cache"));
    server.await??;
    assert_eq!(fs::read(path)?, b"tampered");
    Ok(())
}

#[tokio::test]
async fn closing_an_article_cancels_its_inflight_image_download() -> TestResult {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let f = Fixture::new()?;
    let store = Arc::new(f.open()?);
    let png = include_bytes!("../../../shared/test-fixtures/announcements/publisher-photo.png");
    let mut payload = f.payload(1)?;
    payload["items"][0]["images"] = serde_json::json!([{ "id":"photo", "sha256":super::store_state::hash(png), "sizeBytes":png.len(), "mime":"image/png", "extension":"png", "role":"article" }]);
    let hash = store
        .accept_envelope(&f.sign(&payload)?, f.meta())?
        .feed
        .ok_or("feed")?
        .payload_hash()
        .to_owned();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let prefix = format!("http://{}/media/", listener.local_addr()?);
    let (started, wait_started) = tokio::sync::oneshot::channel();
    let (release, wait_release) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await?;
        let mut request = [0; 8192];
        let _ = socket.read(&mut request).await?;
        socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", png.len()).as_bytes()).await?;
        let _ = started.send(());
        let _ = wait_release.await;
        Ok::<_, std::io::Error>(())
    });
    let runtime = Arc::new(super::service::Runtime::new(
        store,
        reqwest::Client::new(),
        "https://example.invalid/feed".into(),
        prefix,
    ));
    let article = runtime.open_article(UID, &hash)?;
    let id = article.view_id.clone();
    let task_runtime = runtime.clone();
    let image = tokio::spawn(async move { task_runtime.image(&id, "photo").await });
    tokio::time::timeout(std::time::Duration::from_secs(5), wait_started).await??;
    runtime.close_article(&article.view_id)?;
    let response = tokio::time::timeout(std::time::Duration::from_secs(2), image).await;
    assert!(
        response.is_ok(),
        "closed article left its network task waiting for a response body"
    );
    assert_eq!(response??.err().as_deref(), Some("viewClosed"));
    let _ = release.send(());
    server.await??;
    Ok(())
}

#[tokio::test]
async fn service_coalesces_refresh_and_retains_uid_state_when_network_fails() -> TestResult {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let f = Fixture::new()?;
    let store = Arc::new(f.open()?);
    store.accept_envelope(&f.sign(&f.payload(1)?)?, f.meta())?;
    store.delete(UID)?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let endpoint = format!("http://{}/feed", listener.local_addr()?);
    let raw = f.sign(&f.payload(2)?)?;
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await?;
        let mut request = [0; 8192];
        let count = socket.read(&mut request).await?;
        assert!(String::from_utf8_lossy(&request[..count])
            .to_lowercase()
            .contains("if-none-match: \"feed-1\""));
        socket
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nETag: \"feed-2\"\r\n\r\n",
                    raw.len()
                )
                .as_bytes(),
            )
            .await?;
        socket.write_all(&raw).await?;
        Ok::<_, std::io::Error>(())
    });
    let runtime = super::service::Runtime::new(
        store.clone(),
        reqwest::Client::new(),
        endpoint,
        "https://example.invalid/media/".into(),
    );
    let (one, two) = tokio::join!(
        runtime.refresh_for(super::service::RefreshReason::Session),
        runtime.refresh_for(super::service::RefreshReason::Session)
    );
    assert_eq!(one?.local_revision, two?.local_revision);
    server.await??;
    assert!(runtime
        .refresh_for(super::service::RefreshReason::Session)
        .await
        .is_ok());
    assert!(store.snapshot()?.statuses[UID].deleted);
    assert_eq!(store.snapshot()?.feed.ok_or("feed")?.payload().sequence, 2);
    assert!(runtime.refresh().await.is_err());
    assert!(store.snapshot()?.statuses[UID].deleted);
    runtime.stop();
    assert!(runtime.refresh().await.is_err());
    Ok(())
}

#[tokio::test]
async fn service_304_missing_blob_retries_once_without_conditionals() -> TestResult {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let f = Fixture::new()?;
    let store = Arc::new(f.open()?);
    let raw = f.sign(&f.payload(1)?)?;
    let feed = store.accept_envelope(&raw, f.meta())?.feed.ok_or("feed")?;
    fs::remove_file(
        f.root
            .join("announcements/feeds")
            .join(format!("{}.json", feed.payload_hash())),
    )?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let endpoint = format!("http://{}/feed", listener.local_addr()?);
    let server = tokio::spawn(async move {
        for attempt in 0..2 {
            let (mut socket, _) = listener.accept().await?;
            let mut request = [0; 8192];
            let count = socket.read(&mut request).await?;
            assert_eq!(
                String::from_utf8_lossy(&request[..count])
                    .to_lowercase()
                    .contains("if-none-match:"),
                attempt == 0
            );
            if attempt == 0 {
                socket
                    .write_all(b"HTTP/1.1 304 Not Modified\r\nConnection: close\r\n\r\n")
                    .await?;
            } else {
                socket
                    .write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            raw.len()
                        )
                        .as_bytes(),
                    )
                    .await?;
                socket.write_all(&raw).await?;
            }
        }
        Ok::<_, std::io::Error>(())
    });
    let runtime = super::service::Runtime::new(
        store.clone(),
        reqwest::Client::new(),
        endpoint,
        "https://example.invalid/media/".into(),
    );
    runtime.refresh().await?;
    server.await??;
    assert!(store.revalidate_cached(f.meta()).is_ok());
    Ok(())
}

struct Fixture {
    root: PathBuf,
    key: ring::signature::Ed25519KeyPair,
}

#[test]
fn media_lru_budget_includes_replacement_bytes_and_preserves_pins_and_uid_state() -> TestResult {
    use std::collections::HashSet;
    let f = Fixture::new()?;
    let store = f.open()?;
    store.accept_envelope(&f.sign(&f.payload(1)?)?, f.meta())?;
    store.delete(UID)?;
    let state = fs::read(f.state_path())?;
    let mut oldest = String::new();
    for index in 0..32_u8 {
        let bytes = vec![index; 4 * 1024 * 1024];
        let digest = super::store_state::hash(&bytes);
        if index == 0 {
            oldest = digest.clone();
        }
        let image = AnnouncementImage {
            id: "cache-test".into(),
            sha256: digest.clone(),
            size_bytes: bytes.len() as u64,
            mime: "image/png".into(),
            extension: "png".into(),
            role: "article".into(),
        };
        store.save_media(&image, &bytes, &HashSet::new())?;
        fs::File::options()
            .write(true)
            .open(
                f.root
                    .join("announcements/media")
                    .join(format!("{digest}.png")),
            )?
            .set_modified(
                std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(index.into()),
            )?;
    }
    let bytes = vec![33; 4 * 1024 * 1024];
    let digest = super::store_state::hash(&bytes);
    // Simulate a truncated pre-existing cache leaf; saving authenticated replacement
    // bytes must still count their final size, not the old damaged file's size.
    fs::write(
        f.root
            .join("announcements/media")
            .join(format!("{digest}.png")),
        [],
    )?;
    let image = AnnouncementImage {
        id: "cache-test".into(),
        sha256: digest.clone(),
        size_bytes: bytes.len() as u64,
        mime: "image/png".into(),
        extension: "png".into(),
        role: "article".into(),
    };
    store.save_media(&image, &bytes, &HashSet::from([oldest.clone()]))?;
    let size = fs::read_dir(f.root.join("announcements/media"))?
        .try_fold(0_u64, |sum, entry| {
            Ok::<_, std::io::Error>(sum + entry?.metadata()?.len())
        })?;
    assert!(
        size <= 128 * 1024 * 1024,
        "media cache grew to {size} bytes"
    );
    assert!(f
        .root
        .join("announcements/media")
        .join(format!("{oldest}.png"))
        .exists());
    assert_eq!(store.cached_media(&image)?.ok_or("image")?, bytes);
    assert_eq!(fs::read(f.state_path())?, state);
    Ok(())
}

#[test]
fn restart_cleans_only_owned_write_temps_after_obtaining_the_process_lease() -> TestResult {
    let f = Fixture::new()?;
    let store = f.open()?;
    store.accept_envelope(&f.sign(&f.payload(1)?)?, f.meta())?;
    store.delete(UID)?;
    drop(store);
    let mut paths = Vec::new();
    for directory in [
        "announcements",
        "announcements/feeds",
        "announcements/media",
    ] {
        let file = f
            .root
            .join(directory)
            .join(format!(".write-{}.tmp", "a".repeat(32)));
        fs::write(&file, b"uncommitted bytes")?;
        paths.push(file);
    }
    let unrelated = f.root.join("announcements/user-evidence.txt");
    fs::write(&unrelated, b"keep")?;
    let reopened = f.open()?;
    assert!(reopened.snapshot()?.statuses[UID].deleted);
    for path in paths {
        assert!(!path.exists());
    }
    assert_eq!(fs::read(unrelated)?, b"keep");
    Ok(())
}
impl Fixture {
    fn new() -> Result<Self, Box<dyn std::error::Error>> {
        let mut nonce = [0; 16];
        getrandom::fill(&mut nonce).map_err(|_| "nonce")?;
        let root = std::env::temp_dir().join(format!("judgedesk-announcements-{nonce:02x?}"));
        fs::create_dir(&root)?;
        let bytes =
            ring::signature::Ed25519KeyPair::generate_pkcs8(&ring::rand::SystemRandom::new())
                .map_err(|_| "key generation")?;
        let key = ring::signature::Ed25519KeyPair::from_pkcs8(bytes.as_ref()).map_err(|_| "key")?;
        Ok(Self { root, key })
    }
    fn keys(&self) -> Result<BTreeMap<String, [u8; 32]>, Box<dyn std::error::Error>> {
        Ok(BTreeMap::from([(
            "test-only".into(),
            self.key.public_key().as_ref().try_into()?,
        )]))
    }
    fn open(&self) -> Result<AnnouncementStore, Box<dyn std::error::Error>> {
        Ok(AnnouncementStore::open(&self.root, self.keys()?)?)
    }
    fn payload(&self, sequence: u64) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../shared/test-fixtures/announcements/signed-feed.json"
        ))?;
        let raw = STANDARD.decode(
            fixture["envelope"]["payloadBase64"]
                .as_str()
                .ok_or("payload")?,
        )?;
        let mut payload: serde_json::Value = serde_json::from_slice(&raw)?;
        payload["sequence"] = sequence.into();
        payload["items"][0]["uid"] = UID.into();
        Ok(payload)
    }
    fn sign(&self, payload: &serde_json::Value) -> Result<Vec<u8>, serde_json::Error> {
        let raw = serde_json::to_vec(payload)?;
        let message = [b"JudgeDesk announcements v1\ntest-only\n".as_slice(), &raw].concat();
        serde_json::to_vec(&serde_json::json!({
            "format":"judgedesk-announcements-v1", "keyId":"test-only",
            "payloadBase64":STANDARD.encode(raw), "signatureBase64":STANDARD.encode(self.key.sign(&message).as_ref())
        }))
    }
    fn meta(&self) -> FetchMetadata {
        FetchMetadata {
            checked_at: NOW.into(),
            etag: Some("\"feed-1\"".into()),
            last_modified: None,
        }
    }
    fn state_path(&self) -> PathBuf {
        self.root.join("announcements/state.json")
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn store_preserves_read_and_delete_across_revisions_absence_and_restart() -> TestResult {
    let f = Fixture::new()?;
    let store = f.open()?;
    assert!(store.snapshot()?.feed.is_none());
    let first = store.accept_envelope(&f.sign(&f.payload(1)?)?, f.meta())?;
    assert!(!first.statuses[UID].deleted && first.statuses[UID].read_at.is_none());
    let read = store.set_read(UID, true, NOW)?;
    assert!(read.local_revision > first.local_revision);
    assert_eq!(
        store.set_read(UID, true, NOW)?.local_revision,
        read.local_revision
    );
    let mut next = f.payload(2)?;
    next["items"][0]["revision"] = 2.into();
    next["items"][0]["content"]["vi"]["title"] = "Edited".into();
    assert_eq!(
        store.accept_envelope(&f.sign(&next)?, f.meta())?.statuses[UID]
            .read_at
            .as_deref(),
        Some(NOW)
    );
    store.delete(UID)?;
    assert!(store.set_read(UID, false, NOW).is_err());
    let mut empty = f.payload(3)?;
    empty["items"] = serde_json::json!([]);
    assert!(store
        .accept_envelope(&f.sign(&empty)?, f.meta())?
        .statuses
        .is_empty());
    drop(store);
    let store = f.open()?;
    next["sequence"] = 4.into();
    let restored = store.accept_envelope(&f.sign(&next)?, f.meta())?;
    assert!(restored.statuses[UID].deleted);
    assert_eq!(restored.statuses[UID].read_at.as_deref(), Some(NOW));
    Ok(())
}

#[test]
fn conditional_refresh_revalidates_disk_and_gc_preserves_pinned_feeds_and_uid_state() -> TestResult
{
    let f = Fixture::new()?;
    let store = f.open()?;
    let first = store.accept_envelope(&f.sign(&f.payload(1)?)?, f.meta())?;
    let pinned = first.feed.ok_or("feed")?.payload_hash().to_owned();
    store.delete(UID)?;
    for sequence in 2..5 {
        store.accept_envelope(&f.sign(&f.payload(sequence)?)?, f.meta())?;
    }
    store.collect_feed_cache(Some(&pinned))?;
    assert_eq!(fs::read_dir(f.root.join("announcements/feeds"))?.count(), 2);
    assert!(f
        .root
        .join("announcements/feeds")
        .join(format!("{pinned}.json"))
        .exists());
    let mut meta = f.meta();
    meta.checked_at = "2026-10-24T00:01:00.000Z".into();
    assert!(store.revalidate_cached(meta.clone())?.statuses[UID].deleted);
    let active = store
        .snapshot()?
        .feed
        .ok_or("feed")?
        .payload_hash()
        .to_owned();
    fs::remove_file(
        f.root
            .join("announcements/feeds")
            .join(format!("{active}.json")),
    )?;
    assert!(store.revalidate_cached(meta).is_err());
    assert!(store.snapshot()?.statuses[UID].deleted);
    Ok(())
}

#[test]
fn article_views_pin_snapshot_and_reject_stale_or_deleted_open_without_marking_read() -> TestResult
{
    let f = Fixture::new()?;
    let store = Arc::new(f.open()?);
    let first = store.accept_envelope(&f.sign(&f.payload(1)?)?, f.meta())?;
    let hash = first.feed.ok_or("feed")?.payload_hash().to_owned();
    let runtime = super::service::Runtime::new(
        store.clone(),
        super::transport::client()?,
        "https://example.invalid/feed".into(),
        "https://example.invalid/media/".into(),
    );
    assert!(runtime.open_article(UID, &"0".repeat(64)).is_err());
    let opened = runtime.open_article(UID, &hash)?;
    assert!(store.snapshot()?.statuses[UID].read_at.is_none());
    let mut edited = f.payload(2)?;
    edited["items"][0]["revision"] = 2.into();
    edited["items"][0]["content"]["vi"]["title"] = "Edited".into();
    store.accept_envelope(&f.sign(&edited)?, f.meta())?;
    assert_eq!(runtime.article_item(&opened.view_id)?.revision, 1);
    assert!(runtime.open_article(UID, &hash).is_err());
    runtime.close_article(&opened.view_id)?;
    runtime.close_article(&opened.view_id)?;
    assert!(runtime.article_item(&opened.view_id).is_err());
    store.delete(UID)?;
    assert!(runtime
        .open_article(UID, store.snapshot()?.feed.ok_or("feed")?.payload_hash())
        .is_err());
    Ok(())
}

#[test]
fn store_rejects_rollback_equivocation_and_item_history_changes_without_writing() -> TestResult {
    let f = Fixture::new()?;
    let store = f.open()?;
    let current = f.payload(5)?;
    let initial = store.accept_envelope(&f.sign(&current)?, f.meta())?;
    let before = fs::read(f.state_path())?;
    for mut bad in [f.payload(4)?, current.clone(), f.payload(6)?] {
        if bad["sequence"] == 5 {
            bad["generatedAt"] = NOW.into();
        }
        if bad["sequence"] == 6 {
            bad["items"][0]["content"]["vi"]["title"] = "Changed without revision".into();
        }
        assert!(store.accept_envelope(&f.sign(&bad)?, f.meta()).is_err());
        assert_eq!(fs::read(f.state_path())?, before);
        assert_eq!(store.snapshot()?.local_revision, initial.local_revision);
    }
    let mut bad = f.payload(6)?;
    bad["items"][0]["revision"] = 2.into();
    bad["items"][0]["publishedAt"] = "2026-10-22T00:00:00.000Z".into();
    assert!(store.accept_envelope(&f.sign(&bad)?, f.meta()).is_err());
    let mut tampered = f.sign(&f.payload(6)?)?;
    tampered[10] ^= 1;
    assert!(store.accept_envelope(&tampered, f.meta()).is_err());
    assert_eq!(fs::read(f.state_path())?, before);
    Ok(())
}

#[test]
fn missing_nullable_fields_and_duplicate_uid_records_are_corruption() -> TestResult {
    for variant in ["readAt", "etag", "activeFeed", "uid"] {
        let f = Fixture::new()?;
        let store = f.open()?;
        store.accept_envelope(&f.sign(&f.payload(1)?)?, f.meta())?;
        store.set_read(UID, true, NOW)?;
        drop(store);
        let mut value: serde_json::Value = serde_json::from_slice(&fs::read(f.state_path())?)?;
        match variant {
            "readAt" => {
                value["uids"][UID]["status"]
                    .as_object_mut()
                    .ok_or("status")?
                    .remove("readAt");
            }
            "etag" => {
                value["fetch"]
                    .as_object_mut()
                    .ok_or("fetch")?
                    .remove("etag");
            }
            "activeFeed" => {
                value.as_object_mut().ok_or("state")?.remove("activeFeed");
            }
            _ => (),
        }
        let mut raw = serde_json::to_string(&value)?;
        if variant == "uid" {
            let record = serde_json::to_string(&value["uids"][UID])?;
            raw = raw.replacen("\"uids\":{", &format!("\"uids\":{{\"{UID}\":{record},"), 1);
        }
        fs::write(f.state_path(), raw.as_bytes())?;
        assert!(f.open().is_err(), "{variant}");
        assert_eq!(fs::read(f.state_path())?, raw.as_bytes());
    }
    Ok(())
}

#[test]
fn state_size_and_revision_limits_never_prune_history_to_make_a_write_pass() -> TestResult {
    let f = Fixture::new()?;
    let store = f.open()?;
    store.accept_envelope(&f.sign(&f.payload(1)?)?, f.meta())?;
    drop(store);
    let mut value: serde_json::Value = serde_json::from_slice(&fs::read(f.state_path())?)?;
    value["localRevision"] = 9_007_199_254_740_991_u64.into();
    fs::write(f.state_path(), serde_json::to_vec(&value)?)?;
    let store = f.open()?;
    assert!(matches!(
        store.set_read(UID, true, NOW),
        Err(super::store::StoreError::CounterLimit)
    ));
    assert!(store.snapshot()?.statuses[UID].read_at.is_none());
    drop(store);
    value["localRevision"] = 2.into();
    value["fetch"]["etag"] = "x".into();
    let record = value["uids"][UID].clone();
    let per_entry = serde_json::to_vec(&record)?.len() + 40;
    let maximum = super::store_state::MAX_STATE_BYTES;
    let count = (maximum - 2048 - serde_json::to_vec(&value)?.len()) / per_entry;
    let uids = value["uids"].as_object_mut().ok_or("uids")?;
    for index in 0..count {
        uids.insert(
            format!("{index:08x}-1234-4234-8234-123456789abc"),
            record.clone(),
        );
    }
    let remaining = maximum - serde_json::to_vec(&value)?.len();
    assert!(remaining < 4095);
    value["fetch"]["etag"] = "x".repeat(remaining + 1).into();
    let bytes = serde_json::to_vec(&value)?;
    assert_eq!(bytes.len(), maximum);
    fs::write(f.state_path(), &bytes)?;
    let store = f.open()?;
    assert!(matches!(
        store.set_read(UID, true, NOW),
        Err(super::store::StoreError::StateLimit)
    ));
    assert_eq!(store.snapshot()?.local_revision, 2);
    assert_eq!(fs::read(f.state_path())?, bytes);
    Ok(())
}

#[test]
fn unsafe_headers_and_regressing_item_revisions_leave_the_active_feed_unchanged() -> TestResult {
    let f = Fixture::new()?;
    let store = f.open()?;
    let mut payload = f.payload(1)?;
    payload["items"][0]["revision"] = 3.into();
    store.accept_envelope(&f.sign(&payload)?, f.meta())?;
    let before = fs::read(f.state_path())?;
    payload["sequence"] = 2.into();
    payload["items"][0]["revision"] = 2.into();
    assert!(matches!(
        store.accept_envelope(&f.sign(&payload)?, f.meta()),
        Err(super::store::StoreError::ItemHistory)
    ));
    payload["items"][0]["revision"] = 3.into();
    for etag in [
        "injected\r\nX-Header: value".to_string(),
        "x".repeat(4097),
        String::new(),
    ] {
        let mut metadata = f.meta();
        metadata.etag = Some(etag);
        assert!(store.accept_envelope(&f.sign(&payload)?, metadata).is_err());
    }
    assert_eq!(fs::read(f.state_path())?, before);
    Ok(())
}

#[test]
fn mark_all_uses_only_clicked_uids_and_unknown_operations_do_not_create_history() -> TestResult {
    let f = Fixture::new()?;
    let store = f.open()?;
    store.accept_envelope(&f.sign(&f.payload(1)?)?, f.meta())?;
    let mut newer = f.payload(2)?;
    let mut other = newer["items"][0].clone();
    other["uid"] = OTHER.into();
    newer["items"].as_array_mut().ok_or("items")?.push(other);
    store.accept_envelope(&f.sign(&newer)?, f.meta())?;
    let marked = store.mark_all_read(&[UID.into(), UID.into()], NOW)?;
    assert!(marked.statuses[UID].read_at.is_some());
    assert!(marked.statuses[OTHER].read_at.is_none());
    assert!(store.set_read("../../../state", true, NOW).is_err());
    assert!(store.delete("unknown").is_err());
    assert_eq!(store.snapshot()?.local_revision, marked.local_revision);
    assert!(store.set_read(UID, false, NOW)?.statuses[UID]
        .read_at
        .is_none());
    Ok(())
}

#[test]
fn corrupt_missing_or_mismatched_cache_never_resets_uid_state() -> TestResult {
    for variant in ["state", "feed", "missing", "duplicate"] {
        let f = Fixture::new()?;
        let store = f.open()?;
        let snap = store.accept_envelope(&f.sign(&f.payload(1)?)?, f.meta())?;
        store.delete(UID)?;
        drop(store);
        match variant {
            "state" => fs::write(f.state_path(), b"broken")?,
            "duplicate" => {
                let text = fs::read_to_string(f.state_path())?;
                fs::write(
                    f.state_path(),
                    text.replacen(
                        "\"localRevision\":",
                        "\"localRevision\":1,\"localRevision\":",
                        1,
                    ),
                )?;
            }
            _ => {
                let path = f
                    .root
                    .join("announcements/feeds")
                    .join(format!("{}.json", snap.feed.ok_or("feed")?.payload_hash()));
                if variant == "missing" {
                    fs::remove_file(path)?;
                } else {
                    fs::write(path, b"broken")?;
                }
            }
        }
        let before = fs::read(f.state_path())?;
        assert!(f.open().is_err(), "{variant}");
        assert_eq!(fs::read(f.state_path())?, before);
    }
    Ok(())
}

#[test]
fn store_has_an_exclusive_process_lifetime_lock_and_bounded_state_reads() -> TestResult {
    if let Some(root) = std::env::var_os("JUDGEDESK_ANNOUNCEMENT_LOCK_TEST") {
        assert!(matches!(
            AnnouncementStore::open(&PathBuf::from(root), BTreeMap::new()),
            Err(StoreError::Busy)
        ));
        return Ok(());
    }
    let f = Fixture::new()?;
    let store = f.open()?;
    assert!(f.open().is_err());
    let child = std::process::Command::new(std::env::current_exe()?)
        .args(["--exact", "announcements::store_tests::store_has_an_exclusive_process_lifetime_lock_and_bounded_state_reads"])
        .env("JUDGEDESK_ANNOUNCEMENT_LOCK_TEST", &f.root).output()?;
    assert!(
        child.status.success(),
        "{}",
        String::from_utf8_lossy(&child.stderr)
    );
    drop(store);
    drop(f.open()?);
    let file = fs::OpenOptions::new().write(true).open(f.state_path())?;
    file.set_len(16 * 1024 * 1024 + 1)?;
    drop(file);
    assert!(f.open().is_err());
    Ok(())
}

#[test]
fn linked_directories_and_nonregular_state_are_rejected_without_touching_the_target() -> TestResult
{
    let f = Fixture::new()?;
    let outside = f.root.join("separate-owned-target");
    fs::create_dir(&outside)?;
    fs::write(outside.join("sentinel"), b"preserve")?;
    let link = f.root.join("announcements");
    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside, &link)?;
    #[cfg(windows)]
    {
        // Junctions need no symlink privilege; generated temp paths are passed as separate args.
        let result = std::process::Command::new("cmd.exe")
            .args(["/D", "/C", "mklink", "/J"])
            .arg(&link)
            .arg(&outside)
            .output()?;
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
    }
    assert!(matches!(
        AnnouncementStore::open(&f.root, f.keys()?),
        Err(StoreError::UnsafePath)
    ));
    assert_eq!(fs::read(outside.join("sentinel"))?, b"preserve");
    assert_eq!(fs::read_dir(&outside)?.count(), 1);
    #[cfg(unix)]
    fs::remove_file(&link)?;
    #[cfg(windows)]
    fs::remove_dir(&link)?;
    let store = f.open()?;
    drop(store);
    fs::remove_file(f.state_path())?;
    fs::create_dir(f.state_path())?;
    assert!(f.open().is_err());
    assert!(f.state_path().is_dir());
    Ok(())
}

#[test]
fn identical_feed_is_idempotent_and_metadata_refresh_keeps_read_state() -> TestResult {
    let f = Fixture::new()?;
    let store = f.open()?;
    let raw = f.sign(&f.payload(1)?)?;
    let initial = store.accept_envelope(&raw, f.meta())?;
    assert_eq!(
        store.accept_envelope(&raw, f.meta())?.local_revision,
        initial.local_revision
    );
    let read = store.set_read(UID, true, NOW)?;
    let mut metadata = f.meta();
    metadata.checked_at = "2026-10-24T00:01:00.000Z".into();
    metadata.etag = Some("\"new-validator\"".into());
    let refreshed = store.accept_envelope(&raw, metadata.clone())?;
    assert_eq!(refreshed.local_revision, read.local_revision + 1);
    assert_eq!(refreshed.fetch, Some(metadata));
    assert_eq!(refreshed.statuses, read.statuses);
    let hash = refreshed.feed.ok_or("feed")?.payload_hash().to_owned();
    drop(store);
    assert_eq!(
        f.open()?.snapshot()?.feed.ok_or("feed")?.payload_hash(),
        hash
    );
    Ok(())
}

#[test]
fn identical_refetch_restores_a_missing_blob_but_does_not_accept_corrupt_cache() -> TestResult {
    let f = Fixture::new()?;
    let store = f.open()?;
    let raw = f.sign(&f.payload(1)?)?;
    let snapshot = store.accept_envelope(&raw, f.meta())?;
    let path = f.root.join("announcements/feeds").join(format!(
        "{}.json",
        snapshot.feed.ok_or("feed")?.payload_hash()
    ));
    store.set_read(UID, true, NOW)?;
    let state = fs::read(f.state_path())?;
    fs::remove_file(&path)?;
    store.accept_envelope(&raw, f.meta())?;
    assert_eq!(fs::read(&path)?, raw);
    assert_eq!(fs::read(f.state_path())?, state);
    fs::write(&path, b"corrupt cache")?;
    assert!(store.accept_envelope(&raw, f.meta()).is_err());
    assert_eq!(fs::read(&path)?, b"corrupt cache");
    assert_eq!(fs::read(f.state_path())?, state);
    assert!(store.snapshot()?.statuses[UID].read_at.is_some());
    Ok(())
}

#[test]
fn concurrent_read_and_delete_mutations_do_not_overwrite_each_other() -> TestResult {
    let f = Fixture::new()?;
    let store = Arc::new(f.open()?);
    let mut payload = f.payload(1)?;
    let mut other = payload["items"][0].clone();
    other["uid"] = OTHER.into();
    payload["items"].as_array_mut().ok_or("items")?.push(other);
    store.accept_envelope(&f.sign(&payload)?, f.meta())?;
    std::thread::scope(|scope| {
        let first = scope.spawn(|| store.set_read(UID, true, NOW));
        let second = scope.spawn(|| store.delete(OTHER));
        first.join().map_err(|_| "read thread")??;
        second.join().map_err(|_| "delete thread")??;
        Ok::<_, Box<dyn std::error::Error>>(())
    })?;
    let snapshot = store.snapshot()?;
    assert!(snapshot.statuses[UID].read_at.is_some());
    assert!(snapshot.statuses[OTHER].deleted);
    drop(store);
    let snapshot = f.open()?.snapshot()?;
    assert!(snapshot.statuses[UID].read_at.is_some() && snapshot.statuses[OTHER].deleted);
    Ok(())
}

#[test]
fn failed_commit_keeps_memory_and_disk_at_the_previous_revision() -> TestResult {
    use super::store_io::Checkpoint;
    for boundary in [Checkpoint::FeedStored, Checkpoint::StateTempSynced] {
        let f = Fixture::new()?;
        let mut store = f.open()?;
        let before = store.accept_envelope(&f.sign(&f.payload(1)?)?, f.meta())?;
        store.set_hook(Arc::new(move |point| {
            if point == boundary {
                return Err(std::io::Error::other("injected storage failure"));
            }
            Ok(())
        }));
        let bytes = fs::read(f.state_path())?;
        assert!(store
            .accept_envelope(&f.sign(&f.payload(2)?)?, f.meta())
            .is_err());
        assert_eq!(store.snapshot()?.local_revision, before.local_revision);
        assert_eq!(fs::read(f.state_path())?, bytes);
        drop(store);
        let store = f.open()?;
        assert_eq!(store.snapshot()?.local_revision, before.local_revision);
        assert_eq!(store.snapshot()?.feed.ok_or("feed")?.payload().sequence, 1);
        assert_eq!(
            store
                .accept_envelope(&f.sign(&f.payload(2)?)?, f.meta())?
                .feed
                .ok_or("feed")?
                .payload()
                .sequence,
            2
        );
    }
    Ok(())
}

#[test]
fn feed_prepared_before_a_user_mutation_merges_the_latest_state() -> TestResult {
    use super::store_io::Checkpoint;
    use std::{
        sync::{mpsc, Mutex},
        time::Duration,
    };
    let f = Fixture::new()?;
    let mut store = f.open()?;
    store.accept_envelope(&f.sign(&f.payload(1)?)?, f.meta())?;
    let (ready_tx, ready_rx) = mpsc::channel();
    let (resume_tx, resume_rx) = mpsc::channel();
    let resume_rx = Mutex::new(resume_rx);
    store.set_hook(Arc::new(move |point| {
        if point == Checkpoint::Verified {
            ready_tx.send(()).map_err(std::io::Error::other)?;
            resume_rx
                .lock()
                .map_err(|_| std::io::Error::other("channel lock"))?
                .recv_timeout(Duration::from_secs(10))
                .map_err(std::io::Error::other)?;
        }
        Ok(())
    }));
    let store = Arc::new(store);
    let raw = f.sign(&f.payload(2)?)?;
    let metadata = f.meta();
    std::thread::scope(|scope| {
        let task = scope.spawn(|| store.accept_envelope(&raw, metadata));
        ready_rx.recv_timeout(Duration::from_secs(10))?;
        store.set_read(UID, true, NOW)?;
        store.delete(UID)?;
        resume_tx.send(())?;
        let snapshot = task.join().map_err(|_| "refresh thread")??;
        assert!(snapshot.statuses[UID].deleted && snapshot.statuses[UID].read_at.is_some());
        Ok::<_, Box<dyn std::error::Error>>(())
    })?;
    drop(store);
    let snapshot = f.open()?.snapshot()?;
    assert!(snapshot.statuses[UID].deleted && snapshot.statuses[UID].read_at.is_some());
    Ok(())
}

#[test]
fn commits_are_restart_safe_across_process_exit_boundaries() -> TestResult {
    use super::store_io::Checkpoint;
    const CHILD: &str = "JUDGEDESK_ANNOUNCEMENT_CRASH_TEST";
    if let Some(root) = std::env::var_os(CHILD) {
        let bytes = fs::read(PathBuf::from(&root).join("test-key.pk8"))?;
        let key = ring::signature::Ed25519KeyPair::from_pkcs8(&bytes).map_err(|_| "key")?;
        let keys = BTreeMap::from([("test-only".into(), key.public_key().as_ref().try_into()?)]);
        let mut store = AnnouncementStore::open(&PathBuf::from(root), keys)?;
        let phase = std::env::var("JUDGEDESK_ANNOUNCEMENT_CRASH_PHASE")?;
        store.set_hook(Arc::new(move |point| {
            if (phase == "feed" && point == Checkpoint::FeedStored)
                || (phase == "temp" && point == Checkpoint::StateTempSynced)
            {
                std::process::exit(73);
            }
            Ok(())
        }));
        let raw = fs::read(std::env::var_os("JUDGEDESK_ANNOUNCEMENT_CRASH_INPUT").ok_or("input")?)?;
        store.accept_envelope(
            &raw,
            FetchMetadata {
                checked_at: NOW.into(),
                etag: None,
                last_modified: None,
            },
        )?;
        std::process::exit(73);
    }
    for phase in ["feed", "temp", "committed"] {
        let mut f = Fixture::new()?;
        // Ephemeral private key is written only to this owned temporary test root, never fixtures/logs.
        let key = ring::signature::Ed25519KeyPair::generate_pkcs8(&ring::rand::SystemRandom::new())
            .map_err(|_| "key")?;
        fs::write(f.root.join("test-key.pk8"), key.as_ref())?;
        f.key = ring::signature::Ed25519KeyPair::from_pkcs8(key.as_ref()).map_err(|_| "key")?;
        let store = f.open()?;
        store.accept_envelope(&f.sign(&f.payload(1)?)?, f.meta())?;
        store.delete(UID)?;
        drop(store);
        let raw_path = f.root.join("incoming.json");
        fs::write(&raw_path, f.sign(&f.payload(2)?)?)?;
        let status = std::process::Command::new(std::env::current_exe()?)
            .args(["--exact", "announcements::store_tests::commits_are_restart_safe_across_process_exit_boundaries", "--nocapture"])
            .env(CHILD, &f.root).env("JUDGEDESK_ANNOUNCEMENT_CRASH_PHASE", phase)
            .env("JUDGEDESK_ANNOUNCEMENT_CRASH_INPUT", &raw_path).output()?.status;
        assert_eq!(status.code(), Some(73), "{phase}");
        let snapshot = f.open()?.snapshot()?;
        assert!(snapshot.statuses[UID].deleted);
        assert_eq!(
            snapshot.feed.ok_or("feed")?.payload().sequence,
            if phase == "committed" { 2 } else { 1 }
        );
    }
    Ok(())
}

#[cfg(windows)]
#[test]
fn windows_locked_state_rejects_replace_without_losing_committed_state() -> TestResult {
    use std::os::windows::fs::OpenOptionsExt;
    let f = Fixture::new()?;
    let store = f.open()?;
    let before = store.accept_envelope(&f.sign(&f.payload(1)?)?, f.meta())?;
    let bytes = fs::read(f.state_path())?;
    let locked = fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(f.state_path())?;
    assert!(store.set_read(UID, true, NOW).is_err());
    assert_eq!(store.snapshot()?.local_revision, before.local_revision);
    assert_eq!(fs::read(f.state_path())?, bytes);
    drop(locked);
    assert!(store.set_read(UID, true, NOW)?.statuses[UID]
        .read_at
        .is_some());
    Ok(())
}
