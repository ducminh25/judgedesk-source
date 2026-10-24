use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use ring::signature::KeyPair;
use serde::Deserialize;
use std::collections::BTreeMap;

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error>>;
type TrustedKeys = BTreeMap<String, [u8; 32]>;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    public_key_raw_base64: String,
    payload_sha256: String,
    envelope: serde_json::Value,
}

fn fixture() -> TestResult<(Fixture, TrustedKeys)> {
    let fixture: Fixture = serde_json::from_str(include_str!(
        "../../../shared/test-fixtures/announcements/signed-feed.json"
    ))?;
    let key = STANDARD.decode(&fixture.public_key_raw_base64)?;
    let key_id = fixture.envelope["keyId"].as_str().ok_or("missing key ID")?;
    let keys = BTreeMap::from([(key_id.to_owned(), key.try_into().map_err(|_| "key size")?)]);
    Ok((fixture, keys))
}

#[test]
fn verifies_node_golden_vector_and_preserves_original_bytes() -> TestResult {
    let (fixture, keys) = fixture()?;
    let verified = verify_signed_envelope(&serde_json::to_vec(&fixture.envelope)?, &keys)?;
    let expected = STANDARD.decode(
        fixture.envelope["payloadBase64"]
            .as_str()
            .ok_or("payload")?,
    )?;
    assert_eq!(verified, expected);
    let hash: String = ring::digest::digest(&ring::digest::SHA256, &verified)
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    assert_eq!(hash, fixture.payload_sha256);
    Ok(())
}

#[test]
fn rejects_unknown_keys_wrong_keys_changed_key_ids_and_tampering() -> TestResult {
    let (fixture, keys) = fixture()?;
    let raw = serde_json::to_vec(&fixture.envelope)?;
    assert_eq!(
        verify_signed_envelope(&raw, &BTreeMap::new()),
        Err(VerifyError::UntrustedKey)
    );
    let key_id = fixture.envelope["keyId"].as_str().ok_or("key ID")?;
    let wrong = BTreeMap::from([(key_id.to_owned(), [0u8; 32])]);
    assert_eq!(
        verify_signed_envelope(&raw, &wrong),
        Err(VerifyError::InvalidSignature)
    );
    for (field, value) in [
        ("payloadBase64", STANDARD.encode(b"{}")),
        ("signatureBase64", STANDARD.encode([0u8; 64])),
        ("keyId", "other-key".to_owned()),
    ] {
        let mut envelope = fixture.envelope.clone();
        envelope[field] = value.into();
        let mut trusted = keys.clone();
        trusted.insert("other-key".into(), *keys.get(key_id).ok_or("key")?);
        assert_eq!(
            verify_signed_envelope(&serde_json::to_vec(&envelope)?, &trusted),
            Err(VerifyError::InvalidSignature),
            "{field}"
        );
    }
    Ok(())
}

#[test]
fn rejects_duplicate_unknown_missing_or_mistyped_envelope_fields() -> TestResult {
    let (fixture, keys) = fixture()?;
    let raw = serde_json::to_string(&fixture.envelope)?;
    for prefix in [
        r#"{"keyId":"other-key","#,
        r#"{"key\u0049d":"other-key","#,
        r#"{"extra":true,"#,
    ] {
        let duplicated = format!("{prefix}{}", &raw[1..]);
        assert_eq!(
            verify_signed_envelope(duplicated.as_bytes(), &keys),
            Err(VerifyError::InvalidEnvelope)
        );
    }
    for replacement in [serde_json::Value::Null, serde_json::json!(42)] {
        let mut envelope = fixture.envelope.clone();
        envelope["keyId"] = replacement;
        assert_eq!(
            verify_signed_envelope(&serde_json::to_vec(&envelope)?, &keys),
            Err(VerifyError::InvalidEnvelope)
        );
    }
    let mut envelope = fixture.envelope;
    envelope.as_object_mut().ok_or("object")?.remove("format");
    assert_eq!(
        verify_signed_envelope(&serde_json::to_vec(&envelope)?, &keys),
        Err(VerifyError::InvalidEnvelope)
    );
    Ok(())
}

#[test]
fn rejects_invalid_utf8_bom_trailing_values_and_oversized_input() -> TestResult {
    let (fixture, keys) = fixture()?;
    let raw = serde_json::to_vec(&fixture.envelope)?;
    for bytes in [
        vec![0xff],
        [b"\xef\xbb\xbf".as_slice(), &raw].concat(),
        [raw.as_slice(), b" {}"].concat(),
    ] {
        assert_eq!(
            verify_signed_envelope(&bytes, &keys),
            Err(VerifyError::InvalidEnvelope)
        );
    }
    assert_eq!(
        verify_signed_envelope(&[], &keys),
        Err(VerifyError::EnvelopeSize)
    );
    assert_eq!(
        verify_signed_envelope(&vec![b' '; 1536 * 1024 + 1], &keys),
        Err(VerifyError::EnvelopeSize)
    );
    // Escaped lone surrogates must not be converted to replacement characters.
    let malformed = String::from_utf8(raw)?.replace("judgedesk-announcements-v1", r"\ud800");
    assert_eq!(
        verify_signed_envelope(malformed.as_bytes(), &keys),
        Err(VerifyError::InvalidEnvelope)
    );
    Ok(())
}

#[test]
fn rejects_noncanonical_base64_and_wrong_signature_sizes() -> TestResult {
    let (fixture, keys) = fixture()?;
    for (field, value) in [
        ("payloadBase64", "e30".to_owned()),
        ("payloadBase64", "e31=".to_owned()),
        ("payloadBase64", "e30=\n".to_owned()),
        ("payloadBase64", "____".to_owned()),
        ("payloadBase64", "".to_owned()),
        ("signatureBase64", STANDARD.encode([0u8; 63])),
        ("signatureBase64", STANDARD.encode([0u8; 65])),
    ] {
        let mut envelope = fixture.envelope.clone();
        envelope[field] = value.into();
        assert!(
            matches!(
                verify_signed_envelope(&serde_json::to_vec(&envelope)?, &keys),
                Err(VerifyError::InvalidBase64
                    | VerifyError::PayloadSize
                    | VerifyError::SignatureSize)
            ),
            "{field}"
        );
    }
    let mut envelope = fixture.envelope;
    envelope["payloadBase64"] = "A".repeat(1_398_104).into();
    assert_eq!(
        verify_signed_envelope(&serde_json::to_vec(&envelope)?, &keys),
        Err(VerifyError::PayloadSize)
    );
    Ok(())
}

#[test]
fn validates_format_and_ascii_key_id_before_trust_lookup() -> TestResult {
    let (fixture, keys) = fixture()?;
    for (field, value) in [
        ("format", "judgedesk-toolchains-v1".to_owned()),
        ("keyId", "".to_owned()),
        ("keyId", "a".repeat(65)),
        ("keyId", "test\nkey".to_owned()),
        ("keyId", "-key".to_owned()),
        ("keyId", "Key".to_owned()),
        ("keyId", "khóa".to_owned()),
    ] {
        let mut envelope = fixture.envelope.clone();
        envelope[field] = value.into();
        assert_eq!(
            verify_signed_envelope(&serde_json::to_vec(&envelope)?, &keys),
            Err(VerifyError::InvalidEnvelope)
        );
    }
    Ok(())
}

#[test]
fn envelope_must_be_a_json_object_not_a_positional_array() -> TestResult {
    let (fixture, keys) = fixture()?;
    let array = serde_json::json!([
        fixture.envelope["format"],
        fixture.envelope["keyId"],
        fixture.envelope["payloadBase64"],
        fixture.envelope["signatureBase64"],
    ]);
    assert_eq!(
        verify_signed_envelope(&serde_json::to_vec(&array)?, &keys),
        Err(VerifyError::InvalidEnvelope)
    );
    Ok(())
}

#[test]
fn signature_domain_and_whitespace_are_bound_but_payload_is_still_opaque() -> TestResult {
    let pkcs8 = ring::signature::Ed25519KeyPair::generate_pkcs8(&ring::rand::SystemRandom::new())
        .map_err(|_| "key generation")?;
    let key =
        ring::signature::Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).map_err(|_| "key format")?;
    let trusted = BTreeMap::from([(
        "test-only".to_owned(),
        key.public_key().as_ref().try_into()?,
    )]);
    // Verification MUST NOT parse, normalize or claim to sanitize the payload.
    let payload = b" { \"untrusted\": true }\n";
    let mut envelope = serde_json::json!({
        "format": "judgedesk-announcements-v1", "keyId": "test-only",
        "payloadBase64": STANDARD.encode(payload), "signatureBase64": "",
    });
    for (prefix, expected) in [
        ("JudgeDesk toolchains v1\ntest-only\n", false),
        ("JudgeDesk announcements v1\ntest-only\n", true),
    ] {
        let message = [prefix.as_bytes(), payload].concat();
        envelope["signatureBase64"] = STANDARD.encode(key.sign(&message).as_ref()).into();
        let result = verify_signed_envelope(&serde_json::to_vec(&envelope)?, &trusted);
        if expected {
            assert_eq!(result?, payload);
        } else {
            assert_eq!(result, Err(VerifyError::InvalidSignature));
        }
    }
    envelope["payloadBase64"] = STANDARD.encode(b"{\"untrusted\":true}").into();
    assert_eq!(
        verify_signed_envelope(&serde_json::to_vec(&envelope)?, &trusted),
        Err(VerifyError::InvalidSignature)
    );
    Ok(())
}

#[test]
fn accepts_exact_byte_limits_and_rejects_the_next_byte() -> TestResult {
    let (fixture, keys) = fixture()?;
    let mut envelope = serde_json::to_vec(&fixture.envelope)?;
    envelope.resize(1536 * 1024, b' ');
    assert!(verify_signed_envelope(&envelope, &keys).is_ok());
    envelope.push(b' ');
    assert_eq!(
        verify_signed_envelope(&envelope, &keys),
        Err(VerifyError::EnvelopeSize)
    );

    let pkcs8 = ring::signature::Ed25519KeyPair::generate_pkcs8(&ring::rand::SystemRandom::new())
        .map_err(|_| "key generation")?;
    let key =
        ring::signature::Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).map_err(|_| "key format")?;
    let trusted = BTreeMap::from([(
        "test-only".to_owned(),
        key.public_key().as_ref().try_into()?,
    )]);
    let mut payload = vec![b'x'; 1024 * 1024];
    let message = [
        b"JudgeDesk announcements v1\ntest-only\n".as_slice(),
        &payload,
    ]
    .concat();
    let mut envelope = serde_json::json!({
        "format": "judgedesk-announcements-v1", "keyId": "test-only",
        "payloadBase64": STANDARD.encode(&payload),
        "signatureBase64": STANDARD.encode(key.sign(&message).as_ref()),
    });
    assert_eq!(
        verify_signed_envelope(&serde_json::to_vec(&envelope)?, &trusted)?,
        payload
    );
    payload.push(b'x');
    envelope["payloadBase64"] = STANDARD.encode(&payload).into();
    assert_eq!(
        verify_signed_envelope(&serde_json::to_vec(&envelope)?, &trusted),
        Err(VerifyError::PayloadSize)
    );
    Ok(())
}
