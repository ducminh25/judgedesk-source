use super::{de, limits::*};
use chrono::{DateTime, SecondsFormat};
use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, fmt};

#[derive(Debug, PartialEq, Eq)]
pub enum PayloadError {
    Size,
    InvalidJson,
    Metadata(&'static str),
}

impl fmt::Display for PayloadError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Size => formatter.write_str("Announcement payload exceeds its byte limits."),
            Self::InvalidJson => formatter.write_str("Announcement payload JSON is invalid."),
            Self::Metadata(field) => {
                write!(formatter, "Announcement metadata is invalid: {field}.")
            }
        }
    }
}
impl std::error::Error for PayloadError {}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AnnouncementPayload {
    #[serde(deserialize_with = "de::safe_integer")]
    pub schema_version: u64,
    pub feed_id: String,
    #[serde(deserialize_with = "de::safe_integer")]
    pub sequence: u64,
    pub generated_at: String,
    #[serde(deserialize_with = "de::objects")]
    pub items: Vec<AnnouncementItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AnnouncementItem {
    pub uid: String,
    #[serde(deserialize_with = "de::safe_integer")]
    pub revision: u64,
    pub published_at: String,
    pub updated_at: String,
    #[serde(
        default,
        deserialize_with = "de::optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub expires_at: Option<String>,
    #[serde(deserialize_with = "de::object")]
    pub content: AnnouncementLocales,
    #[serde(deserialize_with = "de::objects")]
    pub images: Vec<AnnouncementImage>,
    #[serde(deserialize_with = "de::objects")]
    pub links: Vec<AnnouncementLink>,
    #[serde(
        default,
        deserialize_with = "de::optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub thumbnail_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AnnouncementLocales {
    #[serde(deserialize_with = "de::object")]
    pub vi: AnnouncementContent,
    #[serde(
        default,
        deserialize_with = "de::optional_object",
        skip_serializing_if = "Option::is_none"
    )]
    pub en: Option<AnnouncementContent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AnnouncementContent {
    pub title: String,
    pub summary: String,
    /// Untrusted HTML even after metadata/signature validation. Sanitize before rendering.
    pub html: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AnnouncementImage {
    pub id: String,
    pub sha256: String,
    #[serde(deserialize_with = "de::safe_integer")]
    pub size_bytes: u64,
    pub mime: String,
    pub extension: String,
    pub role: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AnnouncementLink {
    pub id: String,
    pub url: String,
}

fn require(condition: bool, field: &'static str) -> Result<(), PayloadError> {
    if condition {
        Ok(())
    } else {
        Err(PayloadError::Metadata(field))
    }
}

pub(super) fn lower_hex(byte: u8) -> bool {
    byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
}

fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.as_bytes()[0].is_ascii_lowercase()
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-')
        })
}

pub(super) fn uuid_v4(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes[14] == b'4'
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b')
        && bytes.iter().enumerate().all(|(index, &byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                lower_hex(byte)
            }
        })
}

pub(super) fn timestamp(value: &str) -> Result<(), PayloadError> {
    require(
        value.len() == 24
            && value.bytes().enumerate().all(|(index, byte)| match index {
                4 | 7 => byte == b'-',
                10 => byte == b'T',
                13 | 16 => byte == b':',
                19 => byte == b'.',
                23 => byte == b'Z',
                _ => byte.is_ascii_digit(),
            }),
        "timestamp",
    )?;
    let parsed =
        DateTime::parse_from_rfc3339(value).map_err(|_| PayloadError::Metadata("timestamp"))?;
    require(
        parsed.timestamp_subsec_nanos() < 1_000_000_000
            && parsed.to_rfc3339_opts(SecondsFormat::Millis, true) == value,
        "timestamp",
    )
}

fn ecmascript_whitespace(character: char) -> bool {
    // Match JS String.trim(), not Rust's Unicode White_Space (notably BOM and NEL differ).
    matches!(character, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}'
        | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
        | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

fn text(value: &str, maximum: usize) -> bool {
    value.chars().count() <= maximum
        && value
            .chars()
            .any(|character| !ecmascript_whitespace(character))
}

pub(super) fn approved_link(value: &str) -> bool {
    if value.chars().count() > 2048
        || value
            .chars()
            .any(|c| c == '\\' || c <= '\u{0020}' || c == '\u{007f}')
    {
        return false;
    }
    let Ok(url) = tauri::Url::parse(value) else {
        return false;
    };
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.as_str() != value
    {
        return false;
    }
    let prefix = match url.host_str() {
        Some("github.com") => "/ducminh25/judgedesk",
        Some("ducminh25.github.io") => "/judgedesk",
        _ => return false,
    };
    if url.path() != prefix
        && !url
            .path()
            .strip_prefix(prefix)
            .is_some_and(|suffix| suffix.starts_with('/'))
    {
        return false;
    }
    url.path().split('/').all(|segment| {
        let Ok(decoded) = percent_decode_str(segment).decode_utf8() else {
            return false;
        };
        decoded != "."
            && decoded != ".."
            && !decoded
                .chars()
                .any(|c| matches!(c, '/' | '%' | '\\') || c <= '\u{001f}' || c == '\u{007f}')
    })
}

fn validate_item(item: &AnnouncementItem) -> Result<(), PayloadError> {
    require(uuid_v4(&item.uid), "UID")?;
    timestamp(&item.published_at)?;
    timestamp(&item.updated_at)?;
    require(item.updated_at >= item.published_at, "updatedAt")?;
    if let Some(expiry) = &item.expires_at {
        timestamp(expiry)?;
        require(expiry > &item.published_at, "expiresAt")?;
    }
    for content in std::iter::once(&item.content.vi).chain(item.content.en.iter()) {
        require(text(&content.title, 200), "title")?;
        require(text(&content.summary, 500), "summary")?;
        require(
            text(&content.html, MAX_HTML_BYTES) && content.html.len() <= MAX_HTML_BYTES,
            "html",
        )?;
    }
    require(item.images.len() <= MAX_ARTICLE_IMAGES + 1, "images")?;
    let mut image_ids = HashSet::new();
    let mut article_images = 0;
    let mut thumbnail = None;
    for image in &item.images {
        require(
            identifier(&image.id) && image_ids.insert(&image.id),
            "image ID",
        )?;
        require(
            image.sha256.len() == 64 && image.sha256.bytes().all(lower_hex),
            "image hash",
        )?;
        require(image.size_bytes <= MAX_IMAGE_BYTES, "image size")?;
        require(
            matches!(
                (image.mime.as_str(), image.extension.as_str()),
                ("image/jpeg", "jpg") | ("image/png", "png")
            ),
            "image format",
        )?;
        match image.role.as_str() {
            "article" => article_images += 1,
            "thumbnail" => {
                require(
                    thumbnail.is_none() && image.size_bytes <= MAX_THUMBNAIL_BYTES,
                    "thumbnail",
                )?;
                thumbnail = Some(image.id.as_str());
            }
            _ => return Err(PayloadError::Metadata("image role")),
        }
    }
    require(article_images <= MAX_ARTICLE_IMAGES, "image count")?;
    require(item.thumbnail_id.as_deref() == thumbnail, "thumbnailId")?;
    require(item.links.len() <= MAX_LINKS, "links")?;
    let mut link_ids = HashSet::new();
    for link in &item.links {
        require(identifier(&link.id) && link_ids.insert(&link.id), "link ID")?;
        require(approved_link(&link.url), "link URL")?;
    }
    Ok(())
}

/// Parse/validate bounded metadata only. Call after signature verification; HTML remains untrusted.
/// Do not first convert raw JSON to Value: that would discard duplicate-key evidence.
pub fn parse_payload(raw: &[u8]) -> Result<AnnouncementPayload, PayloadError> {
    if raw.is_empty() || raw.len() > MAX_PAYLOAD_BYTES {
        return Err(PayloadError::Size);
    }
    let text = std::str::from_utf8(raw).map_err(|_| PayloadError::InvalidJson)?;
    let mut deserializer = serde_json::Deserializer::from_str(text);
    let payload: AnnouncementPayload =
        de::object(&mut deserializer).map_err(|_| PayloadError::InvalidJson)?;
    deserializer.end().map_err(|_| PayloadError::InvalidJson)?;
    require(
        payload.schema_version == 1 && payload.feed_id == "judgedesk-announcements",
        "schema/feed ID",
    )?;
    timestamp(&payload.generated_at)?;
    require(payload.items.len() <= MAX_ITEMS, "items")?;
    let mut uids = HashSet::new();
    for item in &payload.items {
        require(uids.insert(&item.uid), "duplicate UID")?;
        validate_item(item)?;
    }
    // Also match the publisher's compact serialized-byte cap (numeric tokens may expand).
    let serialized = serde_json::to_vec(&payload).map_err(|_| PayloadError::InvalidJson)?;
    if serialized.len() > MAX_PAYLOAD_BYTES {
        return Err(PayloadError::Size);
    }
    Ok(payload)
}
