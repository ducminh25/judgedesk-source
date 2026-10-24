use super::{AnnouncementContent, AnnouncementImage, AnnouncementItem, StoreSnapshot};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct PreviewContent {
    title: String,
    summary: String,
}
impl From<&AnnouncementContent> for PreviewContent {
    fn from(value: &AnnouncementContent) -> Self {
        Self {
            title: value.title.clone(),
            summary: value.summary.clone(),
        }
    }
}
#[derive(Debug, Clone, Serialize)]
pub struct PreviewLocales {
    vi: PreviewContent,
    #[serde(skip_serializing_if = "Option::is_none")]
    en: Option<PreviewContent>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    uid: String,
    revision: u64,
    published_at: String,
    updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    expires_at: Option<String>,
    content: PreviewLocales,
    read_at: Option<String>,
    deleted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    thumbnail: Option<AnnouncementImage>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub local_revision: u64,
    pub feed_hash: Option<String>,
    sequence: Option<u64>,
    checked_at: Option<String>,
    items: Vec<Preview>,
}
impl From<StoreSnapshot> for Snapshot {
    fn from(value: StoreSnapshot) -> Self {
        let items = value
            .feed
            .iter()
            .flat_map(|feed| &feed.payload().items)
            .filter_map(|item| {
                let status = value.statuses.get(&item.uid)?;
                Some(Preview {
                    uid: item.uid.clone(),
                    revision: item.revision,
                    published_at: item.published_at.clone(),
                    updated_at: item.updated_at.clone(),
                    expires_at: item.expires_at.clone(),
                    content: PreviewLocales {
                        vi: (&item.content.vi).into(),
                        en: item.content.en.as_ref().map(Into::into),
                    },
                    read_at: status.read_at.clone(),
                    deleted: status.deleted,
                    thumbnail: item
                        .thumbnail_id
                        .as_ref()
                        .and_then(|id| item.images.iter().find(|image| &image.id == id))
                        .cloned(),
                })
            })
            .collect();
        Self {
            local_revision: value.local_revision,
            feed_hash: value.feed.as_ref().map(|feed| feed.payload_hash().into()),
            sequence: value.feed.as_ref().map(|feed| feed.payload().sequence),
            checked_at: value.fetch.map(|fetch| fetch.checked_at),
            items,
        }
    }
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArticleView {
    pub view_id: String,
    pub feed_hash: String,
    pub item: AnnouncementItem,
}
