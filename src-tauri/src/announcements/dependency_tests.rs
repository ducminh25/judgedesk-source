//! API probes, not the production transport/media policy or a WebView runtime acceptance test.
use std::io::Cursor;
type TestResult = Result<(), Box<dyn std::error::Error>>;

#[tokio::test]
async fn approved_tls_graph_builds_https_only_client_without_a_second_provider() -> TestResult {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        // Concurrent initialization can lose only to an already installed provider.
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    assert!(rustls::crypto::CryptoProvider::get_default().is_some());
    let client = reqwest::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(10))
        .connect_timeout(std::time::Duration::from_secs(5))
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .no_zstd()
        .build()?;
    // Reject before connecting; no network or local HTTP server is required by the normal suite.
    let error = client
        .get("http://127.0.0.1:9/")
        .send()
        .await
        .err()
        .ok_or("HTTP accepted")?;
    assert!(error.is_builder(), "{error}");
    Ok(())
}

#[test]
fn approved_image_features_decode_jpg_png_and_expose_strict_dimension_controls() -> TestResult {
    use image::{ImageDecoder, ImageEncoder};
    let mut png = Vec::new();
    image::codecs::png::PngEncoder::new(&mut png).write_image(
        &[12, 34, 56, 255],
        1,
        1,
        image::ExtendedColorType::Rgba8,
    )?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(1);
    limits.max_image_height = Some(1);
    limits.max_alloc = Some(64 * 1024 * 1024);
    let decoder = image::codecs::png::PngDecoder::with_limits(Cursor::new(&png), limits.clone())?;
    assert!(!decoder.is_apng()?);
    assert_eq!(decoder.dimensions(), (1, 1));
    assert_eq!(decoder.total_bytes(), 4);
    assert_eq!(
        image::DynamicImage::from_decoder(decoder)?
            .into_rgba8()
            .as_raw(),
        &[12, 34, 56, 255]
    );
    let mut jpeg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new(&mut jpeg).write_image(
        &[12, 34, 56],
        1,
        1,
        image::ExtendedColorType::Rgb8,
    )?;
    let mut decoder = image::codecs::jpeg::JpegDecoder::new(Cursor::new(&jpeg))?;
    decoder.set_limits(limits.clone())?;
    assert_eq!(decoder.total_bytes(), 3);
    assert_eq!(image::DynamicImage::from_decoder(decoder)?.width(), 1);
    limits.max_image_width = Some(0);
    assert!(
        image::codecs::png::PngDecoder::with_limits(Cursor::new(&png), limits.clone()).is_err()
    );
    let mut decoder = image::codecs::jpeg::JpegDecoder::new(Cursor::new(&jpeg))?;
    assert!(decoder.set_limits(limits).is_err());
    Ok(())
}

#[test]
fn binary_ipc_response_keeps_raw_bytes_instead_of_a_json_array() -> TestResult {
    use tauri::ipc::{InvokeResponseBody, IpcResponse, Response};
    let bytes = vec![0, 127, 128, 255];
    match Response::new(bytes.clone()).body()? {
        InvokeResponseBody::Raw(actual) => assert_eq!(actual, bytes),
        InvokeResponseBody::Json(_) => return Err("binary response became JSON".into()),
    }
    Ok(())
}
