/// Cryptographic identity of the native sources, configuration, and compiler
/// selected when this library or its standalone helper was built.
pub const NATIVE_BUILD_FINGERPRINT: &str = env!("JUDGEDESK_NATIVE_BUILD_FINGERPRINT");

#[cfg(test)]
mod tests {
    use super::*;
    use crate::guardian_protocol::GUARDIAN_PROTOCOL_MAGIC;

    #[test]
    fn compiled_native_source_identity_is_a_canonical_sha256_digest() {
        assert_eq!(NATIVE_BUILD_FINGERPRINT.len(), 64);
        assert!(NATIVE_BUILD_FINGERPRINT
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)));
    }

    #[test]
    fn private_protocol_is_bound_to_the_compiled_native_sources() {
        assert_eq!(
            GUARDIAN_PROTOCOL_MAGIC,
            concat!(
                "JUDGEDESK_RUN_GUARDIAN/3/",
                env!("JUDGEDESK_NATIVE_BUILD_FINGERPRINT")
            )
        );
        assert_eq!(
            GUARDIAN_PROTOCOL_MAGIC.strip_prefix("JUDGEDESK_RUN_GUARDIAN/3/"),
            Some(NATIVE_BUILD_FINGERPRINT)
        );
    }
}
