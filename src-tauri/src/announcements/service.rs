use super::{
    dto::{ArticleView, Snapshot},
    transport::{self, Download},
    AnnouncementImage, AnnouncementItem, AnnouncementStore, FetchMetadata, StoreError, StoredFeed,
};
use reqwest::header::{HeaderMap, HeaderValue, IF_MODIFIED_SINCE, IF_NONE_MATCH};
use std::{
    collections::{BTreeMap, HashSet},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use tokio::sync::{watch, OnceCell, Semaphore};
type Result<T> = std::result::Result<T, String>;
fn storage_error(_: impl std::fmt::Display) -> String {
    "storage".into()
}
pub(super) fn now() -> String {
    chrono::DateTime::<chrono::Utc>::from(std::time::SystemTime::now())
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
struct PinnedView {
    id: String,
    feed: Arc<StoredFeed>,
    uid: String,
    cancelled: watch::Sender<bool>,
}
#[derive(Default, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RefreshReason {
    Session,
    Stale,
    #[default]
    Manual,
}

pub(super) struct Runtime {
    pub store: Arc<AnnouncementStore>,
    client: reqwest::Client,
    endpoint: String,
    media_prefix: String,
    view: Arc<Mutex<Option<PinnedView>>>,
    refresh_lock: tokio::sync::Mutex<()>,
    epoch: AtomicU64,
    session_started: AtomicBool,
    last_refresh: Mutex<Option<String>>,
    network: Arc<Semaphore>,
    decoder: Arc<Semaphore>,
    media_lock: Arc<Mutex<()>>,
    stopped: watch::Sender<bool>,
}
impl Runtime {
    pub(super) fn new(
        store: Arc<AnnouncementStore>,
        client: reqwest::Client,
        endpoint: String,
        media_prefix: String,
    ) -> Self {
        Self {
            store,
            client,
            endpoint,
            media_prefix,
            view: Arc::new(Mutex::new(None)),
            refresh_lock: tokio::sync::Mutex::new(()),
            epoch: AtomicU64::new(0),
            session_started: AtomicBool::new(false),
            last_refresh: Mutex::new(None),
            network: Arc::new(Semaphore::new(2)),
            decoder: Arc::new(Semaphore::new(1)),
            media_lock: Arc::new(Mutex::new(())),
            stopped: watch::channel(false).0,
        }
    }
    pub fn stop(&self) {
        self.stopped.send_replace(true);
        self.network.close();
        self.decoder.close();
    }
    fn running(&self) -> Result<()> {
        if *self.stopped.borrow() {
            Err("stopped".into())
        } else {
            Ok(())
        }
    }
    async fn download(&self, url: &str, headers: HeaderMap, limit: usize) -> Result<Download> {
        self.running()?;
        let mut stop = self.stopped.subscribe();
        if *stop.borrow() {
            return Err("stopped".into());
        }
        tokio::select! { biased;
            _ = stop.changed() => Err("stopped".into()),
            result = transport::fetch(&self.client, url, headers, limit) => result.map_err(|_| "network".into()),
        }
    }
    pub fn snapshot(&self) -> Result<Snapshot> {
        self.store.snapshot().map(Into::into).map_err(storage_error)
    }
    pub async fn refresh_for(&self, reason: RefreshReason) -> Result<Snapshot> {
        self.running()?;
        if matches!(reason, RefreshReason::Session)
            && self.session_started.swap(true, Ordering::AcqRel)
        {
            let _guard = self.refresh_lock.lock().await;
            self.running()?;
            if let Some(error) = self.last_refresh.lock().map_err(storage_error)?.clone() {
                return Err(error);
            }
            return self.snapshot();
        }
        if matches!(reason, RefreshReason::Stale) {
            if let Some(metadata) = self.store.snapshot().map_err(storage_error)?.fetch {
                let checked = chrono::DateTime::parse_from_rfc3339(&metadata.checked_at)
                    .map_err(storage_error)?;
                let current = chrono::DateTime::<chrono::Utc>::from(std::time::SystemTime::now());
                if current.timestamp_millis() - checked.timestamp_millis() <= 30 * 60 * 1000 {
                    return self.snapshot();
                }
            }
        }
        self.refresh().await
    }
    pub async fn refresh(&self) -> Result<Snapshot> {
        let epoch = self.epoch.load(Ordering::Acquire);
        let _guard = self.refresh_lock.lock().await;
        self.running()?;
        if self.epoch.load(Ordering::Acquire) != epoch {
            if let Some(error) = self.last_refresh.lock().map_err(storage_error)?.clone() {
                return Err(error);
            }
            return self.snapshot();
        }
        let result = self.refresh_once().await;
        *self.last_refresh.lock().map_err(storage_error)? = result.as_ref().err().cloned();
        self.epoch.fetch_add(1, Ordering::Release);
        result
    }
    async fn refresh_once(&self) -> Result<Snapshot> {
        let snapshot = self.store.snapshot().map_err(storage_error)?;
        let old = snapshot.fetch;
        let mut headers = HeaderMap::new();
        if snapshot.feed.is_some() {
            if let Some(meta) = &old {
                for (key, value) in [
                    (IF_NONE_MATCH, &meta.etag),
                    (IF_MODIFIED_SINCE, &meta.last_modified),
                ] {
                    if let Some(value) = value {
                        headers.insert(key, HeaderValue::from_str(value).map_err(storage_error)?);
                    }
                }
            }
        }
        for attempt in 0..2 {
            let result = self
                .download(
                    &self.endpoint,
                    headers.clone(),
                    super::limits::MAX_ENVELOPE_BYTES,
                )
                .await?;
            self.running()?;
            let store = self.store.clone();
            let accepted = match result {
                Download::Modified {
                    bytes,
                    etag,
                    last_modified,
                    ..
                } => tokio::task::spawn_blocking(move || {
                    store.accept_envelope(
                        &bytes,
                        FetchMetadata {
                            checked_at: now(),
                            etag,
                            last_modified,
                        },
                    )
                })
                .await
                .map_err(storage_error)?
                .map_err(storage_error)?,
                Download::NotModified {
                    etag,
                    last_modified,
                } => {
                    let meta = FetchMetadata {
                        checked_at: now(),
                        etag: etag.or_else(|| old.as_ref().and_then(|meta| meta.etag.clone())),
                        last_modified: last_modified
                            .or_else(|| old.as_ref().and_then(|meta| meta.last_modified.clone())),
                    };
                    match tokio::task::spawn_blocking(move || store.revalidate_cached(meta))
                        .await
                        .map_err(storage_error)?
                    {
                        Ok(value) => value,
                        Err(StoreError::CacheMissing) if attempt == 0 => {
                            headers.clear();
                            continue;
                        }
                        Err(_) => return Err("cache".into()),
                    }
                }
            };
            self.running()?;
            let view = self.view.clone();
            let store = self.store.clone();
            tokio::task::spawn_blocking(move || {
                let pinned = view.lock().map_err(storage_error)?;
                store
                    .collect_feed_cache(pinned.as_ref().map(|view| view.feed.payload_hash()))
                    .map_err(storage_error)
            })
            .await
            .map_err(storage_error)??;
            return Ok(accepted.into());
        }
        Err("network".into())
    }
    pub fn open_article(&self, uid: &str, feed_hash: &str) -> Result<ArticleView> {
        self.running()?;
        // Lock order is view -> store. Hold the pin boundary from snapshot lookup
        // through publication, so GC cannot race a newly opened old-feed view.
        let mut pinned = self.view.lock().map_err(storage_error)?;
        let snapshot = self.store.snapshot().map_err(storage_error)?;
        let feed = snapshot.feed.ok_or("staleSnapshot")?;
        if feed.payload_hash() != feed_hash
            || snapshot.statuses.get(uid).is_none_or(|state| state.deleted)
        {
            return Err("staleSnapshot".into());
        }
        let item = feed
            .payload()
            .items
            .iter()
            .find(|item| item.uid == uid)
            .ok_or("staleSnapshot")?;
        if item
            .expires_at
            .as_ref()
            .is_some_and(|expires| expires <= &now())
        {
            return Err("staleSnapshot".into());
        }
        let mut random = [0; 32];
        getrandom::fill(&mut random).map_err(|_| "random")?;
        let id: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let result = ArticleView {
            view_id: id.clone(),
            feed_hash: feed_hash.into(),
            item: item.clone(),
        };
        if let Some(previous) = pinned.as_ref() {
            previous.cancelled.send_replace(true);
        }
        *pinned = Some(PinnedView {
            id,
            feed,
            uid: uid.into(),
            cancelled: watch::channel(false).0,
        });
        Ok(result)
    }
    pub fn close_article(&self, id: &str) -> Result<()> {
        let mut view = self.view.lock().map_err(storage_error)?;
        if view.as_ref().is_some_and(|view| view.id == id) {
            if let Some(view) = view.as_ref() {
                view.cancelled.send_replace(true);
            }
            *view = None;
        }
        Ok(())
    }
    pub fn article_item(&self, id: &str) -> Result<AnnouncementItem> {
        let view = self.view.lock().map_err(storage_error)?;
        let view = view
            .as_ref()
            .filter(|view| view.id == id)
            .ok_or("viewClosed")?;
        view.feed
            .payload()
            .items
            .iter()
            .find(|item| item.uid == view.uid)
            .cloned()
            .ok_or_else(|| "viewClosed".into())
    }
    pub fn link(&self, view_id: &str, link_id: &str) -> Result<String> {
        self.running()?;
        let item = self.article_item(view_id)?;
        let link = item
            .links
            .iter()
            .find(|link| link.id == link_id)
            .ok_or("link")?;
        if !super::model::approved_link(&link.url) {
            return Err("link".into());
        }
        Ok(link.url.clone())
    }
    pub async fn image(&self, view_id: &str, image_id: &str) -> Result<Vec<u8>> {
        let (image, mut cancelled) = {
            let view = self.view.lock().map_err(storage_error)?;
            let view = view
                .as_ref()
                .filter(|view| view.id == view_id)
                .ok_or("viewClosed")?;
            let image = view
                .feed
                .payload()
                .items
                .iter()
                .find(|item| item.uid == view.uid)
                .and_then(|item| {
                    item.images
                        .iter()
                        .find(|image| image.id == image_id && image.role == "article")
                })
                .cloned()
                .ok_or("image")?;
            (image, view.cancelled.subscribe())
        };
        if *cancelled.borrow() {
            return Err("viewClosed".into());
        }
        let bytes = tokio::select! { biased;
            _ = cancelled.changed() => return Err("viewClosed".into()),
            result = self.load_image(image) => result?,
        };
        self.running()?;
        self.article_item(view_id)?;
        Ok(bytes)
    }
    pub async fn thumbnail(&self, uid: &str, feed_hash: &str) -> Result<Vec<u8>> {
        let snapshot = self.store.snapshot().map_err(storage_error)?;
        let feed = snapshot
            .feed
            .filter(|feed| feed.payload_hash() == feed_hash)
            .ok_or("staleSnapshot")?;
        if snapshot.statuses.get(uid).is_none_or(|state| state.deleted) {
            return Err("staleSnapshot".into());
        }
        let item = feed
            .payload()
            .items
            .iter()
            .find(|item| item.uid == uid)
            .ok_or("staleSnapshot")?;
        let image = item
            .images
            .iter()
            .find(|image| {
                Some(&image.id) == item.thumbnail_id.as_ref() && image.role == "thumbnail"
            })
            .cloned()
            .ok_or("image")?;
        self.load_image(image).await
    }
    async fn load_image(&self, image: AnnouncementImage) -> Result<Vec<u8>> {
        self.running()?;
        let _network = self.network.acquire().await.map_err(storage_error)?;
        self.running()?;
        let store = self.store.clone();
        let metadata = image.clone();
        let media_lock = self.media_lock.clone();
        let cached = tokio::task::spawn_blocking(move || {
            let _guard = media_lock.lock().map_err(storage_error)?;
            store.cached_media(&metadata).map_err(storage_error)
        })
        .await
        .map_err(storage_error)??;
        let bytes = if let Some(bytes) = cached {
            bytes
        } else {
            let url = format!("{}{}.{}", self.media_prefix, image.sha256, image.extension);
            match self
                .download(&url, HeaderMap::new(), image.size_bytes as usize)
                .await?
            {
                Download::Modified {
                    bytes,
                    content_type,
                    ..
                } if content_type.as_deref() == Some(image.mime.as_str()) => bytes,
                _ => return Err("image".into()),
            }
        };
        let permit = self
            .decoder
            .clone()
            .acquire_owned()
            .await
            .map_err(storage_error)?;
        let metadata = image.clone();
        let bytes = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            super::media::validate_image(&bytes, &metadata).map_err(|_| "image".to_owned())?;
            Ok::<_, String>(bytes)
        })
        .await
        .map_err(storage_error)??;
        self.running()?;
        let view = self.view.clone();
        let store = self.store.clone();
        let media_lock = self.media_lock.clone();
        let bytes = tokio::task::spawn_blocking(move || {
            let _guard = media_lock.lock().map_err(storage_error)?;
            let pinned = view.lock().map_err(storage_error)?;
            let pins: HashSet<String> = pinned
                .iter()
                .flat_map(|view| {
                    view.feed
                        .payload()
                        .items
                        .iter()
                        .filter(|item| item.uid == view.uid)
                        .flat_map(|item| &item.images)
                })
                .map(|image| image.sha256.clone())
                .collect();
            store
                .save_media(&image, &bytes, &pins)
                .map_err(storage_error)?;
            Ok::<_, String>(bytes)
        })
        .await
        .map_err(storage_error)??;
        self.running()?;
        Ok(bytes)
    }
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Trust {
    endpoint: String,
    media_prefix: String,
    keys: Vec<TrustKey>,
}
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct TrustKey {
    key_id: String,
    public_key_base64: String,
}
#[derive(Default)]
pub struct AnnouncementService {
    runtime: OnceCell<Result<Arc<Runtime>>>,
    stopped: std::sync::atomic::AtomicBool,
}
impl AnnouncementService {
    pub(super) async fn runtime(&self) -> Result<Arc<Runtime>> {
        if self.stopped.load(Ordering::Acquire) {
            return Err("stopped".into());
        }
        self.runtime
            .get_or_init(|| async {
                tokio::task::spawn_blocking(|| {
                    use base64::{engine::general_purpose::STANDARD, Engine};
                    let trust: Trust = serde_json::from_str(include_str!(
                        "../../../shared/announcements-trust.json"
                    ))
                    .map_err(|_| "trust")?;
                    // Empty production trust is intentional until key custody/Pages bootstrap is approved.
                    if trust.keys.is_empty() {
                        return Err("unconfigured".into());
                    }
                    let mut keys = BTreeMap::new();
                    for key in trust.keys {
                        let bytes = STANDARD
                            .decode(&key.public_key_base64)
                            .map_err(|_| "trust")?;
                        if STANDARD.encode(&bytes) != key.public_key_base64
                            || keys
                                .insert(key.key_id, bytes.try_into().map_err(|_| "trust")?)
                                .is_some()
                        {
                            return Err("trust".into());
                        }
                    }
                    let root = judgedesk_core::toolchains::discovery::get_app_data_dir();
                    std::fs::create_dir_all(&root).map_err(storage_error)?;
                    let store =
                        Arc::new(AnnouncementStore::open(&root, keys).map_err(storage_error)?);
                    Ok(Arc::new(Runtime::new(
                        store,
                        transport::client().map_err(|_| "network")?,
                        trust.endpoint,
                        trust.media_prefix,
                    )))
                })
                .await
                .map_err(storage_error)?
            })
            .await
            .clone()
            .and_then(|runtime| {
                if self.stopped.load(Ordering::Acquire) {
                    runtime.stop();
                    Err("stopped".into())
                } else {
                    Ok(runtime)
                }
            })
    }
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::Release);
        if let Some(Ok(runtime)) = self.runtime.get() {
            runtime.stop();
        }
    }
}
