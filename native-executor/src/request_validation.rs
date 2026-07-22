use crate::protocol::{RunRole, RunSpec};
use std::fs;
use std::path::{Component, Path, PathBuf};

const MAX_ID_BYTES: usize = 96;

pub struct ValidatedRun {
    pub executable: PathBuf,
    pub workspace: PathBuf,
    pub stdin: Option<PathBuf>,
    pub stdout: PathBuf,
    pub stderr: PathBuf,
}

pub fn validate_run(root: &Path, spec: &RunSpec) -> Result<ValidatedRun, String> {
    validate_id(&spec.run_id, "runId")?;
    validate_id(&spec.workspace_id, "workspaceId")?;
    if spec.args.len() > 128
        || spec
            .args
            .iter()
            .any(|value| value.len() > 32 * 1024 || value.contains('\0'))
    {
        return Err("arguments exceed protocol limits".into());
    }
    if spec.environment.len() > 128
        || spec.environment.iter().any(|(key, value)| {
            key.is_empty()
                || key.len() > 256
                || value.len() > 32 * 1024
                || key.contains(['\0', '='])
                || value.contains('\0')
        })
    {
        return Err("environment exceeds protocol limits".into());
    }
    validate_limits(spec)?;

    let canonical_root =
        fs::canonicalize(root).map_err(|error| format!("executor root unavailable: {error}"))?;
    let workspace = canonical_root.join("workspaces").join(&spec.workspace_id);
    let workspace = canonical_existing_descendant(&canonical_root, &workspace, "workspace")?;
    reject_links_between(&canonical_root, &workspace)?;

    let executable = resolve_relative(&canonical_root, &spec.executable_id, true)?;
    let in_workspace = executable.starts_with(&workspace);
    let in_toolchains = executable.starts_with(canonical_root.join("toolchains"));
    let in_artifacts = executable.starts_with(canonical_root.join("artifacts"));
    if !in_workspace && !in_toolchains && !in_artifacts {
        return Err(
            "executableId must resolve inside the run workspace, artifact cache, or managed toolchain cache".into(),
        );
    }
    if in_artifacts
        && !matches!(
            spec.role,
            RunRole::Submission | RunRole::Checker | RunRole::SecurityProbe
        )
    {
        return Err(
            "only submissions, checkers, and the startup security probe may execute from artifact cache"
                .into(),
        );
    }
    if in_toolchains
        && matches!(
            spec.role,
            RunRole::Submission | RunRole::Checker | RunRole::SecurityProbe
        )
    {
        // Python submissions are allowed to reference an isolated interpreter cache. Node marks
        // those runs with JUDGEDESK_PYTHON_ISOLATED after verifying a managed runtime.
        if spec
            .environment
            .get("JUDGEDESK_PYTHON_ISOLATED")
            .map(String::as_str)
            != Some("1")
        {
            return Err(
                "only a verified isolated Python runtime may execute from toolchain cache".into(),
            );
        }
    }
    if !executable.is_file() {
        return Err("executableId does not identify a regular file".into());
    }

    let stdin = match &spec.stdin_file {
        Some(value) => Some(resolve_workspace_file(&workspace, value, true)?),
        None => None,
    };
    let stdout = resolve_workspace_file(&workspace, &spec.stdout_file, false)?;
    let stderr = resolve_workspace_file(&workspace, &spec.stderr_file, false)?;
    Ok(ValidatedRun {
        executable,
        workspace,
        stdin,
        stdout,
        stderr,
    })
}

fn validate_limits(spec: &RunSpec) -> Result<(), String> {
    let limits = &spec.limits;
    if limits.wall_time_ms == 0 || limits.wall_time_ms > 300_000 {
        return Err("wallTimeMs is outside the supported range".into());
    }
    if limits.memory_bytes < 8 * 1024 * 1024 || limits.memory_bytes > 16 * 1024 * 1024 * 1024 {
        return Err("memoryBytes is outside the supported range".into());
    }
    if limits.process_count == 0
        || limits.process_count > 32
        || limits.thread_count == 0
        || limits.thread_count > 256
        || limits.open_files == 0
        || limits.open_files > 1024
        || limits.created_files == 0
        || limits.created_files > 4096
    {
        return Err("process, thread, or file-count limit is outside the supported range".into());
    }
    if limits.output_bytes == 0 || limits.total_write_bytes < limits.output_bytes {
        return Err("output/write limits are invalid".into());
    }
    Ok(())
}

fn validate_id(value: &str, field: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > MAX_ID_BYTES
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(format!("{field} contains invalid characters"));
    }
    Ok(())
}

fn resolve_relative(root: &Path, value: &str, must_exist: bool) -> Result<PathBuf, String> {
    let relative = Path::new(value);
    if relative.is_absolute()
        || relative
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("path must be a normalized relative path".into());
    }
    let candidate = root.join(relative);
    if must_exist {
        canonical_existing_descendant(root, &candidate, "path")
    } else {
        let parent = candidate
            .parent()
            .ok_or_else(|| "path has no parent".to_string())?;
        let parent = canonical_existing_descendant(root, parent, "path parent")?;
        Ok(parent.join(
            candidate
                .file_name()
                .ok_or_else(|| "path has no filename".to_string())?,
        ))
    }
}

fn resolve_workspace_file(
    workspace: &Path,
    value: &str,
    must_exist: bool,
) -> Result<PathBuf, String> {
    let relative = Path::new(value);
    if relative.is_absolute()
        || relative
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("workspace file path is not normalized".into());
    }
    let candidate = workspace.join(relative);
    if must_exist {
        canonical_existing_descendant(workspace, &candidate, "workspace file")
    } else {
        let parent = candidate
            .parent()
            .ok_or_else(|| "workspace file has no parent".to_string())?;
        if parent == workspace {
            return Ok(candidate);
        }
        let parent = canonical_existing_descendant(workspace, parent, "workspace file parent")?;
        Ok(parent.join(
            candidate
                .file_name()
                .ok_or_else(|| "workspace file has no filename".to_string())?,
        ))
    }
}

fn canonical_existing_descendant(
    root: &Path,
    candidate: &Path,
    label: &str,
) -> Result<PathBuf, String> {
    let canonical =
        fs::canonicalize(candidate).map_err(|error| format!("{label} unavailable: {error}"))?;
    if !canonical.starts_with(root) {
        return Err(format!("{label} escapes executor root"));
    }
    Ok(canonical)
}

fn reject_links_between(root: &Path, target: &Path) -> Result<(), String> {
    let relative = target
        .strip_prefix(root)
        .map_err(|_| "path escapes executor root")?;
    let mut current = root.to_path_buf();
    for part in relative.components() {
        current.push(part);
        let metadata = fs::symlink_metadata(&current)
            .map_err(|error| format!("cannot inspect path: {error}"))?;
        if metadata.file_type().is_symlink() {
            return Err("symlink/reparse paths are not allowed in executor workspaces".into());
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
            if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                return Err("symlink/reparse paths are not allowed in executor workspaces".into());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_reject_traversal_and_separators() {
        for value in ["", "../run", "run/path", "run\\path", "run id"] {
            assert!(validate_id(value, "id").is_err(), "accepted {value:?}");
        }
        assert!(validate_id("run_123-abc", "id").is_ok());
    }

    #[test]
    fn relative_paths_reject_parent_and_absolute_components() {
        let root = fs::canonicalize(std::env::temp_dir()).unwrap();
        assert!(resolve_relative(&root, "../outside", false).is_err());
        assert!(resolve_relative(&root, "/outside", false).is_err());
        assert!(resolve_relative(&root, "file", false).is_ok());
    }
}
