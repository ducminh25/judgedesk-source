use super::{store_state::hash, AnnouncementImage, AnnouncementStore, StoreError};
use judgedesk_core::storage::{is_symlink_or_reparse_point, validate_existing_directory_path};
use std::{collections::HashSet, fs, time::SystemTime};
const MEDIA_BUDGET: u64 = 128 * 1024 * 1024;

impl AnnouncementStore {
    pub(super) fn cached_media(
        &self,
        image: &AnnouncementImage,
    ) -> Result<Option<Vec<u8>>, StoreError> {
        let path = self
            .files
            .root
            .join("media")
            .join(format!("{}.{}", image.sha256, image.extension));
        let bytes = self.files.read(&path, image.size_bytes as usize)?;
        if bytes.as_ref().is_some_and(|bytes| {
            hash(bytes) != image.sha256 || bytes.len() as u64 != image.size_bytes
        }) {
            return Err(StoreError::InvalidState);
        }
        if bytes.is_some() {
            // Access time for eviction only; failure must be visible rather than silently changing policy.
            fs::File::options()
                .write(true)
                .open(path)?
                .set_modified(SystemTime::now())?;
        }
        Ok(bytes)
    }
    pub(super) fn save_media(
        &self,
        image: &AnnouncementImage,
        bytes: &[u8],
        pinned: &HashSet<String>,
    ) -> Result<(), StoreError> {
        if bytes.len() as u64 != image.size_bytes || hash(bytes) != image.sha256 {
            return Err(StoreError::InvalidState);
        }
        let directory = self.files.root.join("media");
        validate_existing_directory_path(&directory).map_err(|_| StoreError::UnsafePath)?;
        let mut files = Vec::new();
        let mut total = bytes.len() as u64;
        for entry in fs::read_dir(&directory)? {
            if files.len() >= 4096 {
                return Err(StoreError::StateLimit);
            }
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some((digest, extension)) = name.rsplit_once('.') else {
                return Err(StoreError::UnsafePath);
            };
            if digest.len() != 64
                || !digest.bytes().all(super::model::lower_hex)
                || !matches!(extension, "jpg" | "png")
            {
                return Err(StoreError::UnsafePath);
            }
            let metadata = fs::symlink_metadata(entry.path())?;
            if !metadata.is_file() || is_symlink_or_reparse_point(&metadata) {
                return Err(StoreError::UnsafePath);
            }
            if digest != image.sha256 || extension != image.extension {
                total = total
                    .checked_add(metadata.len())
                    .ok_or(StoreError::StateLimit)?;
            }
            files.push((
                metadata.modified()?,
                entry.path(),
                metadata.len(),
                pinned.contains(digest) || digest == image.sha256,
            ));
        }
        files.sort_by_key(|file| file.0);
        for (_, path, size, keep) in files {
            if total <= MEDIA_BUDGET {
                break;
            }
            if !keep {
                fs::remove_file(path)?;
                total -= size;
            }
        }
        if total > MEDIA_BUDGET {
            return Err(StoreError::StateLimit);
        }
        self.files.write(
            &directory.join(format!("{}.{}", image.sha256, image.extension)),
            bytes,
            false,
        )
    }
}
