use reqwest::{
    header::{HeaderMap, CONTENT_ENCODING, CONTENT_TYPE, ETAG, LAST_MODIFIED},
    Client,
};
use std::{fmt, time::Duration};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum DownloadError {
    Network,
    Status(u16),
    Encoding,
    Size,
    Header,
}
impl fmt::Display for DownloadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Announcement download failed: {self:?}")
    }
}
impl std::error::Error for DownloadError {}

pub(super) enum Download {
    Modified {
        bytes: Vec<u8>,
        etag: Option<String>,
        last_modified: Option<String>,
        content_type: Option<String>,
    },
    NotModified {
        etag: Option<String>,
        last_modified: Option<String>,
    },
}

pub(super) fn client() -> Result<Client, DownloadError> {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        // Losing this race means another verified library installed the provider first.
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(10))
        .connect_timeout(Duration::from_secs(5))
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .no_zstd()
        .user_agent("JudgeDesk announcements/1")
        .build()
        .map_err(|_| DownloadError::Network)
}

fn header(
    headers: &HeaderMap,
    key: reqwest::header::HeaderName,
) -> Result<Option<String>, DownloadError> {
    let mut values = headers.get_all(key).iter();
    let Some(value) = values.next() else {
        return Ok(None);
    };
    if values.next().is_some() {
        return Err(DownloadError::Header);
    }
    let value = value.to_str().map_err(|_| DownloadError::Header)?;
    if value.is_empty() || value.len() > 4096 || !value.bytes().all(|b| (0x20..=0x7e).contains(&b))
    {
        return Err(DownloadError::Header);
    }
    Ok(Some(value.into()))
}

/// URL is supplied only by native code; no command accepts a URL. Test servers use a test client.
pub(super) async fn fetch(
    client: &Client,
    url: &str,
    headers: HeaderMap,
    maximum: usize,
) -> Result<Download, DownloadError> {
    let mut response = client
        .get(url)
        .headers(headers)
        .header("Accept-Encoding", "identity")
        .send()
        .await
        .map_err(|_| DownloadError::Network)?;
    let status = response.status().as_u16();
    if status != 200 && status != 304 {
        return Err(DownloadError::Status(status));
    }
    if header(response.headers(), CONTENT_ENCODING)?
        .is_some_and(|value| !value.eq_ignore_ascii_case("identity"))
    {
        return Err(DownloadError::Encoding);
    }
    let etag = header(response.headers(), ETAG)?;
    let last_modified = header(response.headers(), LAST_MODIFIED)?;
    if status == 304 {
        return Ok(Download::NotModified {
            etag,
            last_modified,
        });
    }
    let content_type = header(response.headers(), CONTENT_TYPE)?;
    if response
        .content_length()
        .is_some_and(|length| length > maximum as u64)
    {
        return Err(DownloadError::Size);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| DownloadError::Network)? {
        if chunk.len() > maximum.saturating_sub(bytes.len()) {
            return Err(DownloadError::Size);
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(Download::Modified {
        bytes,
        etag,
        last_modified,
        content_type,
    })
}
