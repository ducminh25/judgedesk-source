use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};

const WORKSPACE_MARKER_FILE: &str = ".judgedesk-workspace";
const WORKSPACE_MARKER_CONTENT: &[u8] = b"judgedesk-owned-workspace-v1\n";

#[cfg(windows)]
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;

/// Checks if a metadata entry represents a symbolic link, Windows junction, or reparse point.
pub fn is_symlink_or_reparse_point(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if (metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT) != 0 {
            return true;
        }
    }
    false
}

/// Validates that a path does not contain NUL bytes, `.`, `..`, or Windows Alternate Data Streams (`:`).
pub fn validate_path_syntax(path: &Path) -> Result<(), String> {
    let raw = path.to_string_lossy();
    if raw.is_empty() {
        return Err("Path must not be empty".to_string());
    }
    if raw.contains('\0') {
        return Err("Path contains NUL byte".to_string());
    }

    // Rust's `Path::components()` silently strips interior `.` segments (e.g. `nested/./file`),
    // so we also inspect raw slash-separated segments directly.
    let raw_without_verbatim = raw.strip_prefix(r"\\?\").unwrap_or(&raw);
    for (idx, segment) in raw_without_verbatim.split(['/', '\\']).enumerate() {
        if segment == "." {
            return Err(format!(
                "Relative current-directory segment ('.') is forbidden in path: {}",
                path.display()
            ));
        }
        if segment == ".." {
            return Err(format!(
                "Relative parent traversal ('..') is forbidden in path: {}",
                path.display()
            ));
        }
        // Allow drive prefix like `C:` only at segment index 0 on Windows
        if segment.contains(':')
            && !(cfg!(windows) && idx == 0 && segment.len() == 2 && segment.as_bytes()[1] == b':')
        {
            return Err(format!(
                "Alternate Data Stream or colon in path segment is forbidden: {}",
                path.display()
            ));
        }
    }

    for component in path.components() {
        match component {
            Component::ParentDir => {
                return Err(format!(
                    "Relative parent traversal ('..') is forbidden in path: {}",
                    path.display()
                ));
            }
            Component::CurDir => {
                return Err(format!(
                    "Relative current-directory component ('.') is forbidden in path: {}",
                    path.display()
                ));
            }
            Component::Normal(part) => {
                let part_str = part.to_string_lossy();
                if part_str.is_empty() {
                    return Err(format!("Empty path component in: {}", path.display()));
                }
                if part_str.contains(':') {
                    return Err(format!(
                        "Alternate Data Stream or colon in path component is forbidden: {}",
                        path.display()
                    ));
                }
            }
            Component::Prefix(_) | Component::RootDir => {}
        }
    }

    Ok(())
}

fn normalize_canonical_path(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let s = path.to_string_lossy();
        if let Some(stripped) = s.strip_prefix(r"\\?\") {
            if stripped.len() >= 2 && stripped.as_bytes()[1] == b':' {
                return PathBuf::from(stripped);
            }
        }
    }
    path
}

/// Walks every existing prefix of `path` (from `stop_at_ancestor` if provided, or from root)
/// and ensures no component along the chain is a symlink, junction, or reparse point.
pub fn ensure_no_reparse_or_symlink_chain(
    path: &Path,
    stop_at_ancestor: Option<&Path>,
) -> Result<(), String> {
    let mut accumulated = PathBuf::new();
    for component in path.components() {
        accumulated.push(component.as_os_str());
        if !matches!(component, Component::Normal(_)) {
            continue;
        }
        if let Some(ancestor) = stop_at_ancestor {
            if accumulated != ancestor && ancestor.starts_with(&accumulated) {
                continue;
            }
        }
        #[cfg(unix)]
        if stop_at_ancestor.is_none()
            && accumulated != path
            && matches!(
                accumulated.to_str(),
                Some(
                    "/var"
                        | "/tmp"
                        | "/etc"
                        | "/home"
                        | "/opt"
                        | "/mnt"
                        | "/srv"
                        | "/run"
                        | "/media"
                        | "/usr"
                        | "/bin"
                        | "/sbin"
                        | "/lib"
                        | "/lib64"
                        | "/var/tmp"
                        | "/var/run"
                        | "/var/home"
                        | "/var/opt"
                        | "/var/mnt"
                        | "/var/srv"
                )
            )
        {
            continue;
        }
        match fs::symlink_metadata(&accumulated) {
            Ok(meta) => {
                if is_symlink_or_reparse_point(&meta) {
                    return Err(format!(
                        "Path traverses a symbolic link or reparse point: {}",
                        accumulated.display()
                    ));
                }
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                // Non-existent tail component; continue checking remaining syntax (already validated).
            }
            Err(err) => {
                return Err(format!(
                    "Failed to inspect path metadata for {}: {err}",
                    accumulated.display()
                ));
            }
        }
    }
    Ok(())
}

/// Validates and canonicalizes an existing directory path, rejecting traversal, ADS, and symlinks/reparse points.
pub fn validate_existing_directory_path(path: &Path) -> Result<PathBuf, String> {
    validate_path_syntax(path)?;
    if !path.is_absolute() {
        return Err(format!(
            "Directory path must be absolute: {}",
            path.display()
        ));
    }
    ensure_no_reparse_or_symlink_chain(path, None)?;
    let meta = fs::symlink_metadata(path)
        .map_err(|e| format!("Directory does not exist ({}): {e}", path.display()))?;
    if is_symlink_or_reparse_point(&meta) {
        return Err(format!(
            "Directory path is a symbolic link or reparse point: {}",
            path.display()
        ));
    }
    if !meta.is_dir() {
        return Err(format!("Path is not a directory: {}", path.display()));
    }
    let canonical = fs::canonicalize(path)
        .map(normalize_canonical_path)
        .map_err(|e| format!("Failed to canonicalize directory {}: {e}", path.display()))?;
    let canonical_meta = fs::symlink_metadata(&canonical).map_err(|e| {
        format!(
            "Failed to inspect canonical directory {}: {e}",
            canonical.display()
        )
    })?;
    if is_symlink_or_reparse_point(&canonical_meta) || !canonical_meta.is_dir() {
        return Err(format!(
            "Canonicalized path is not a safe directory: {}",
            canonical.display()
        ));
    }
    Ok(canonical)
}

/// Ensures `candidate` (relative to `root` or absolute inside `root`) is strictly contained within `root`,
/// free of `..`, `.`, Windows ADS (`:`), and symlinks / junctions / reparse points.
/// Returns the canonicalized (or canonical-ancestor-resolved) path inside `root`.
pub fn ensure_safe_contained_path(root: &Path, candidate: &Path) -> Result<PathBuf, String> {
    let canonical_root = validate_existing_directory_path(root)?;
    validate_path_syntax(candidate)?;

    let combined = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        root.join(candidate)
    };
    validate_path_syntax(&combined)?;

    // Check every existing component from `root` downward for symlinks/junctions/reparse points
    ensure_no_reparse_or_symlink_chain(&combined, Some(root))?;

    // Find the deepest existing ancestor of `combined` and collect remaining normal tail components
    let mut existing_ancestor = combined.as_path();
    let mut missing_tail: Vec<std::ffi::OsString> = Vec::new();
    while !existing_ancestor.exists() {
        let file_name = existing_ancestor.file_name().ok_or_else(|| {
            format!(
                "Cannot resolve existing ancestor for candidate {}",
                candidate.display()
            )
        })?;
        missing_tail.push(file_name.to_os_string());
        existing_ancestor = existing_ancestor.parent().ok_or_else(|| {
            format!(
                "Candidate path has no existing parent directory: {}",
                candidate.display()
            )
        })?;
    }

    let ancestor_meta = fs::symlink_metadata(existing_ancestor).map_err(|e| {
        format!(
            "Failed to inspect ancestor metadata {}: {e}",
            existing_ancestor.display()
        )
    })?;
    if is_symlink_or_reparse_point(&ancestor_meta) {
        return Err(format!(
            "Ancestor is a symbolic link or reparse point: {}",
            existing_ancestor.display()
        ));
    }

    let canonical_ancestor = fs::canonicalize(existing_ancestor)
        .map(normalize_canonical_path)
        .map_err(|e| {
            format!(
                "Failed to canonicalize ancestor {}: {e}",
                existing_ancestor.display()
            )
        })?;
    if !canonical_ancestor.starts_with(&canonical_root) {
        return Err(format!(
            "Path escapes containment root {} -> {}",
            canonical_root.display(),
            canonical_ancestor.display()
        ));
    }

    let mut resolved = canonical_ancestor;
    for part in missing_tail.into_iter().rev() {
        let part_str = part.to_string_lossy();
        if part_str == "." || part_str == ".." || part_str.contains(':') || part_str.contains('\0')
        {
            return Err(format!(
                "Hostile path segment '{}' in {}",
                part_str,
                candidate.display()
            ));
        }
        resolved.push(part);
    }

    if !resolved.starts_with(&canonical_root) {
        return Err(format!(
            "Resolved path {} is outside root {}",
            resolved.display(),
            canonical_root.display()
        ));
    }

    Ok(resolved)
}

/// Safely removes a directory tree without following symbolic links or Windows junctions/reparse points.
fn remove_dir_tree_no_follow(dir: &Path) -> Result<(), String> {
    let meta = match fs::symlink_metadata(dir) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => {
            return Err(format!(
                "Failed to read metadata for {}: {e}",
                dir.display()
            ))
        }
    };

    // Never recurse into a symlink or reparse point (e.g. Windows junction)
    if is_symlink_or_reparse_point(&meta) {
        if meta.is_dir() {
            fs::remove_dir(dir)
                .or_else(|_| fs::remove_file(dir))
                .map_err(|e| {
                    format!(
                        "Failed to unlink directory symlink/reparse point {}: {e}",
                        dir.display()
                    )
                })?;
        } else {
            fs::remove_file(dir)
                .or_else(|_| fs::remove_dir(dir))
                .map_err(|e| {
                    format!(
                        "Failed to unlink file symlink/reparse point {}: {e}",
                        dir.display()
                    )
                })?;
        }
        return Ok(());
    }

    if !meta.is_dir() {
        fs::remove_file(dir)
            .map_err(|e| format!("Failed to remove file {}: {e}", dir.display()))?;
        return Ok(());
    }

    let entries = fs::read_dir(dir)
        .map_err(|e| format!("Failed to list directory {}: {e}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read entry in {}: {e}", dir.display()))?;
        let child_path = entry.path();
        let child_meta = fs::symlink_metadata(&child_path).map_err(|e| {
            format!(
                "Failed to inspect child metadata {}: {e}",
                child_path.display()
            )
        })?;
        if is_symlink_or_reparse_point(&child_meta) {
            if child_meta.is_dir() {
                fs::remove_dir(&child_path)
                    .or_else(|_| fs::remove_file(&child_path))
                    .map_err(|e| {
                        format!(
                            "Failed to remove junction/symlink directory {}: {e}",
                            child_path.display()
                        )
                    })?;
            } else {
                fs::remove_file(&child_path)
                    .or_else(|_| fs::remove_dir(&child_path))
                    .map_err(|e| {
                        format!(
                            "Failed to remove symlink file {}: {e}",
                            child_path.display()
                        )
                    })?;
            }
        } else if child_meta.is_dir() {
            remove_dir_tree_no_follow(&child_path)?;
        } else {
            fs::remove_file(&child_path)
                .map_err(|e| format!("Failed to remove file {}: {e}", child_path.display()))?;
        }
    }

    fs::remove_dir(dir).map_err(|e| format!("Failed to remove directory {}: {e}", dir.display()))
}

/// An owned temporary workspace directory guarded by an ownership marker and strict path containment.
#[derive(Debug)]
pub struct OwnedWorkspace {
    root: PathBuf,
    cleaned: bool,
}

impl OwnedWorkspace {
    /// Creates a new uniquely named workspace directory inside `base_dir` and writes an ownership marker.
    pub fn create(base_dir: &Path, prefix: &str) -> Result<Self, String> {
        let simple_uuid = uuid::Uuid::new_v4().simple().to_string();
        let dir_name = format!("{prefix}_{simple_uuid}");
        Self::create_with_id(base_dir, &dir_name)
    }

    /// Creates a workspace directory with an explicit `workspace_id` inside `base_dir` and writes an ownership marker.
    pub fn create_with_id(base_dir: &Path, workspace_id: &str) -> Result<Self, String> {
        if workspace_id.is_empty()
            || workspace_id.contains('/')
            || workspace_id.contains('\\')
            || workspace_id.contains("..")
            || workspace_id.contains(':')
            || workspace_id.contains('\0')
        {
            return Err(format!("Invalid workspace identifier: {workspace_id}"));
        }

        if !base_dir.exists() {
            fs::create_dir_all(base_dir).map_err(|e| {
                format!(
                    "Failed to create workspace base directory {}: {e}",
                    base_dir.display()
                )
            })?;
        }
        let canonical_base = validate_existing_directory_path(base_dir)?;

        let ws_path = canonical_base.join(workspace_id);
        if let Ok(existing_meta) = fs::symlink_metadata(&ws_path) {
            if is_symlink_or_reparse_point(&existing_meta) || !existing_meta.is_dir() {
                return Err(format!(
                    "Refusing to overwrite non-directory or symlink/reparse point at workspace path: {}",
                    ws_path.display()
                ));
            }
            let existing_marker = ws_path.join(WORKSPACE_MARKER_FILE);
            let marker_meta = fs::symlink_metadata(&existing_marker).map_err(|e| {
                format!(
                    "Refusing to overwrite existing unmarked directory {}: {e}",
                    ws_path.display()
                )
            })?;
            if is_symlink_or_reparse_point(&marker_meta)
                || fs::read(&existing_marker).ok().as_deref() != Some(WORKSPACE_MARKER_CONTENT)
            {
                return Err(format!(
                    "Refusing to overwrite directory with invalid ownership marker: {}",
                    ws_path.display()
                ));
            }
            remove_dir_tree_no_follow(&ws_path)?;
        }
        fs::create_dir(&ws_path)
            .map_err(|e| format!("Failed to create workspace {}: {e}", ws_path.display()))?;

        let canonical_ws = validate_existing_directory_path(&ws_path)?;
        if !canonical_ws.starts_with(&canonical_base) {
            let _ = fs::remove_dir(&ws_path);
            return Err(format!(
                "Workspace {} escaped base directory {}",
                canonical_ws.display(),
                canonical_base.display()
            ));
        }

        let marker_path = canonical_ws.join(WORKSPACE_MARKER_FILE);
        let mut marker_file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&marker_path)
            .map_err(|e| format!("Failed to create workspace ownership marker: {e}"))?;
        marker_file
            .write_all(WORKSPACE_MARKER_CONTENT)
            .map_err(|e| format!("Failed to write workspace ownership marker: {e}"))?;

        Ok(Self {
            root: canonical_ws,
            cleaned: false,
        })
    }

    /// Creates a new owned workspace inside the OS temporary directory.
    pub fn create_in_temp(prefix: &str) -> Result<Self, String> {
        let base_temp = fs::canonicalize(std::env::temp_dir())
            .map(normalize_canonical_path)
            .unwrap_or_else(|_| std::env::temp_dir());
        let temp_base = base_temp.join("judgedesk_workspaces");
        Self::create(&temp_base, prefix)
    }

    /// Returns the canonical root path of the workspace.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Resolves and validates a relative or child path inside this workspace.
    pub fn resolve_contained_path(&self, relative_or_child: &Path) -> Result<PathBuf, String> {
        ensure_safe_contained_path(&self.root, relative_or_child)
    }

    /// Writes `contents` to a contained path inside the workspace, creating intermediate directories safely.
    pub fn write_file(&self, relative_path: &Path, contents: &[u8]) -> Result<PathBuf, String> {
        let target = self.resolve_contained_path(relative_path)?;
        if target == self.root.join(WORKSPACE_MARKER_FILE) {
            return Err("Refusing to overwrite workspace ownership marker".to_string());
        }
        if let Some(parent) = target.parent() {
            if !parent.exists() {
                fs::create_dir_all(parent).map_err(|e| {
                    format!(
                        "Failed to create parent directory {}: {e}",
                        parent.display()
                    )
                })?;
            }
            // Re-verify after directory creation to guard against TOCTOU symlink/reparse-point swaps
            let _ = ensure_safe_contained_path(&self.root, relative_path)?;
        }
        if let Ok(meta) = fs::symlink_metadata(&target) {
            if is_symlink_or_reparse_point(&meta) {
                return Err(format!(
                    "Refusing to write through symlink or reparse point: {}",
                    target.display()
                ));
            }
        }
        fs::write(&target, contents)
            .map_err(|e| format!("Failed to write file {}: {e}", target.display()))?;
        Ok(target)
    }

    /// Reads bytes from a contained file inside the workspace, rejecting symlinks and reparse points.
    pub fn read_file(&self, relative_path: &Path) -> Result<Vec<u8>, String> {
        let target = self.resolve_contained_path(relative_path)?;
        let meta = fs::symlink_metadata(&target)
            .map_err(|e| format!("Failed to stat file {}: {e}", target.display()))?;
        if is_symlink_or_reparse_point(&meta) {
            return Err(format!(
                "Refusing to read symlink or reparse point: {}",
                target.display()
            ));
        }
        if !meta.is_file() {
            return Err(format!("Path is not a regular file: {}", target.display()));
        }
        fs::read(&target).map_err(|e| format!("Failed to read file {}: {e}", target.display()))
    }

    /// Safely deletes the workspace after verifying ownership marker and non-reparse root.
    pub fn cleanup(&mut self) -> Result<(), String> {
        if self.cleaned {
            return Ok(());
        }
        if !self.root.exists() {
            self.cleaned = true;
            return Ok(());
        }

        let root_meta = fs::symlink_metadata(&self.root).map_err(|e| {
            format!(
                "Failed to inspect workspace root {}: {e}",
                self.root.display()
            )
        })?;
        if is_symlink_or_reparse_point(&root_meta) {
            return Err(format!(
                "Refusing to clean up workspace root that became a symlink/reparse point: {}",
                self.root.display()
            ));
        }

        let marker_path = self.root.join(WORKSPACE_MARKER_FILE);
        let marker_meta = fs::symlink_metadata(&marker_path).map_err(|e| {
            format!(
                "Refusing to delete unmarked workspace {}: {e}",
                self.root.display()
            )
        })?;
        if is_symlink_or_reparse_point(&marker_meta) {
            return Err(format!(
                "Workspace ownership marker is a symlink/reparse point: {}",
                marker_path.display()
            ));
        }
        let marker_bytes = fs::read(&marker_path).map_err(|e| {
            format!(
                "Failed to read workspace ownership marker {}: {e}",
                marker_path.display()
            )
        })?;
        if marker_bytes != WORKSPACE_MARKER_CONTENT {
            return Err(format!(
                "Workspace ownership marker content mismatch in {}",
                self.root.display()
            ));
        }

        remove_dir_tree_no_follow(&self.root)?;
        self.cleaned = true;
        Ok(())
    }
}

impl Drop for OwnedWorkspace {
    fn drop(&mut self) {
        let _ = self.cleanup();
    }
}
