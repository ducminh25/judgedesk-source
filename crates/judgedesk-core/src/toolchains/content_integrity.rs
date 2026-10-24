//! Verify expanded Linux Full packages against a separately pinned index digest.
use super::discovery::sha256_bytes_hex;
use serde::Deserialize;
use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::{Component, Path};

pub const CONTENT_INDEX_NAME: &str = ".judgedesk-content.json";
const MAX_INDEX_BYTES: u64 = 64 * 1024 * 1024;
pub(crate) const MAX_FILE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAX_ENTRIES: usize = 200_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ContentIndex {
    schema_version: u32,
    entries: Vec<Entry>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
enum Entry {
    Directory {
        path: String,
    },
    File {
        path: String,
        #[serde(rename = "sizeBytes")]
        size_bytes: u64,
        executable: bool,
        sha256: String,
    },
}

impl Entry {
    fn path(&self) -> &str {
        match self {
            Self::Directory { path } | Self::File { path, .. } => path,
        }
    }
}

pub(crate) fn read_bounded(path: &Path, maximum: u64) -> Result<Vec<u8>, String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|e| format!("MANAGED_PACKAGE_CORRUPT: {e}"))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > maximum {
        return Err("MANAGED_PACKAGE_CORRUPT: invalid regular file or byte limit".into());
    }
    let file = fs::File::open(path).map_err(|e| format!("MANAGED_PACKAGE_CORRUPT: {e}"))?;
    let mut bytes = Vec::new();
    file.take(maximum + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("MANAGED_PACKAGE_CORRUPT: {e}"))?;
    if bytes.len() as u64 > maximum || bytes.len() as u64 != metadata.len() {
        return Err("MANAGED_PACKAGE_CORRUPT: file changed or exceeds byte limit".into());
    }
    Ok(bytes)
}

#[cfg(target_os = "linux")]
fn fingerprint(metadata: &fs::Metadata) -> [u64; 9] {
    use std::os::unix::fs::MetadataExt;
    [
        metadata.dev(),
        metadata.ino(),
        metadata.len(),
        metadata.mode() as u64,
        metadata.mtime() as u64,
        metadata.mtime_nsec() as u64,
        metadata.ctime() as u64,
        metadata.ctime_nsec() as u64,
        metadata.nlink(),
    ]
}

fn verified_file_matches(
    path: &Path,
    expected: &str,
    metadata: &fs::Metadata,
) -> Result<bool, String> {
    #[cfg(target_os = "linux")]
    let before = fingerprint(metadata);
    #[cfg(not(target_os = "linux"))]
    let _ = metadata;
    // Filesystem timestamps can stay identical across consecutive same-size
    // writes. Metadata equality cannot substitute for the pinned content hash.
    if sha256_bytes_hex(&read_bounded(path, MAX_FILE_BYTES)?) != expected {
        return Ok(false);
    }
    #[cfg(target_os = "linux")]
    {
        let after = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
        if after.file_type().is_symlink() || fingerprint(&after) != before {
            return Err("MANAGED_PACKAGE_CORRUPT: content changed during verification".into());
        }
    }
    Ok(true)
}

pub fn verify_content_index(
    root: &Path,
    trusted_index_sha256: &str,
    allow_import_marker: bool,
) -> Result<(), String> {
    let metadata =
        fs::symlink_metadata(root).map_err(|e| format!("MANAGED_PACKAGE_CORRUPT: {e}"))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("MANAGED_PACKAGE_CORRUPT: package root must be a regular directory".into());
    }
    let bytes = read_bounded(&root.join(CONTENT_INDEX_NAME), MAX_INDEX_BYTES)?;
    if sha256_bytes_hex(&bytes) != trusted_index_sha256 {
        return Err(
            "MANAGED_PACKAGE_CORRUPT: content index does not match the trusted digest".into(),
        );
    }
    let index: ContentIndex = serde_json::from_slice(&bytes)
        .map_err(|e| format!("MANAGED_PACKAGE_CORRUPT: invalid content index: {e}"))?;
    if index.schema_version != 1 || index.entries.is_empty() || index.entries.len() > MAX_ENTRIES {
        return Err("MANAGED_PACKAGE_CORRUPT: invalid content index schema or entry count".into());
    }
    let mut expected = BTreeMap::new();
    let mut total_bytes = 0u64;
    for entry in index.entries {
        let relative = entry.path();
        if relative.is_empty()
            || relative.contains('\\')
            || relative.chars().any(char::is_control)
            || relative
                .split('/')
                .any(|p| p.is_empty() || p == "." || p == "..")
            || Path::new(relative)
                .components()
                .any(|p| !matches!(p, Component::Normal(_)))
            || relative == CONTENT_INDEX_NAME
            || relative == ".judgedesk-import-complete"
        {
            return Err("MANAGED_PACKAGE_CORRUPT: unsafe content index path".into());
        }
        if let Entry::File {
            size_bytes, sha256, ..
        } = &entry
        {
            total_bytes = total_bytes.saturating_add(*size_bytes);
            if *size_bytes > MAX_FILE_BYTES
                || total_bytes > MAX_TOTAL_BYTES
                || sha256.len() != 64
                || !sha256.bytes().all(|c| c.is_ascii_hexdigit())
            {
                return Err("MANAGED_PACKAGE_CORRUPT: content digest or size limit".into());
            }
        }
        if expected.insert(relative.to_owned(), entry).is_some() {
            return Err("MANAGED_PACKAGE_CORRUPT: duplicate content index path".into());
        }
    }
    let mut pending = vec![String::new()];
    let mut visited = 0usize;
    while let Some(relative) = pending.pop() {
        for item in fs::read_dir(root.join(&relative)).map_err(|e| e.to_string())? {
            let item = item.map_err(|e| e.to_string())?;
            let name = item
                .file_name()
                .into_string()
                .map_err(|_| "MANAGED_PACKAGE_CORRUPT: non UTF-8 path")?;
            let path = if relative.is_empty() {
                name
            } else {
                format!("{relative}/{name}")
            };
            if path == CONTENT_INDEX_NAME {
                continue;
            }
            if allow_import_marker && path == ".judgedesk-import-complete" {
                let marker = fs::symlink_metadata(item.path()).map_err(|e| e.to_string())?;
                if marker.is_file() && !marker.file_type().is_symlink() {
                    continue;
                }
            }
            let entry = expected
                .remove(&path)
                .ok_or_else(|| format!("MANAGED_PACKAGE_CORRUPT: unexpected entry '{path}'"))?;
            let metadata = fs::symlink_metadata(item.path()).map_err(|e| e.to_string())?;
            if metadata.file_type().is_symlink() {
                return Err(format!("MANAGED_PACKAGE_CORRUPT: symbolic link '{path}'"));
            }
            match entry {
                Entry::Directory { .. } if metadata.is_dir() => pending.push(path),
                Entry::File {
                    size_bytes,
                    executable,
                    sha256,
                    ..
                } if metadata.is_file() => {
                    if metadata.len() != size_bytes {
                        return Err(format!("MANAGED_PACKAGE_CORRUPT: size drift '{path}'"));
                    }
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        if (metadata.permissions().mode() & 0o111 != 0) != executable {
                            return Err(format!(
                                "MANAGED_PACKAGE_CORRUPT: executable mode drift '{path}'"
                            ));
                        }
                    }
                    #[cfg(not(unix))]
                    let _ = executable;
                    if !verified_file_matches(&item.path(), &sha256, &metadata)? {
                        return Err(format!("MANAGED_PACKAGE_CORRUPT: content drift '{path}'"));
                    }
                }
                _ => return Err(format!("MANAGED_PACKAGE_CORRUPT: file type drift '{path}'")),
            }
            visited += 1;
            if visited > MAX_ENTRIES {
                return Err("MANAGED_PACKAGE_CORRUPT: entry limit".into());
            }
        }
    }
    if !expected.is_empty() {
        return Err("MANAGED_PACKAGE_CORRUPT: missing indexed files".into());
    }
    Ok(())
}
