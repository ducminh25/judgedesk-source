use super::{media::validate_image, store_state::hash, AnnouncementImage};
use image::ImageEncoder;
type TestResult = Result<(), Box<dyn std::error::Error>>;

#[test]
fn maximal_size_reference_corpus_decodes_png_baseline_progressive_and_cmyk_jpeg() -> TestResult {
    for (name, extension, bytes) in [
        (
            "rgba-png",
            "png",
            include_bytes!("../../../shared/test-fixtures/announcements/media-corpus/rgba.png")
                .as_slice(),
        ),
        (
            "rgb-baseline",
            "jpg",
            include_bytes!(
                "../../../shared/test-fixtures/announcements/media-corpus/rgb-baseline.jpg"
            )
            .as_slice(),
        ),
        (
            "rgb-progressive",
            "jpg",
            include_bytes!(
                "../../../shared/test-fixtures/announcements/media-corpus/rgb-progressive.jpg"
            )
            .as_slice(),
        ),
        (
            "cmyk-progressive",
            "jpg",
            include_bytes!(
                "../../../shared/test-fixtures/announcements/media-corpus/cmyk-progressive.jpg"
            )
            .as_slice(),
        ),
    ] {
        let start = std::time::Instant::now();
        assert_eq!(
            validate_image(bytes, &metadata(bytes, extension, false))?,
            (4000, 3000)
        );
        println!(
            "ANNOUNCEMENT_MEDIA_REFERENCE={}",
            serde_json::json!({"name":name,"inputBytes":bytes.len(),"pixels":12_000_000,"decodeMs":start.elapsed().as_millis()})
        );
    }
    Ok(())
}

#[test]
fn publisher_golden_html_and_media_verify_and_decode_in_the_native_app() -> TestResult {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let golden: serde_json::Value = serde_json::from_str(include_str!(
        "../../../shared/test-fixtures/announcements/publisher-feed.json"
    ))?;
    let key: [u8; 32] = STANDARD
        .decode(golden["publicKeyBase64"].as_str().ok_or("key")?)?
        .try_into()
        .map_err(|_| "key length")?;
    let keys =
        std::collections::BTreeMap::from([(golden["keyId"].as_str().ok_or("id")?.into(), key)]);
    let raw = super::verify_signed_envelope(&serde_json::to_vec(&golden["envelope"])?, &keys)?;
    let payload = super::parse_payload(&raw)?;
    assert_eq!(payload.items.len(), 1);
    let item = &payload.items[0];
    assert!(item.content.en.is_some());
    assert!(!item.content.vi.html.contains("onclick"));
    assert_eq!(item.images.len(), 2);
    let bytes = include_bytes!("../../../shared/test-fixtures/announcements/publisher-photo.png");
    for image in &item.images {
        assert_eq!(validate_image(bytes, image)?, (320, 180));
    }
    Ok(())
}

fn metadata(bytes: &[u8], extension: &str, thumbnail: bool) -> AnnouncementImage {
    AnnouncementImage {
        id: "photo".into(),
        sha256: hash(bytes),
        size_bytes: bytes.len() as u64,
        mime: if extension == "png" {
            "image/png"
        } else {
            "image/jpeg"
        }
        .into(),
        extension: extension.into(),
        role: if thumbnail { "thumbnail" } else { "article" }.into(),
    }
}
fn png(width: u32, height: u32) -> Result<Vec<u8>, image::ImageError> {
    let mut bytes = Vec::new();
    image::codecs::png::PngEncoder::new(&mut bytes).write_image(
        &vec![0; width as usize * height as usize * 4],
        width,
        height,
        image::ExtendedColorType::Rgba8,
    )?;
    Ok(bytes)
}
#[test]
fn media_checks_signed_bytes_sniff_and_complete_decode() -> TestResult {
    let animation =
        include_bytes!("../../../shared/test-fixtures/announcements/one-frame-apng.png");
    let decoder = image::codecs::png::PngDecoder::new(std::io::Cursor::new(animation))?;
    assert!(decoder.is_apng()?);
    assert!(validate_image(animation, &metadata(animation, "png", false)).is_err());
    let bytes = png(2, 3)?;
    let mut meta = metadata(&bytes, "png", false);
    assert_eq!(validate_image(&bytes, &meta)?, (2, 3));
    meta.sha256 = "0".repeat(64);
    assert!(validate_image(&bytes, &meta).is_err());
    meta = metadata(&bytes, "png", false);
    meta.size_bytes += 1;
    assert!(validate_image(&bytes, &meta).is_err());
    assert!(validate_image(&bytes, &metadata(&bytes, "jpg", false)).is_err());
    for raw in [
        b"<html>bad</html>".as_slice(),
        b"GIF89a",
        &bytes[..bytes.len() / 2],
    ] {
        assert!(validate_image(raw, &metadata(raw, "png", false)).is_err());
    }
    let mut jpeg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new(&mut jpeg).write_image(
        &[12, 34, 56],
        1,
        1,
        image::ExtendedColorType::Rgb8,
    )?;
    assert_eq!(
        validate_image(&jpeg, &metadata(&jpeg, "jpg", false))?,
        (1, 1)
    );
    Ok(())
}
#[test]
fn media_enforces_dedicated_thumbnail_and_article_dimension_limits() -> TestResult {
    for (width, height, thumbnail, accepted) in [
        (320, 320, true, true),
        (321, 1, true, false),
        (8192, 1, false, true),
        (8193, 1, false, false),
        (4000, 3000, false, true),
        (4001, 3000, false, false),
    ] {
        let bytes = png(width, height)?;
        assert_eq!(
            validate_image(&bytes, &metadata(&bytes, "png", thumbnail)).is_ok(),
            accepted,
            "{width}x{height}, thumbnail={thumbnail}"
        );
    }
    Ok(())
}
