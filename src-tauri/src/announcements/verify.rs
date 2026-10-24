use super::limits::{MAX_ENVELOPE_BYTES, MAX_PAYLOAD_BYTES};
use base64::{engine::general_purpose::STANDARD, Engine};
use ring::signature::{UnparsedPublicKey, ED25519};
use serde::Deserialize;
use std::{collections::BTreeMap, fmt};

const FORMAT: &str = "judgedesk-announcements-v1";
const SIGNING_PREFIX: &[u8] = b"JudgeDesk announcements v1\n";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VerifyError {
    EnvelopeSize,
    InvalidEnvelope,
    UntrustedKey,
    InvalidBase64,
    PayloadSize,
    SignatureSize,
    InvalidSignature,
}

impl fmt::Display for VerifyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::EnvelopeSize => "Announcement envelope exceeds its byte limits.",
            Self::InvalidEnvelope => "Announcement envelope is invalid.",
            Self::UntrustedKey => "Announcement signing key is not trusted.",
            Self::InvalidBase64 => "Announcement base64 is not canonical.",
            Self::PayloadSize => "Announcement payload exceeds its byte limits.",
            Self::SignatureSize => "Announcement signature must contain 64 bytes.",
            Self::InvalidSignature => "Announcement signature verification failed.",
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for VerifyError {}

// Deserialize directly into a closed struct: going through Value would discard duplicate keys.
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Envelope {
    format: String,
    key_id: String,
    payload_base64: String,
    signature_base64: String,
}

fn valid_key_id(value: &str) -> bool {
    let alphanumeric = |byte: u8| byte.is_ascii_lowercase() || byte.is_ascii_digit();
    !value.is_empty()
        && value.len() <= 64
        && value.bytes().next().is_some_and(alphanumeric)
        && value.bytes().all(|byte| alphanumeric(byte) || byte == b'-')
}

fn decode_bounded(
    value: &str,
    maximum: usize,
    size_error: VerifyError,
) -> Result<Vec<u8>, VerifyError> {
    // Bound the eventual decoder allocation before passing hostile text to it.
    if value.len() > maximum.div_ceil(3) * 4 {
        return Err(size_error);
    }
    if !value.len().is_multiple_of(4) {
        return Err(VerifyError::InvalidBase64);
    }
    let padding = if value.ends_with("==") {
        2
    } else {
        usize::from(value.ends_with('='))
    };
    if value.len() / 4 * 3 - padding > maximum {
        return Err(size_error);
    }
    // STANDARD rejects nonzero pad bits, missing padding, whitespace and URL-safe alphabet.
    let bytes = STANDARD
        .decode(value)
        .map_err(|_| VerifyError::InvalidBase64)?;
    if bytes.len() > maximum {
        return Err(size_error);
    }
    Ok(bytes)
}

/// Authenticate an envelope using explicitly supplied raw Ed25519 public keys.
///
/// Returns the exact signed payload bytes. They still require strict payload/schema validation
/// and HTML sanitization; authenticity alone never authorizes rendering or persistence.
/// No production key is implicitly trusted by this module.
pub fn verify_signed_envelope(
    raw_envelope: &[u8],
    trusted_keys: &BTreeMap<String, [u8; 32]>,
) -> Result<Vec<u8>, VerifyError> {
    if raw_envelope.is_empty() || raw_envelope.len() > MAX_ENVELOPE_BYTES {
        return Err(VerifyError::EnvelopeSize);
    }
    // Enforce UTF-8 even for bytes outside JSON strings; no lossy conversion or BOM removal.
    let text = std::str::from_utf8(raw_envelope).map_err(|_| VerifyError::InvalidEnvelope)?;
    // Serde structs also accept positional arrays; the wire contract only permits JSON objects.
    if !text
        .trim_start_matches([' ', '\t', '\r', '\n'])
        .starts_with('{')
    {
        return Err(VerifyError::InvalidEnvelope);
    }
    let envelope: Envelope =
        serde_json::from_str(text).map_err(|_| VerifyError::InvalidEnvelope)?;
    if envelope.format != FORMAT || !valid_key_id(&envelope.key_id) {
        return Err(VerifyError::InvalidEnvelope);
    }
    let key = trusted_keys
        .get(&envelope.key_id)
        .ok_or(VerifyError::UntrustedKey)?;
    let payload = decode_bounded(
        &envelope.payload_base64,
        MAX_PAYLOAD_BYTES,
        VerifyError::PayloadSize,
    )?;
    if payload.is_empty() {
        return Err(VerifyError::PayloadSize);
    }
    let signature = decode_bounded(&envelope.signature_base64, 64, VerifyError::SignatureSize)?;
    if signature.len() != 64 {
        return Err(VerifyError::SignatureSize);
    }
    let mut message =
        Vec::with_capacity(SIGNING_PREFIX.len() + envelope.key_id.len() + 1 + payload.len());
    message.extend_from_slice(SIGNING_PREFIX);
    message.extend_from_slice(envelope.key_id.as_bytes());
    message.push(b'\n');
    message.extend_from_slice(&payload);
    UnparsedPublicKey::new(&ED25519, key)
        .verify(&message, &signature)
        .map_err(|_| VerifyError::InvalidSignature)?;
    Ok(payload)
}
