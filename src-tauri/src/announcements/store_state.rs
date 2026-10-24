use super::store::StoreError;
use super::{de, model, AnnouncementItem, AnnouncementPayload};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub(super) const MAX_STATE_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FetchMetadata {
    pub checked_at: String,
    #[serde(deserialize_with = "de::required_nullable")]
    pub etag: Option<String>,
    #[serde(deserialize_with = "de::required_nullable")]
    pub last_modified: Option<String>,
}
impl FetchMetadata {
    pub(super) fn validate(&self) -> Result<(), StoreError> {
        model::timestamp(&self.checked_at)?;
        for value in [&self.etag, &self.last_modified].into_iter().flatten() {
            if value.is_empty()
                || value.len() > 4096
                || !value.bytes().all(|b| (0x20..=0x7e).contains(&b))
            {
                return Err(StoreError::InvalidState);
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ReadState {
    #[serde(deserialize_with = "de::required_nullable")]
    pub read_at: Option<String>,
    pub deleted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct UidRecord {
    #[serde(deserialize_with = "de::object")]
    pub status: ReadState,
    #[serde(deserialize_with = "de::safe_integer")]
    pub revision: u64,
    pub published_at: String,
    pub item_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct FeedPointer {
    pub payload_hash: String,
    #[serde(deserialize_with = "de::safe_integer")]
    pub sequence: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct StoredState {
    #[serde(deserialize_with = "de::safe_integer")]
    pub schema_version: u64,
    #[serde(deserialize_with = "de::safe_integer")]
    pub local_revision: u64,
    // This single pointer is also the highest accepted sequence/hash; never persisted separately.
    #[serde(deserialize_with = "de::nullable_object")]
    pub active_feed: Option<FeedPointer>,
    #[serde(deserialize_with = "de::nullable_object")]
    pub fetch: Option<FetchMetadata>,
    #[serde(deserialize_with = "de::unique_objects")]
    pub uids: BTreeMap<String, UidRecord>,
}

pub(super) fn hash(bytes: &[u8]) -> String {
    ring::digest::digest(&ring::digest::SHA256, bytes)
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
pub(super) fn valid_hash(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(model::lower_hex)
}
fn item_hash(item: &AnnouncementItem) -> Result<String, StoreError> {
    Ok(hash(
        &serde_json::to_vec(item).map_err(|_| StoreError::InvalidState)?,
    ))
}

impl StoredState {
    pub fn empty() -> Self {
        Self {
            schema_version: 1,
            local_revision: 1,
            active_feed: None,
            fetch: None,
            uids: BTreeMap::new(),
        }
    }
    pub fn decode(bytes: &[u8]) -> Result<Self, StoreError> {
        if bytes.len() > MAX_STATE_BYTES {
            return Err(StoreError::StateLimit);
        }
        let mut parser = serde_json::Deserializer::from_slice(bytes);
        let state: Self = de::object(&mut parser).map_err(|_| StoreError::InvalidState)?;
        parser.end().map_err(|_| StoreError::InvalidState)?;
        if state.schema_version != 1
            || state.active_feed.is_some() != state.fetch.is_some()
            || (state.active_feed.is_none() && !state.uids.is_empty())
        {
            return Err(StoreError::InvalidState);
        }
        if let Some(feed) = &state.active_feed {
            if !valid_hash(&feed.payload_hash) {
                return Err(StoreError::InvalidState);
            }
        }
        if let Some(fetch) = &state.fetch {
            fetch.validate()?;
        }
        for (uid, record) in &state.uids {
            if !model::uuid_v4(uid) || !valid_hash(&record.item_hash) {
                return Err(StoreError::InvalidState);
            }
            model::timestamp(&record.published_at)?;
            if let Some(at) = &record.status.read_at {
                model::timestamp(at)?;
            }
        }
        Ok(state)
    }
    pub fn encode(&self) -> Result<Vec<u8>, StoreError> {
        let bytes = serde_json::to_vec(self).map_err(|_| StoreError::InvalidState)?;
        if bytes.len() > MAX_STATE_BYTES {
            return Err(StoreError::StateLimit);
        }
        Ok(bytes)
    }
    pub fn bump(&mut self) -> Result<(), StoreError> {
        if self.local_revision >= de::MAX_SAFE_INTEGER {
            return Err(StoreError::CounterLimit);
        }
        self.local_revision += 1;
        Ok(())
    }
    pub fn check_active(&self, payload: &AnnouncementPayload) -> Result<(), StoreError> {
        for item in &payload.items {
            let record = self.uids.get(&item.uid).ok_or(StoreError::InvalidState)?;
            if record.revision != item.revision
                || record.published_at != item.published_at
                || record.item_hash != item_hash(item)?
            {
                return Err(StoreError::InvalidState);
            }
        }
        Ok(())
    }
    pub fn merge(&mut self, payload: &AnnouncementPayload) -> Result<(), StoreError> {
        for item in &payload.items {
            let fingerprint = item_hash(item)?;
            if let Some(record) = self.uids.get_mut(&item.uid) {
                if record.published_at != item.published_at
                    || item.revision < record.revision
                    || (item.revision == record.revision && record.item_hash != fingerprint)
                {
                    return Err(StoreError::ItemHistory);
                }
                record.revision = item.revision;
                record.item_hash = fingerprint;
            } else {
                self.uids.insert(
                    item.uid.clone(),
                    UidRecord {
                        status: ReadState {
                            read_at: None,
                            deleted: false,
                        },
                        revision: item.revision,
                        published_at: item.published_at.clone(),
                        item_hash: fingerprint,
                    },
                );
            }
        }
        Ok(())
    }
}
