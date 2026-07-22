use std::fs;
use std::path::{Path, PathBuf};

pub fn initialize_root(platform_root: PathBuf) -> Result<PathBuf, String> {
    let root = platform_root.join("JudgeDeskExecutor");
    fs::create_dir_all(root.join("workspaces"))
        .and_then(|_| fs::create_dir_all(root.join("toolchains")))
        .map_err(|error| format!("cannot initialize executor root: {error}"))?;
    let artifacts = root.join("artifacts");
    if artifacts.exists() {
        fs::remove_dir_all(&artifacts)
            .map_err(|error| format!("cannot clear executor artifact cache: {error}"))?;
    }
    fs::create_dir_all(&artifacts)
        .map_err(|error| format!("cannot initialize executor artifact cache: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("cannot protect executor root: {error}"))?;
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
