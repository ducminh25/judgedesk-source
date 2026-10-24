//! Activation of an already verified directory under an exclusive import lock.
use std::fs;
use std::path::{Path, PathBuf};

fn previous_path(destination: &Path) -> Result<PathBuf, String> {
    let name = destination
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("Invalid package destination")?;
    if !destination.is_absolute() || name.is_empty() {
        return Err("Package destination must be absolute".into());
    }
    Ok(destination.with_file_name(format!("{name}.previous")))
}

fn regular_directory(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => Ok(true),
        Ok(_) => Err(format!(
            "Package import rejects a non-directory or link: {}",
            path.display()
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

pub fn recover_previous_directory(destination: &Path) -> Result<(), String> {
    let previous = previous_path(destination)?;
    if regular_directory(&previous)? && !regular_directory(destination)? {
        fs::rename(&previous, destination)
            .map_err(|e| format!("Cannot recover interrupted package activation: {e}"))?;
    }
    Ok(())
}

/// Call only after validating the active tree, while holding the import lock.
pub fn cleanup_previous_directory(destination: &Path) -> Result<(), String> {
    let previous = previous_path(destination)?;
    if !regular_directory(destination)? {
        return Err("Cannot clean previous package before an active directory exists".into());
    }
    if regular_directory(&previous)? {
        fs::remove_dir_all(previous).map_err(|e| format!("Cannot clean previous package: {e}"))?;
    }
    Ok(())
}

/// The caller verifies the stage's trusted file index before this operation.
/// A crash between renames leaves the previous tree available for recovery.
pub fn commit_verified_directory(staged: &Path, destination: &Path) -> Result<(), String> {
    let previous = previous_path(destination)?;
    if !staged.is_absolute()
        || staged.parent() != destination.parent()
        || staged == destination
        || staged == previous
        || !regular_directory(staged)?
    {
        return Err("Package stage must be a separate regular sibling directory".into());
    }
    recover_previous_directory(destination)?;
    let had_previous = regular_directory(destination)?;
    if had_previous {
        // Both the source and the incoming stage have already been verified by
        // the caller. A leftover backup from an older completed activation can
        // now be replaced without deleting the current destination first.
        cleanup_previous_directory(destination)?;
        fs::rename(destination, &previous)
            .map_err(|e| format!("Cannot back up current package: {e}"))?;
    }
    if let Err(error) = fs::rename(staged, destination) {
        if had_previous {
            fs::rename(&previous, destination).map_err(|rollback| {
                format!(
                    "Activation failed: {error}; rollback remains at {}: {rollback}",
                    previous.display()
                )
            })?;
        }
        return Err(format!("Cannot activate verified package: {error}"));
    }
    cleanup_previous_directory(destination)
}
