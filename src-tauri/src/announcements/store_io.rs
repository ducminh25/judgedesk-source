use super::store::StoreError;
use fs4::{FileExt, TryLockError};
use judgedesk_core::storage::{is_symlink_or_reparse_point, validate_existing_directory_path};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Checkpoint {
    Verified,
    FeedStored,
    StateTempSynced,
}
#[cfg(test)]
pub(super) type Hook = std::sync::Arc<dyn Fn(Checkpoint) -> io::Result<()> + Send + Sync>;

pub(super) struct StoreFiles {
    pub root: PathBuf,
    _lock: File,
    #[cfg(test)]
    pub hook: Option<Hook>,
}
fn directory(path: &Path) -> Result<PathBuf, StoreError> {
    match fs::create_dir(path) {
        Ok(()) => (),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => (),
        Err(e) => return Err(e.into()),
    }
    validate_existing_directory_path(path).map_err(|_| StoreError::UnsafePath)
}
fn regular(path: &Path) -> Result<Option<fs::Metadata>, StoreError> {
    match fs::symlink_metadata(path) {
        Ok(meta) if !is_symlink_or_reparse_point(&meta) && meta.is_file() => Ok(Some(meta)),
        Ok(_) => Err(StoreError::UnsafePath),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

impl StoreFiles {
    pub fn open(app_data_root: &Path) -> Result<Self, StoreError> {
        let base =
            validate_existing_directory_path(app_data_root).map_err(|_| StoreError::UnsafePath)?;
        let root = directory(&base.join("announcements"))?;
        directory(&root.join("feeds"))?;
        directory(&root.join("media"))?;
        let lock_path = root.join("store.lock");
        regular(&lock_path)?;
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(lock_path)?;
        if is_symlink_or_reparse_point(&lock.metadata()?) {
            return Err(StoreError::UnsafePath);
        }
        match FileExt::try_lock(&lock) {
            Ok(()) => (),
            Err(TryLockError::WouldBlock) => return Err(StoreError::Busy),
            Err(TryLockError::Error(e)) => return Err(e.into()),
        }
        let files = Self {
            root,
            _lock: lock,
            #[cfg(test)]
            hook: None,
        };
        files.clean_temporaries()?;
        Ok(files)
    }
    fn clean_temporaries(&self) -> Result<(), StoreError> {
        // The process lease is held and no service can write yet. Only our exact
        // create_new temp names are eligible; preserve state, blobs and user evidence.
        for directory in [
            &self.root,
            &self.root.join("feeds"),
            &self.root.join("media"),
        ] {
            validate_existing_directory_path(directory).map_err(|_| StoreError::UnsafePath)?;
            for (index, entry) in fs::read_dir(directory)?.enumerate() {
                if index >= 4096 {
                    return Err(StoreError::StateLimit);
                }
                let entry = entry?;
                let name = entry.file_name();
                let Some(nonce) = name
                    .to_str()
                    .and_then(|name| name.strip_prefix(".write-"))
                    .and_then(|name| name.strip_suffix(".tmp"))
                else {
                    continue;
                };
                if nonce.len() == 32 && nonce.bytes().all(super::model::lower_hex) {
                    regular(&entry.path())?.ok_or(StoreError::InvalidState)?;
                    fs::remove_file(entry.path())?;
                }
            }
        }
        Ok(())
    }
    pub fn checkpoint(&self, point: Checkpoint) -> Result<(), StoreError> {
        #[cfg(test)]
        if let Some(hook) = &self.hook {
            hook(point)?;
        }
        let _ = point;
        Ok(())
    }
    fn check_parent(&self, path: &Path) -> Result<(), StoreError> {
        let parent = path.parent().ok_or(StoreError::UnsafePath)?;
        if parent != self.root
            && parent != self.root.join("feeds")
            && parent != self.root.join("media")
        {
            return Err(StoreError::UnsafePath);
        }
        validate_existing_directory_path(parent).map_err(|_| StoreError::UnsafePath)?;
        Ok(())
    }
    pub fn read(&self, path: &Path, maximum: usize) -> Result<Option<Vec<u8>>, StoreError> {
        self.check_parent(path)?;
        let Some(meta) = regular(path)? else {
            return Ok(None);
        };
        if meta.len() > maximum as u64 {
            return Err(StoreError::StateLimit);
        }
        let file = File::open(path)?;
        if is_symlink_or_reparse_point(&file.metadata()?) {
            return Err(StoreError::UnsafePath);
        }
        let mut bytes = Vec::new();
        file.take(maximum as u64 + 1).read_to_end(&mut bytes)?;
        if bytes.len() > maximum {
            return Err(StoreError::StateLimit);
        }
        Ok(Some(bytes))
    }
    pub fn write(&self, path: &Path, bytes: &[u8], state: bool) -> Result<(), StoreError> {
        self.check_parent(path)?;
        regular(path)?;
        let mut random = [0_u8; 16];
        getrandom::fill(&mut random).map_err(|_| StoreError::Random)?;
        let suffix: String = random.iter().map(|b| format!("{b:02x}")).collect();
        let temp = path.with_file_name(format!(".write-{suffix}.tmp"));
        let result = (|| {
            let mut file = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&temp)?;
            file.write_all(bytes)?;
            file.sync_all()?;
            drop(file);
            if state {
                self.checkpoint(Checkpoint::StateTempSynced)?;
            }
            self.check_parent(path)?;
            regular(path)?;
            fs::rename(&temp, path)?;
            // No fallible step after rename: callers publish the committed state immediately.
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(temp);
        }
        result
    }
    pub fn feed_path(&self, hash: &str) -> PathBuf {
        self.root.join("feeds").join(format!("{hash}.json"))
    }
    pub fn state_path(&self) -> PathBuf {
        self.root.join("state.json")
    }
    pub fn has_feed_files(&self) -> Result<bool, StoreError> {
        self.check_parent(&self.feed_path("unused"))?;
        Ok(fs::read_dir(self.root.join("feeds"))?.next().is_some())
    }
}
