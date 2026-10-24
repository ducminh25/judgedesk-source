use super::{store_state::hash, AnnouncementImage};
use image::{ImageDecoder, ImageFormat};
use std::{fmt, io::Cursor};

#[derive(Debug)]
pub(super) struct MediaError;
impl fmt::Display for MediaError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Announcement image failed integrity, format or resource validation")
    }
}
impl std::error::Error for MediaError {}

fn decode(decoder: impl ImageDecoder, thumbnail: bool) -> Result<(u32, u32), MediaError> {
    let (width, height) = decoder.dimensions();
    let side = if thumbnail { 320 } else { 8192 };
    if width == 0
        || height == 0
        || width > side
        || height > side
        || u64::from(width) * u64::from(height) > 12_000_000
        || decoder.total_bytes() > 64 * 1024 * 1024
    {
        return Err(MediaError);
    }
    // Validate the full compressed stream. No second RGBA conversion/allocation is needed.
    image::DynamicImage::from_decoder(decoder).map_err(|_| MediaError)?;
    Ok((width, height))
}

/// Called inside the service's single blocking decoder permit, including cache reads.
pub(super) fn validate_image(
    bytes: &[u8],
    metadata: &AnnouncementImage,
) -> Result<(u32, u32), MediaError> {
    let thumbnail = metadata.role == "thumbnail";
    let maximum = if thumbnail {
        128 * 1024
    } else {
        4 * 1024 * 1024
    };
    if bytes.len() > maximum
        || bytes.len() as u64 != metadata.size_bytes
        || hash(bytes) != metadata.sha256
    {
        return Err(MediaError);
    }
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(if thumbnail { 320 } else { 8192 });
    limits.max_image_height = limits.max_image_width;
    // Best effort internal allocator limit; explicit pixel/output checks above are also required.
    limits.max_alloc = Some(64 * 1024 * 1024);
    match (
        metadata.mime.as_str(),
        metadata.extension.as_str(),
        image::guess_format(bytes).map_err(|_| MediaError)?,
    ) {
        ("image/png", "png", ImageFormat::Png) => {
            let decoder = image::codecs::png::PngDecoder::with_limits(Cursor::new(bytes), limits)
                .map_err(|_| MediaError)?;
            if decoder.is_apng().map_err(|_| MediaError)? {
                return Err(MediaError);
            }
            decode(decoder, thumbnail)
        }
        ("image/jpeg", "jpg", ImageFormat::Jpeg) => {
            let mut decoder = image::codecs::jpeg::JpegDecoder::new(Cursor::new(bytes))
                .map_err(|_| MediaError)?;
            decoder.set_limits(limits).map_err(|_| MediaError)?;
            decode(decoder, thumbnail)
        }
        _ => Err(MediaError),
    }
}
