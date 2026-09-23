use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

pub fn initialize_root(platform_root: PathBuf) -> Result<PathBuf, String> {
    let root = platform_root.join("JudgeDeskExecutor");
    ensure_directory(&root, "executor root")?;
    // Managed toolchains are immutable caches and intentionally survive executor restarts.
    ensure_directory(&root.join("toolchains"), "executor toolchain cache")?;
    // The process-tree generation guard is acquired before Platform::initialize. A production
    // restart therefore cannot reach this reset until the preceding executor/guardian tree has
    // drained. Clearing workspaces here removes compiler/submission/checker data abandoned by a
    // backend crash without teaching the Node sidecar to delete unowned UUID paths.
    for (name, description) in [
        ("workspaces", "executor workspace cache"),
        ("artifacts", "executor artifact cache"),
        ("profiles", "Seatbelt profile cache"),
    ] {
        reset_directory(&root.join(name), description)?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let workspaces = root.join("workspaces");
        let profiles = root.join("profiles");
        for (directory, description) in [
            (root.as_path(), "executor root"),
            (workspaces.as_path(), "executor workspace cache"),
            (profiles.as_path(), "Seatbelt profile cache"),
        ] {
            fs::set_permissions(directory, fs::Permissions::from_mode(0o700))
                .map_err(|error| format!("cannot protect {description}: {error}"))?;
        }
    }
    Ok(root)
}

fn validate_trusted_directory(path: &Path, description: &str) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if metadata.file_attributes() & 0x400 != 0 {
                    return Err(format!("{description} is a reparse point"));
                }
            }
            if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
                return Err(format!("{description} is not a trusted directory"));
            }
            Ok(())
        }
        Err(error) => Err(format!("cannot inspect {description}: {error}")),
    }
}

fn ensure_directory(path: &Path, description: &str) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(_) => validate_trusted_directory(path, description),
        Err(error) if error.kind() == ErrorKind::NotFound => {
            fs::create_dir_all(path)
                .map_err(|error| format!("cannot initialize {description}: {error}"))?;
            validate_trusted_directory(path, description)
        }
        Err(error) => Err(format!("cannot inspect {description}: {error}")),
    }
}

fn reset_directory(path: &Path, description: &str) -> Result<(), String> {
    reset_directory_with_contender(path, description, || Ok(()))
}

fn reset_directory_with_contender<F: FnOnce() -> std::io::Result<()>>(
    path: &Path,
    description: &str,
    before_create: F,
) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(_) => {
            validate_trusted_directory(path, description)?;
            fs::remove_dir_all(path)
                .map_err(|error| format!("cannot clear {description}: {error}"))?;
        }
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(format!("cannot inspect {description}: {error}")),
    }
    before_create()
        .map_err(|error| format!("cannot run {description} create contender: {error}"))?;
    match fs::create_dir(path) {
        Ok(()) => validate_trusted_directory(path, description),
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {
            validate_trusted_directory(path, description)
        }
        Err(error) => Err(format!("cannot initialize {description}: {error}")),
    }
}

pub fn inspect_workspace(path: &Path) -> (u64, u32) {
    let mut bytes = 0_u64;
    let mut files = 0_u32;
    let mut pending = vec![path.to_path_buf()];
    while let Some(directory) = pending.pop() {
        let Ok(entries) = fs::read_dir(directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            if metadata.is_dir() {
                pending.push(entry.path());
            } else if metadata.is_file() {
                files = files.saturating_add(1);
                bytes = bytes.saturating_add(metadata.len());
            }
        }
    }
    (bytes, files)
}

pub fn file_size(path: &Path) -> u64 {
    fs::metadata(path)
        .map(|metadata| metadata.len())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::initialize_root;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(label: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "judgedesk-workspace-{label}-{}-{nonce}",
                std::process::id()
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn startup_clears_ephemeral_caches_but_preserves_managed_toolchains() {
        let platform = TestDirectory::new("startup-cleanup");
        let root = initialize_root(platform.0.clone()).unwrap();
        fs::create_dir(root.join("workspaces/stale-run")).unwrap();
        fs::write(root.join("workspaces/stale-run/output.txt"), b"stale").unwrap();
        fs::write(root.join("artifacts/stale-artifact"), b"stale").unwrap();
        fs::write(root.join("profiles/stale.sb"), b"stale").unwrap();
        fs::create_dir(root.join("toolchains/python")).unwrap();
        fs::write(root.join("toolchains/python/marker"), b"managed").unwrap();

        let restarted = initialize_root(platform.0.clone()).unwrap();
        assert_eq!(restarted, root);
        assert!(fs::read_dir(root.join("workspaces"))
            .unwrap()
            .next()
            .is_none());
        assert!(fs::read_dir(root.join("artifacts"))
            .unwrap()
            .next()
            .is_none());
        assert!(fs::read_dir(root.join("profiles"))
            .unwrap()
            .next()
            .is_none());
        assert_eq!(
            fs::read(root.join("toolchains/python/marker")).unwrap(),
            b"managed"
        );
    }

    #[cfg(unix)]
    #[test]
    fn startup_refuses_a_workspace_symlink_without_touching_its_target() {
        use std::os::unix::fs::symlink;

        let platform = TestDirectory::new("symlink-rejection");
        let outside = TestDirectory::new("outside-sentinel");
        let root = platform.0.join("JudgeDeskExecutor");
        fs::create_dir_all(root.join("toolchains")).unwrap();
        fs::write(outside.0.join("sentinel"), b"preserve").unwrap();
        symlink(&outside.0, root.join("workspaces")).unwrap();

        let error = initialize_root(platform.0.clone()).unwrap_err();
        assert!(error.contains("workspace cache is not a trusted directory"));
        assert_eq!(fs::read(outside.0.join("sentinel")).unwrap(), b"preserve");
    }

    #[test]
    fn test_reset_directory_pre_existing_regular_file_rejected() {
        use super::reset_directory;

        let test_dir = TestDirectory::new("reset-race-pre-file");
        let conflict_path = test_dir.0.join("conflict_path");
        fs::write(&conflict_path, b"not a directory").unwrap();

        let err = reset_directory(&conflict_path, "test cache").unwrap_err();
        assert!(err.contains("test cache is not a trusted directory"));
    }

    #[test]
    fn test_reset_directory_already_exists_winner_refuses_regular_file() {
        use super::reset_directory_with_contender;

        let test_dir = TestDirectory::new("reset-race-winner-file");
        let conflict_path = test_dir.0.join("conflict_path");

        // The contender writes a regular file between removal and create_dir
        let err = reset_directory_with_contender(&conflict_path, "test cache", || {
            fs::write(&conflict_path, b"winner regular file")
        })
        .unwrap_err();
        assert!(
            err.contains("test cache is not a trusted directory"),
            "Expected 'is not a trusted directory', got: {err}"
        );
    }

    #[test]
    fn test_reset_directory_already_exists_winner_refuses_symlink() {
        use super::reset_directory_with_contender;

        let test_dir = TestDirectory::new("reset-race-symlink");
        let outside = TestDirectory::new("outside-sentinel-symlink");
        let sentinel_path = outside.0.join("sentinel.txt");
        fs::write(&sentinel_path, b"OUTSIDE_SENTINEL_UNTOUCHED").unwrap();
        let conflict_path = test_dir.0.join("conflict_symlink");

        #[cfg(unix)]
        let link_created = std::os::unix::fs::symlink(&outside.0, &conflict_path).is_ok();
        #[cfg(windows)]
        let link_created = std::os::windows::fs::symlink_dir(&outside.0, &conflict_path).is_ok();

        if link_created {
            let _ = fs::remove_file(&conflict_path).or_else(|_| fs::remove_dir(&conflict_path));
            let err = reset_directory_with_contender(&conflict_path, "test cache", || {
                #[cfg(unix)]
                {
                    std::os::unix::fs::symlink(&outside.0, &conflict_path)
                }
                #[cfg(windows)]
                {
                    std::os::windows::fs::symlink_dir(&outside.0, &conflict_path)
                }
            })
            .unwrap_err();
            assert!(
                err.contains("is not a trusted directory") || err.contains("is a reparse point"),
                "Expected rejection of symlink, got: {err}"
            );
            assert_eq!(
                fs::read(&sentinel_path).unwrap(),
                b"OUTSIDE_SENTINEL_UNTOUCHED"
            );
        }
    }

    #[test]
    #[cfg(windows)]
    fn test_reset_directory_already_exists_winner_refuses_windows_junction() {
        use super::reset_directory_with_contender;

        let test_dir = TestDirectory::new("reset-race-junction");
        let outside = TestDirectory::new("outside-sentinel-junction");
        let sentinel_path = outside.0.join("sentinel.txt");
        fs::write(&sentinel_path, b"OUTSIDE_JUNCTION_SENTINEL_DATA").unwrap();
        let conflict_path = test_dir.0.join("conflict_junction");

        let err = reset_directory_with_contender(&conflict_path, "test cache", || {
            let status = std::process::Command::new("cmd")
                .args([
                    "/c",
                    "mklink",
                    "/J",
                    conflict_path.to_str().unwrap(),
                    outside.0.to_str().unwrap(),
                ])
                .status()?;
            if !status.success() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    "mklink /J failed",
                ));
            }
            Ok(())
        })
        .unwrap_err();

        assert!(
            err.contains("test cache is a reparse point"),
            "Expected 'test cache is a reparse point', got: {err}"
        );
        assert_eq!(
            fs::read(&sentinel_path).unwrap(),
            b"OUTSIDE_JUNCTION_SENTINEL_DATA",
            "Outside sentinel file must remain byte-identical"
        );

        let _ = std::fs::remove_dir(&conflict_path);
    }
}
