use std::fs;
use std::path::{Path, PathBuf};

pub fn initialize_root(platform_root: PathBuf) -> Result<PathBuf, String> {
    let root = platform_root.join("JudgeDeskExecutor");
    fs::create_dir_all(root.join("workspaces"))
        .and_then(|_| fs::create_dir_all(root.join("toolchains")))
        .map_err(|error| format!("cannot initialize executor root: {error}"))?;
    for (name, description) in [
        ("artifacts", "executor artifact cache"),
        ("profiles", "Seatbelt profile cache"),
    ] {
        let directory = root.join(name);
        if directory.exists() {
            fs::remove_dir_all(&directory)
                .map_err(|error| format!("cannot clear {description}: {error}"))?;
        }
        fs::create_dir_all(&directory)
            .map_err(|error| format!("cannot initialize {description}: {error}"))?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let profiles = root.join("profiles");
        for (directory, description) in [
            (root.as_path(), "executor root"),
            (profiles.as_path(), "Seatbelt profile cache"),
        ] {
            fs::set_permissions(directory, fs::Permissions::from_mode(0o700))
                .map_err(|error| format!("cannot protect {description}: {error}"))?;
        }
    }
    Ok(root)
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
