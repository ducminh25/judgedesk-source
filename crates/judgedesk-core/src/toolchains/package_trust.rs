use super::content_integrity::{verify_content_index, CONTENT_INDEX_NAME};
use super::discovery::ToolchainPackageReceipt;
use serde::Deserialize;
use std::path::Path;
use std::sync::OnceLock;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Catalog {
    schema_version: u32,
    distribution: String,
    platform: String,
    arch: String,
    manifest_sha256: String,
    packages: Vec<Pin>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Pin {
    id: String,
    version: String,
    archive_sha256: String,
    installed_size_bytes: u64,
    content_index_sha256: String,
}

fn trusted_catalog() -> Result<&'static Catalog, String> {
    static CATALOG: OnceLock<Result<Catalog, String>> = OnceLock::new();
    let result = CATALOG.get_or_init(|| {
        let catalog: Catalog = serde_json::from_str(include_str!(
            "../../../../shared/linux-full-package-trust.json"
        ))
        .map_err(|e| format!("MANAGED_PACKAGE_TRUST_INVALID: {e}"))?;
        let valid_digest =
            |value: &str| value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit());
        if catalog.schema_version != 1
            || catalog.distribution != "full"
            || catalog.platform != "linux"
            || catalog.arch != "x64"
            || !valid_digest(&catalog.manifest_sha256)
            || catalog.packages.is_empty()
        {
            return Err("MANAGED_PACKAGE_TRUST_INVALID: invalid catalog identity".into());
        }
        let mut identities = std::collections::HashSet::new();
        for pin in &catalog.packages {
            if !pin.id.ends_with("-linux-x64")
                || !valid_digest(&pin.archive_sha256)
                || !valid_digest(&pin.content_index_sha256)
                || pin.installed_size_bytes == 0
                || !identities.insert((&pin.id, &pin.version, &pin.archive_sha256))
            {
                return Err(
                    "MANAGED_PACKAGE_TRUST_INVALID: invalid or ambiguous package identity".into(),
                );
            }
        }
        Ok(catalog)
    });
    result.as_ref().map_err(Clone::clone)
}

pub fn is_linux_full_build() -> bool {
    cfg!(target_os = "linux") && option_env!("JUDGEDESK_LINUX_EDITION") == Some("full")
}

/// Returns false for legacy non-indexed packages. Full Linux never admits them;
/// Core retains compatibility with existing receipts on other platforms.
pub fn verify_managed_package(
    root: &Path,
    receipt: &ToolchainPackageReceipt,
    allow_import_marker: bool,
) -> Result<bool, String> {
    if !cfg!(target_os = "linux") {
        return Ok(false);
    }
    let pin = trusted_catalog()?.packages.iter().find(|pin| {
        pin.id == receipt.package_id
            && pin.version == receipt.version
            && pin.archive_sha256 == receipt.archive_sha256
    });
    let has_index = fs_index_exists(root);
    if pin.is_none() && !has_index && !is_linux_full_build() {
        return Ok(false);
    }
    let pin = pin.ok_or_else(|| {
        "MANAGED_PACKAGE_UNTRUSTED: Linux package is absent from the compiled trust catalog"
            .to_string()
    })?;
    verify_content_index(root, &pin.content_index_sha256, allow_import_marker)?;
    Ok(true)
}

fn fs_index_exists(root: &Path) -> bool {
    // lstat also observes a broken link; exists() would allow it to look absent.
    std::fs::symlink_metadata(root.join(CONTENT_INDEX_NAME)).is_ok()
}
