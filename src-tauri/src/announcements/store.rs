use super::store_io::{Checkpoint, StoreFiles};
use super::store_state::{hash, FeedPointer, StoredState, MAX_STATE_BYTES};
pub use super::store_state::{FetchMetadata, ReadState};
use super::{
    parse_payload, verify_signed_envelope, AnnouncementPayload, PayloadError, VerifyError,
};
use std::{
    collections::{BTreeMap, HashSet},
    fmt, io,
    path::Path,
    sync::{Arc, Mutex},
};

#[derive(Debug)]
pub enum StoreError {
    Io(io::Error),
    Verify(VerifyError),
    Payload(PayloadError),
    InvalidState,
    CacheMissing,
    UnsafePath,
    StateLimit,
    Busy,
    Poisoned,
    Random,
    Rollback,
    Equivocation,
    ItemHistory,
    UnknownUid,
    CounterLimit,
}
impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(f, "Announcement storage I/O failed: {error}"),
            Self::Verify(error) => error.fmt(f),
            Self::Payload(error) => error.fmt(f),
            _ => write!(f, "Announcement store rejected the operation: {self:?}"),
        }
    }
}
impl std::error::Error for StoreError {}
impl From<io::Error> for StoreError {
    fn from(e: io::Error) -> Self {
        Self::Io(e)
    }
}
impl From<VerifyError> for StoreError {
    fn from(e: VerifyError) -> Self {
        Self::Verify(e)
    }
}
impl From<PayloadError> for StoreError {
    fn from(e: PayloadError) -> Self {
        Self::Payload(e)
    }
}

/// Authenticated metadata, not sanitized HTML. Constructed only by verification against store keys.
#[derive(Debug)]
pub struct StoredFeed {
    payload_hash: String,
    payload: AnnouncementPayload,
    envelope: Vec<u8>,
}
impl StoredFeed {
    fn verify(raw: &[u8], keys: &BTreeMap<String, [u8; 32]>) -> Result<Self, StoreError> {
        let bytes = verify_signed_envelope(raw, keys)?;
        Ok(Self {
            payload_hash: hash(&bytes),
            payload: parse_payload(&bytes)?,
            envelope: raw.to_vec(),
        })
    }
    pub fn payload_hash(&self) -> &str {
        &self.payload_hash
    }
    pub fn payload(&self) -> &AnnouncementPayload {
        &self.payload
    }
}

#[derive(Debug)]
pub struct StoreSnapshot {
    pub local_revision: u64,
    pub feed: Option<Arc<StoredFeed>>,
    pub fetch: Option<FetchMetadata>,
    /// Current-feed statuses only. Historical tombstones remain private in persisted state.
    pub statuses: BTreeMap<String, ReadState>,
}
struct Inner {
    state: StoredState,
    feed: Option<Arc<StoredFeed>>,
}
impl Inner {
    fn snapshot(&self) -> StoreSnapshot {
        let statuses = self
            .feed
            .iter()
            .flat_map(|feed| &feed.payload.items)
            .filter_map(|item| {
                self.state
                    .uids
                    .get(&item.uid)
                    .map(|record| (item.uid.clone(), record.status.clone()))
            })
            .collect();
        StoreSnapshot {
            local_revision: self.state.local_revision,
            feed: self.feed.clone(),
            fetch: self.state.fetch.clone(),
            statuses,
        }
    }
}

/// Single-process transaction boundary. Open in a background task after the app-data root exists.
/// Disk/cache errors remain feature-local; setup only installs the lightweight service.
pub struct AnnouncementStore {
    pub(super) files: StoreFiles,
    keys: BTreeMap<String, [u8; 32]>,
    inner: Mutex<Inner>,
}
impl AnnouncementStore {
    pub fn open(
        app_data_root: &Path,
        keys: BTreeMap<String, [u8; 32]>,
    ) -> Result<Self, StoreError> {
        let files = StoreFiles::open(app_data_root)?;
        let state = match files.read(&files.state_path(), MAX_STATE_BYTES)? {
            Some(bytes) => StoredState::decode(&bytes)?,
            None => {
                // A missing pointer alongside blobs is evidence of lost state, not a first launch.
                if files.has_feed_files()? {
                    return Err(StoreError::InvalidState);
                }
                let state = StoredState::empty();
                files.write(&files.state_path(), &state.encode()?, true)?;
                state
            }
        };
        let feed = if let Some(pointer) = &state.active_feed {
            let raw = files
                .read(
                    &files.feed_path(&pointer.payload_hash),
                    super::limits::MAX_ENVELOPE_BYTES,
                )?
                .ok_or(StoreError::InvalidState)?;
            let feed = StoredFeed::verify(&raw, &keys)?;
            if feed.payload_hash != pointer.payload_hash
                || feed.payload.sequence != pointer.sequence
            {
                return Err(StoreError::InvalidState);
            }
            state.check_active(&feed.payload)?;
            Some(Arc::new(feed))
        } else {
            None
        };
        Ok(Self {
            files,
            keys,
            inner: Mutex::new(Inner { state, feed }),
        })
    }
    pub fn snapshot(&self) -> Result<StoreSnapshot, StoreError> {
        Ok(self
            .inner
            .lock()
            .map_err(|_| StoreError::Poisoned)?
            .snapshot())
    }
    pub(super) fn revalidate_cached(
        &self,
        metadata: FetchMetadata,
    ) -> Result<StoreSnapshot, StoreError> {
        let snapshot = self.snapshot()?;
        let feed = snapshot.feed.ok_or(StoreError::CacheMissing)?;
        let raw = self
            .files
            .read(
                &self.files.feed_path(feed.payload_hash()),
                super::limits::MAX_ENVELOPE_BYTES,
            )?
            .ok_or(StoreError::CacheMissing)?;
        self.accept_envelope(&raw, metadata)
    }
    pub(super) fn collect_feed_cache(&self, pinned: Option<&str>) -> Result<(), StoreError> {
        let inner = self.inner.lock().map_err(|_| StoreError::Poisoned)?;
        let active = inner.feed.as_ref().map(|feed| feed.payload_hash());
        let directory = self.files.root.join("feeds");
        judgedesk_core::storage::validate_existing_directory_path(&directory)
            .map_err(|_| StoreError::UnsafePath)?;
        for (index, entry) in std::fs::read_dir(directory)?.enumerate() {
            if index >= 4096 {
                return Err(StoreError::StateLimit);
            }
            let entry = entry?;
            let name = entry.file_name();
            let Some(hash) = name.to_str().and_then(|name| name.strip_suffix(".json")) else {
                continue;
            };
            if hash.len() != 64 || !hash.bytes().all(super::model::lower_hex) {
                return Err(StoreError::InvalidState);
            }
            if Some(hash) == active || Some(hash) == pinned {
                continue;
            }
            let meta = std::fs::symlink_metadata(entry.path())?;
            if !meta.is_file() || judgedesk_core::storage::is_symlink_or_reparse_point(&meta) {
                return Err(StoreError::UnsafePath);
            }
            std::fs::remove_file(entry.path())?;
        }
        Ok(())
    }
    pub fn accept_envelope(
        &self,
        raw: &[u8],
        metadata: FetchMetadata,
    ) -> Result<StoreSnapshot, StoreError> {
        // Parsing/crypto/network work does not hold the mutation mutex.
        metadata.validate()?;
        let candidate = Arc::new(StoredFeed::verify(raw, &self.keys)?);
        self.files.checkpoint(Checkpoint::Verified)?;
        let mut inner = self.inner.lock().map_err(|_| StoreError::Poisoned)?;
        if let Some(active) = &inner.state.active_feed {
            if candidate.payload.sequence < active.sequence {
                return Err(StoreError::Rollback);
            }
            if candidate.payload.sequence == active.sequence
                && candidate.payload_hash != active.payload_hash
            {
                return Err(StoreError::Equivocation);
            }
        }
        let mut state = inner.state.clone();
        state.merge(&candidate.payload)?;
        state.active_feed = Some(FeedPointer {
            payload_hash: candidate.payload_hash.clone(),
            sequence: candidate.payload.sequence,
        });
        state.fetch = Some(metadata);
        let bytes = if state != inner.state {
            state.bump()?;
            Some(state.encode()?)
        } else {
            None
        };
        let path = self.files.feed_path(&candidate.payload_hash);
        if let Some(existing) = self.files.read(&path, super::limits::MAX_ENVELOPE_BYTES)? {
            let existing = StoredFeed::verify(&existing, &self.keys)?;
            if existing.payload_hash != candidate.payload_hash {
                return Err(StoreError::InvalidState);
            }
        } else {
            self.files.write(&path, &candidate.envelope, false)?;
        }
        self.files.checkpoint(Checkpoint::FeedStored)?;
        if let Some(bytes) = bytes {
            self.files.write(&self.files.state_path(), &bytes, true)?;
            inner.state = state;
        }
        inner.feed = Some(candidate);
        Ok(inner.snapshot())
    }
    fn mutate(
        &self,
        operation: impl FnOnce(&mut StoredState, Option<&StoredFeed>) -> Result<(), StoreError>,
    ) -> Result<StoreSnapshot, StoreError> {
        let mut inner = self.inner.lock().map_err(|_| StoreError::Poisoned)?;
        let mut state = inner.state.clone();
        operation(&mut state, inner.feed.as_deref())?;
        if state != inner.state {
            state.bump()?;
            self.files
                .write(&self.files.state_path(), &state.encode()?, true)?;
            inner.state = state;
        }
        Ok(inner.snapshot())
    }
    pub fn set_read(&self, uid: &str, read: bool, at: &str) -> Result<StoreSnapshot, StoreError> {
        super::model::timestamp(at)?;
        self.mutate(|state, feed| {
            if !feed.is_some_and(|feed| feed.payload.items.iter().any(|item| item.uid == uid)) {
                return Err(StoreError::UnknownUid);
            }
            let status = &mut state
                .uids
                .get_mut(uid)
                .ok_or(StoreError::UnknownUid)?
                .status;
            if status.deleted {
                return Err(StoreError::UnknownUid);
            }
            if read && status.read_at.is_none() {
                status.read_at = Some(at.into());
            }
            if !read {
                status.read_at = None;
            }
            Ok(())
        })
    }
    pub fn delete(&self, uid: &str) -> Result<StoreSnapshot, StoreError> {
        self.mutate(|state, _| {
            state
                .uids
                .get_mut(uid)
                .ok_or(StoreError::UnknownUid)?
                .status
                .deleted = true;
            Ok(())
        })
    }
    pub fn mark_all_read(&self, uids: &[String], at: &str) -> Result<StoreSnapshot, StoreError> {
        super::model::timestamp(at)?;
        if uids.len() > super::limits::MAX_ITEMS
            || uids.iter().any(|uid| !super::model::uuid_v4(uid))
        {
            return Err(StoreError::UnknownUid);
        }
        self.mutate(|state, _| {
            for uid in uids.iter().collect::<HashSet<_>>() {
                if let Some(record) = state.uids.get_mut(uid) {
                    if !record.status.deleted && record.status.read_at.is_none() {
                        record.status.read_at = Some(at.into());
                    }
                }
            }
            Ok(())
        })
    }
    #[cfg(test)]
    pub(super) fn set_hook(&mut self, hook: super::store_io::Hook) {
        self.files.hook = Some(hook);
    }
}
