#[cfg(target_os = "macos")]
mod macos {
    use std::fs::{File, OpenOptions};
    use std::io::{Read, Seek, SeekFrom};
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
    use std::path::{Path, PathBuf};

    const REQUIRED_ENV: &str = "JUDGEDESK_TREE_GUARD_REQUIRED";
    const PATH_ENV: &str = "JUDGEDESK_TREE_GUARD_PATH";
    const GENERATION_ENV: &str = "JUDGEDESK_TREE_GUARD_GENERATION";
    const HEADER: &str = "JUDGEDESK_PROCESS_TREE/1";
    const MAX_METADATA_BYTES: u64 = 160;

    #[derive(Debug)]
    pub struct ProcessTreeGuard {
        _file: File,
    }

    pub fn acquire_from_environment() -> Result<Option<ProcessTreeGuard>, String> {
        let required = std::env::var_os(REQUIRED_ENV);
        if required.is_none() {
            if std::env::var_os(PATH_ENV).is_some() || std::env::var_os(GENERATION_ENV).is_some() {
                return Err("PROCESS_TREE_GUARD_PARTIAL_ENVIRONMENT".into());
            }
            return Ok(None);
        }
        if required.as_deref() != Some(std::ffi::OsStr::new("1")) {
            return Err("PROCESS_TREE_GUARD_INVALID_REQUIREMENT".into());
        }
        let path =
            PathBuf::from(std::env::var_os(PATH_ENV).ok_or("PROCESS_TREE_GUARD_PATH_MISSING")?);
        let generation =
            std::env::var(GENERATION_ENV).map_err(|_| "PROCESS_TREE_GUARD_GENERATION_MISSING")?;
        acquire(&path, &generation).map(Some)
    }

    fn acquire(path: &Path, generation: &str) -> Result<ProcessTreeGuard, String> {
        validate_generation(generation)?;
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
            .open(path)
            .map_err(|error| format!("PROCESS_TREE_GUARD_OPEN_FAILED: {error}"))?;
        let metadata = file
            .metadata()
            .map_err(|error| format!("PROCESS_TREE_GUARD_METADATA_FAILED: {error}"))?;
        if !metadata.file_type().is_file()
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.permissions().mode() & 0o077 != 0
            || metadata.len() > MAX_METADATA_BYTES
        {
            return Err("PROCESS_TREE_GUARD_UNTRUSTED_FILE".into());
        }
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_SH | libc::LOCK_NB) } != 0 {
            return Err(format!(
                "PROCESS_TREE_GUARD_LOCK_FAILED: {}",
                std::io::Error::last_os_error()
            ));
        }
        file.seek(SeekFrom::Start(0))
            .map_err(|error| format!("PROCESS_TREE_GUARD_SEEK_FAILED: {error}"))?;
        let mut contents = String::new();
        file.by_ref()
            .take(MAX_METADATA_BYTES + 1)
            .read_to_string(&mut contents)
            .map_err(|error| format!("PROCESS_TREE_GUARD_READ_FAILED: {error}"))?;
        if contents.len() as u64 > MAX_METADATA_BYTES || contents != generation_contents(generation)
        {
            return Err("PROCESS_TREE_GUARD_GENERATION_MISMATCH".into());
        }
        Ok(ProcessTreeGuard { _file: file })
    }

    fn validate_generation(generation: &str) -> Result<(), String> {
        if generation.len() == 64
            && generation
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            Ok(())
        } else {
            Err("PROCESS_TREE_GUARD_INVALID_GENERATION".into())
        }
    }

    fn generation_contents(generation: &str) -> String {
        format!("{HEADER}\ngeneration={generation}\n")
    }

    #[cfg(test)]
    mod tests {
        use super::{acquire, generation_contents};
        use std::fs::{self, OpenOptions};
        use std::io::Write;
        use std::os::fd::AsRawFd;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        use std::path::PathBuf;
        use std::sync::atomic::{AtomicU64, Ordering};

        static NEXT_DIRECTORY: AtomicU64 = AtomicU64::new(0);
        const GENERATION: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

        struct TestDirectory(PathBuf);

        impl TestDirectory {
            fn new() -> Self {
                let suffix = NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed);
                let path = std::env::temp_dir().join(format!(
                    "judgedesk-tree-guard-test-{}-{suffix}",
                    std::process::id()
                ));
                fs::create_dir(&path).expect("create tree guard test directory");
                Self(path)
            }
        }

        impl Drop for TestDirectory {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }

        fn create_guard_file(directory: &TestDirectory) -> (PathBuf, std::fs::File) {
            let path = directory.0.join("process-tree.lock");
            let mut file = OpenOptions::new()
                .create_new(true)
                .read(true)
                .write(true)
                .mode(0o600)
                .open(&path)
                .expect("create process-tree lock");
            file.write_all(generation_contents(GENERATION).as_bytes())
                .expect("write generation");
            file.sync_all().expect("sync generation");
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
                .expect("set process-tree lock permissions");
            (path, file)
        }

        #[test]
        fn shared_guard_requires_the_expected_generation() {
            let directory = TestDirectory::new();
            let (path, _owner) = create_guard_file(&directory);
            let guard = acquire(&path, GENERATION).expect("acquire shared generation guard");
            assert!(acquire(
                &path,
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            )
            .expect_err("wrong generation must fail")
            .contains("GENERATION_MISMATCH"));
            drop(guard);
        }

        #[test]
        fn exclusive_handoff_blocks_late_executor_startup() {
            let directory = TestDirectory::new();
            let (path, owner) = create_guard_file(&directory);
            assert_eq!(
                unsafe { libc::flock(owner.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
                0
            );
            assert!(acquire(&path, GENERATION)
                .expect_err("exclusive handoff must reject a late executor")
                .contains("LOCK_FAILED"));
            assert_eq!(unsafe { libc::flock(owner.as_raw_fd(), libc::LOCK_UN) }, 0);
            acquire(&path, GENERATION).expect("shared guard after handoff");
        }
    }
}

#[cfg(target_os = "macos")]
pub use macos::{acquire_from_environment, ProcessTreeGuard};

#[cfg(not(target_os = "macos"))]
#[derive(Debug)]
pub struct ProcessTreeGuard;

#[cfg(not(target_os = "macos"))]
pub fn acquire_from_environment() -> Result<Option<ProcessTreeGuard>, String> {
    Ok(None)
}
