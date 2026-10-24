use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;

type TestResult = Result<(), Box<dyn std::error::Error>>;

#[derive(Deserialize)]
struct Case {
    name: String,
    json: String,
    #[serde(default)]
    valid: bool,
    normalized: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Corpus {
    cases: Vec<Case>,
    native_only_reject: Vec<Case>,
}

fn corpus() -> Result<Corpus, serde_json::Error> {
    serde_json::from_str(include_str!(
        "../../../shared/test-fixtures/announcements/payload-validation.json"
    ))
}

fn golden_bytes() -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../shared/test-fixtures/announcements/signed-feed.json"
    ))?;
    Ok(STANDARD.decode(
        fixture["envelope"]["payloadBase64"]
            .as_str()
            .ok_or("payload")?,
    )?)
}

#[test]
fn metadata_agrees_with_shared_node_contract_cases() -> TestResult {
    let corpus = corpus()?;
    assert!(corpus.cases.len() >= 130);
    let mut mismatches = Vec::new();
    for case in &corpus.cases {
        let result = parse_payload(case.json.as_bytes());
        if result.is_ok() != case.valid {
            mismatches.push(format!(
                "{}: expected {}, got {:?}",
                case.name,
                case.valid,
                result.as_ref().err()
            ));
        }
        if let (Ok(payload), Some(normalized)) = (result, &case.normalized) {
            let expected: serde_json::Value = serde_json::from_str(normalized)?;
            if serde_json::to_value(payload)? != expected {
                mismatches.push(format!("{}: parsed values differ from Node", case.name));
            }
        }
    }
    assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
    Ok(())
}

#[test]
fn rejects_native_duplicate_keys_without_collapsing_them_to_a_value() -> TestResult {
    let corpus = corpus()?;
    for case in &corpus.native_only_reject {
        assert!(
            parse_payload(case.json.as_bytes()).is_err(),
            "{}",
            case.name
        );
    }
    let media = &corpus
        .cases
        .iter()
        .find(|case| case.name == "JPG PNG article and dedicated thumbnail")
        .ok_or("media case")?
        .json;
    let duplicate_image = media.replacen(
        "\"sizeBytes\":1024",
        "\"sizeBytes\":1024,\"sizeBytes\":1024",
        1,
    );
    assert_ne!(duplicate_image, *media);
    assert!(parse_payload(duplicate_image.as_bytes()).is_err());
    let links = &corpus
        .cases
        .iter()
        .find(|case| case.name == "URL https://github.com/ducminh25/judgedesk")
        .ok_or("link case")?
        .json;
    let duplicate_link = links.replacen(
        "\"url\":",
        "\"url\":\"https://github.com/ducminh25/judgedesk\",\"url\":",
        1,
    );
    assert_ne!(duplicate_link, *links);
    assert!(parse_payload(duplicate_link.as_bytes()).is_err());
    Ok(())
}

#[test]
fn raw_payload_is_fatal_utf8_no_bom_no_trailing_value_and_bounded_before_parsing() -> TestResult {
    let raw = golden_bytes()?;
    for bytes in [
        vec![0xff],
        [b"\xef\xbb\xbf".as_slice(), &raw].concat(),
        [raw.as_slice(), b" {}"].concat(),
    ] {
        assert!(parse_payload(&bytes).is_err());
    }
    let mut bounded = raw;
    bounded.resize(1024 * 1024, b' ');
    assert!(parse_payload(&bounded).is_ok());
    bounded.push(b' ');
    assert_eq!(parse_payload(&bounded).err(), Some(PayloadError::Size));
    assert!(parse_payload(b"").is_err());
    Ok(())
}

#[test]
fn parsed_model_serializes_to_the_same_wire_shape_without_sanitizing_html() -> TestResult {
    let raw = golden_bytes()?;
    let payload = parse_payload(&raw)?;
    assert_eq!(payload.schema_version, 1);
    assert_eq!(payload.items[0].content.vi.title, "Thông báo mới");
    let value: serde_json::Value = serde_json::from_slice(&raw)?;
    assert_eq!(serde_json::to_value(&payload)?, value);
    let corpus = corpus()?;
    let unsafe_html = &corpus
        .cases
        .iter()
        .find(|case| case.name == "metadata validation does not sanitize")
        .ok_or("HTML case")?
        .json;
    let payload = parse_payload(unsafe_html.as_bytes())?;
    assert!(payload.items[0].content.vi.html.contains("onclick="));
    Ok(())
}

#[test]
fn aggregate_utf8_limit_applies_even_when_each_locale_is_in_bounds() -> TestResult {
    let mut value: serde_json::Value = serde_json::from_slice(&golden_bytes()?)?;
    let original = value["items"][0].clone();
    value["items"] = (0..20)
        .map(|index| {
            let mut item = original.clone();
            item["uid"] = format!("{index:08x}-0000-4000-8000-000000000000").into();
            item["content"]["vi"]["html"] = "x".repeat(65536).into();
            item
        })
        .collect();
    assert_eq!(
        parse_payload(&serde_json::to_vec(&value)?).err(),
        Some(PayloadError::Size)
    );
    Ok(())
}

#[test]
fn compact_serialized_size_is_bounded_even_when_numeric_tokens_expand() -> TestResult {
    let mut value: serde_json::Value = serde_json::from_slice(&golden_bytes()?)?;
    let original = value["items"][0].clone();
    value["items"] = (0..16)
        .map(|index| {
            let mut item = original.clone();
            item["uid"] = format!("{index:08x}-0000-4000-8000-000000000000").into();
            item["revision"] = 1_000_000.into();
            item["content"]["vi"]["html"] = "x".repeat(65536).into();
            item
        })
        .collect();
    let maximum = 1024 * 1024;
    let excess = serde_json::to_vec(&value)?.len() - (maximum + 1);
    value["items"][15]["content"]["vi"]["html"] = "x".repeat(65536 - excess).into();
    let serialized = serde_json::to_string(&value)?;
    assert_eq!(serialized.len(), maximum + 1);
    let compact_input = serialized.replace("\"revision\":1000000", "\"revision\":1e6");
    assert!(compact_input.len() <= maximum);
    assert_eq!(
        parse_payload(compact_input.as_bytes()).err(),
        Some(PayloadError::Size)
    );
    Ok(())
}

#[test]
fn signed_empty_feed_is_valid_but_authenticity_does_not_bypass_metadata_validation() -> TestResult {
    use ring::signature::KeyPair;
    use std::collections::BTreeMap;
    let pkcs8 = ring::signature::Ed25519KeyPair::generate_pkcs8(&ring::rand::SystemRandom::new())
        .map_err(|_| "key generation")?;
    let key =
        ring::signature::Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).map_err(|_| "key format")?;
    let trusted = BTreeMap::from([(
        "test-only".to_owned(),
        key.public_key().as_ref().try_into()?,
    )]);
    let mut payload: serde_json::Value = serde_json::from_slice(&golden_bytes()?)?;
    payload["items"] = serde_json::json!([]);
    for (version, valid) in [(1, true), (2, false)] {
        payload["schemaVersion"] = version.into();
        let bytes = serde_json::to_vec(&payload)?;
        let message = [
            b"JudgeDesk announcements v1\ntest-only\n".as_slice(),
            &bytes,
        ]
        .concat();
        let envelope = serde_json::json!({
            "format": "judgedesk-announcements-v1", "keyId": "test-only",
            "payloadBase64": STANDARD.encode(&bytes),
            "signatureBase64": STANDARD.encode(key.sign(&message).as_ref()),
        });
        let verified = verify_signed_envelope(&serde_json::to_vec(&envelope)?, &trusted)?;
        assert_eq!(verified, bytes);
        assert_eq!(parse_payload(&verified).is_ok(), valid);
    }
    Ok(())
}
