use crate::protocol::{RunRole, RunSpec, ToolchainGrant, ToolchainGrantRole};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Component, Path, PathBuf};

const MAX_ID_BYTES: usize = 96;
const BUILTIN_TOOLCHAINS_ENV: &str = "JUDGEDESK_BUILTIN_TOOLCHAINS_DIR";
const PACKAGE_RECEIPT: &str = ".judgedesk-package.json";
const MAX_RECEIPT_BYTES: u64 = 16 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PackageReceipt {
    schema_version: u32,
    package_id: String,
    version: String,
    archive_sha256: String,
    entrypoint_component_id: String,
    components: Vec<PackageComponent>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PackageComponent {
    id: String,
    kind: PackageComponentKind,
    relative_path: String,
    roles: Vec<ToolchainGrantRole>,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum PackageComponentKind {
    Executable,
    SupportRoot,
}

#[derive(Debug)]
pub struct ValidatedRun {
    pub executable: PathBuf,
    pub toolchain_package_root: Option<PathBuf>,
    pub workspace: PathBuf,
    pub stdin: Option<PathBuf>,
    pub stdout: PathBuf,
    pub stderr: PathBuf,
}

pub fn validate_run(root: &Path, spec: &RunSpec) -> Result<ValidatedRun, String> {
    let built_in_root = std::env::var_os(BUILTIN_TOOLCHAINS_ENV).map(PathBuf::from);
    validate_run_with_builtin_root(root, spec, built_in_root.as_deref())
}

fn validate_run_with_builtin_root(
    root: &Path,
    spec: &RunSpec,
    built_in_root: Option<&Path>,
) -> Result<ValidatedRun, String> {
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
    validate_environment(&spec.environment)?;
    validate_limits(spec)?;

    let canonical_root =
        fs::canonicalize(root).map_err(|error| format!("executor root unavailable: {error}"))?;
    let workspace = canonical_root.join("workspaces").join(&spec.workspace_id);
    let workspace = canonical_existing_descendant(&canonical_root, &workspace, "workspace")?;
    reject_links_between(&canonical_root, &workspace)?;

    let (executable, toolchain_package_root) = match spec.toolchain.as_ref() {
        Some(grant) => {
            let (executable, package_root) = resolve_builtin_toolchain(spec, grant, built_in_root)?;
            (executable, Some(package_root))
        }
        None => (
            resolve_relative(&canonical_root, &spec.executable_id, true)?,
            None,
        ),
    };
    let in_workspace = executable.starts_with(&workspace);
    let in_toolchains = toolchain_package_root.is_some()
        || executable.starts_with(canonical_root.join("toolchains"));
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
    let isolated_python = spec
        .environment
        .get("JUDGEDESK_PYTHON_ISOLATED")
        .map(String::as_str)
        == Some("1");
    if isolated_python && !matches!(spec.role, RunRole::Submission | RunRole::CheckerRuntime) {
        return Err(
            "the isolated Python marker is valid only for submissions and checker runtimes".into(),
        );
    }
    if matches!(spec.role, RunRole::Checker | RunRole::CheckerRuntime)
        && spec.limits.process_count != 1
    {
        return Err("checker roles require processCount=1".into());
    }
    if let Some(grant) = spec.toolchain.as_ref() {
        validate_grant_role(spec.role, grant.role)?;
        if !in_toolchains {
            return Err("toolchain grant did not resolve inside a trusted toolchain root".into());
        }
    } else if matches!(spec.role, RunRole::CheckerRuntime) {
        if !in_toolchains {
            return Err(
                "checker-runtime executableId must resolve inside the protected toolchain cache"
                    .into(),
            );
        }
    } else if in_toolchains && !matches!(spec.role, RunRole::Compiler) {
        // Submission runtimes retain their legacy typed marker until the language-profile
        // adapter migration lands. Checker runtimes use an explicit role, so an environment
        // variable can no longer downgrade an arbitrary native checker out of LPAC.
        if !matches!(spec.role, RunRole::Submission) || !isolated_python {
            return Err(
                "only compilers, checker runtimes, and verified isolated submission runtimes may execute from toolchain cache"
                    .into(),
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
        toolchain_package_root,
        workspace,
        stdin,
        stdout,
        stderr,
    })
}

fn validate_grant_role(role: RunRole, grant_role: ToolchainGrantRole) -> Result<(), String> {
    let expected = match role {
        RunRole::Compiler => ToolchainGrantRole::Compiler,
        RunRole::Submission => ToolchainGrantRole::SubmissionRuntime,
        RunRole::CheckerRuntime => ToolchainGrantRole::CheckerRuntime,
        RunRole::Checker | RunRole::SecurityProbe => {
            return Err("this executor role cannot use a toolchain grant".into())
        }
    };
    if grant_role != expected {
        return Err("toolchain grant role does not match the executor run role".into());
    }
    Ok(())
}

fn resolve_builtin_toolchain(
    spec: &RunSpec,
    grant: &ToolchainGrant,
    built_in_root: Option<&Path>,
) -> Result<(PathBuf, PathBuf), String> {
    validate_id(&grant.package_id, "toolchain packageId")?;
    validate_id(&grant.component_id, "toolchain componentId")?;
    if grant.package_digest.len() != 64
        || !grant
            .package_digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("toolchain packageDigest is not a lowercase SHA-256 digest".into());
    }
    let trusted_root_value =
        built_in_root.ok_or_else(|| "built-in toolchain root is not configured".to_string())?;
    let trusted_root = fs::canonicalize(trusted_root_value)
        .map_err(|error| format!("built-in toolchain root is unavailable: {error}"))?;
    if !trusted_root.is_dir() {
        return Err("built-in toolchain root is not a directory".into());
    }

    let lexical_package_root = trusted_root.join(&grant.package_id);
    reject_link_or_reparse(&lexical_package_root, "built-in package root")?;
    let package_root = canonical_existing_descendant(
        &trusted_root,
        &lexical_package_root,
        "built-in package root",
    )?;
    let receipt_path = package_root.join(PACKAGE_RECEIPT);
    reject_link_or_reparse(&receipt_path, "built-in package receipt")?;
    let receipt_metadata = fs::metadata(&receipt_path)
        .map_err(|error| format!("built-in package receipt unavailable: {error}"))?;
    if !receipt_metadata.is_file()
        || receipt_metadata.len() == 0
        || receipt_metadata.len() > MAX_RECEIPT_BYTES
    {
        return Err("built-in package receipt has an invalid size".into());
    }
    let receipt_bytes = fs::read(&receipt_path)
        .map_err(|error| format!("cannot read built-in package receipt: {error}"))?;
    let receipt: PackageReceipt = serde_json::from_slice(&receipt_bytes)
        .map_err(|error| format!("built-in package receipt is invalid: {error}"))?;
    if receipt.schema_version != 1
        || receipt.package_id != grant.package_id
        || receipt.archive_sha256 != grant.package_digest
        || receipt.version.is_empty()
        || receipt.version.len() > 128
        || receipt.components.is_empty()
        || receipt.components.len() > 64
        || !receipt.components.iter().any(|component| {
            component.id == receipt.entrypoint_component_id
                && component.kind == PackageComponentKind::Executable
        })
    {
        return Err("built-in package receipt does not match the grant".into());
    }
    let mut component_ids = std::collections::HashSet::new();
    for component in &receipt.components {
        validate_id(&component.id, "toolchain receipt component")?;
        validate_safe_package_relative(&component.relative_path)?;
        if !component_ids.insert(component.id.as_str()) || component.roles.is_empty() {
            return Err("built-in package receipt contains invalid components".into());
        }
    }
    let component = receipt
        .components
        .iter()
        .find(|component| component.id == grant.component_id)
        .ok_or_else(|| "toolchain grant component is absent from the receipt".to_string())?;
    if component.kind != PackageComponentKind::Executable || !component.roles.contains(&grant.role)
    {
        return Err("toolchain grant component does not permit this role".into());
    }
    let expected_id = format!(
        "builtin-toolchains/{}/{}",
        grant.package_id, component.relative_path
    );
    if spec.executable_id != expected_id {
        return Err("executableId does not match the granted toolchain component".into());
    }
    let executable = fs::canonicalize(package_root.join(Path::new(&component.relative_path)))
        .map_err(|error| format!("granted toolchain executable unavailable: {error}"))?;
    if !executable.starts_with(&package_root) || !executable.is_file() {
        return Err("granted toolchain executable escapes its package root".into());
    }
    Ok((executable, package_root))
}

fn validate_safe_package_relative(value: &str) -> Result<(), String> {
    if value == "." {
        return Ok(());
    }
    let relative = Path::new(value);
    if value.is_empty()
        || value.contains('\\')
        || relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("toolchain receipt contains an unsafe component path".into());
    }
    Ok(())
}

fn reject_link_or_reparse(path: &Path, label: &str) -> Result<(), String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|error| format!("{label} unavailable: {error}"))?;
    if metadata.file_type().is_symlink() {
        return Err(format!("{label} cannot be a symbolic link"));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(format!("{label} cannot be a reparse point"));
        }
    }
    Ok(())
}

pub(crate) fn validate_environment(environment: &BTreeMap<String, String>) -> Result<(), String> {
    if environment.len() > 128
        || environment.iter().any(|(key, value)| {
            key.is_empty()
                || key.len() > 256
                || value.len() > 32 * 1024
                || key.contains(['\0', '='])
                || value.contains('\0')
                || !key.bytes().enumerate().all(|(index, byte)| {
                    byte == b'_'
                        || byte.is_ascii_alphabetic()
                        || (index > 0 && byte.is_ascii_digit())
                })
        })
    {
        return Err("environment exceeds protocol limits".into());
    }

    for key in environment.keys() {
        let normalized = key.to_ascii_uppercase();
        let loader_control = normalized.starts_with("DYLD_")
            || normalized.starts_with("__XPC_DYLD_")
            || normalized.starts_with("LD_")
            || normalized.starts_with("MALLOC")
            || matches!(
                normalized.as_str(),
                "LIBGMALLOC" | "_RLD_ROOT" | "LIBPATH" | "SHLIB_PATH"
            );
        let executor_control = normalized.starts_with("JUDGEDESK_TREE_GUARD_")
            || normalized.starts_with("JUDGEDESK_RUN_GUARDIAN_")
            || normalized.starts_with("JUDGEDESK_RUN_SUPERVISOR_")
            || normalized.starts_with("JUDGEDESK_RUN_LAUNCHER_")
            || normalized.starts_with("JUDGEDESK_EXECUTOR_")
            || normalized.starts_with("JUDGEDESK_BOOTSTRAP_")
            || normalized.starts_with("JUDGEDESK_PROBE_")
            || normalized == "JUDGEDESK_SENTINEL"
            || normalized == "JUDGEDESK_START";
        if loader_control || executor_control {
            return Err("environment contains a variable reserved by the secure executor".into());
        }
    }
    Ok(())
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
    use crate::protocol::{RunLimits, ToolchainGrant};
    use std::time::{SystemTime, UNIX_EPOCH};

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

    #[test]
    fn environment_rejects_loader_injection_and_executor_control_keys() {
        for key in [
            "DYLD_INSERT_LIBRARIES",
            "dyld_print_to_file",
            "__XPC_DYLD_LIBRARY_PATH",
            "LD_PRELOAD",
            "MallocStackLogging",
            "LIBGMALLOC",
            "JUDGEDESK_TREE_GUARD_PATH",
            "judgedesk_run_guardian_token",
            "JUDGEDESK_RUN_SUPERVISOR_DIRECT_FD",
            "JUDGEDESK_RUN_LAUNCHER_REGISTRATION_FD",
            "JUDGEDESK_EXECUTOR_PATH",
            "JUDGEDESK_BOOTSTRAP_TOKEN",
            "JUDGEDESK_PROBE_SENTINEL",
        ] {
            let environment = BTreeMap::from([(key.to_string(), "attacker-controlled".into())]);
            assert!(
                validate_environment(&environment).is_err(),
                "accepted reserved environment key {key:?}"
            );
        }
    }

    #[test]
    fn environment_keys_use_a_portable_non_logging_name_alphabet() {
        for key in ["1PATH", "BAD-NAME", "BAD\nNAME", "N\u{00d6}N_ASCII"] {
            let environment = BTreeMap::from([(key.to_string(), "value".into())]);
            assert!(
                validate_environment(&environment).is_err(),
                "accepted non-portable environment key {key:?}"
            );
        }
        assert!(validate_environment(&BTreeMap::from([
            ("_PRIVATE".into(), "1".into()),
            ("Path".into(), "/managed/bin".into()),
        ]))
        .is_ok());
    }

    #[test]
    fn environment_allows_current_compiler_and_managed_python_contracts() {
        let environment = BTreeMap::from([
            ("JUDGEDESK_PYTHON_ISOLATED".into(), "1".into()),
            ("PYTHONNOUSERSITE".into(), "1".into()),
            ("PYTHONDONTWRITEBYTECODE".into(), "1".into()),
            ("PYTHONHOME".into(), "/managed/python".into()),
            ("PATH".into(), "/managed/python/bin".into()),
            (
                "JUDGEDESK_COMPILER_TOOLCHAIN_ROOT".into(),
                "/Library/Developer/CommandLineTools".into(),
            ),
            (
                "JUDGEDESK_COMPILER_DEVELOPER_ROOT".into(),
                "/Library/Developer/CommandLineTools".into(),
            ),
            (
                "JUDGEDESK_COMPILER_EXECUTABLE".into(),
                "/Library/Developer/CommandLineTools/usr/bin/clang".into(),
            ),
            ("COMPILER_PATH".into(), "/managed/gcc/libexec".into()),
            ("LIBRARY_PATH".into(), "/managed/gcc/lib".into()),
        ]);
        assert!(validate_environment(&environment).is_ok());
    }

    #[test]
    fn checker_runtime_is_typed_and_confined_to_the_toolchain_cache() {
        let root = test_root();
        let workspace = root.join("workspaces").join("workspace");
        let runtime = root.join("toolchains").join("python").join("python");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(runtime.parent().unwrap()).unwrap();
        fs::create_dir_all(root.join("artifacts")).unwrap();
        fs::write(&runtime, b"runtime").unwrap();
        fs::write(workspace.join("checker"), b"checker").unwrap();

        let mut spec = sample_spec(RunRole::CheckerRuntime, "toolchains/python/python");
        assert!(validate_run(&root, &spec).is_ok());

        spec.executable_id = "workspaces/workspace/checker".into();
        assert!(validate_run(&root, &spec)
            .unwrap_err()
            .contains("protected toolchain cache"));

        spec.executable_id = "toolchains/python/python".into();
        spec.limits.process_count = 2;
        assert!(validate_run(&root, &spec)
            .unwrap_err()
            .contains("checker roles require processCount=1"));

        spec.role = RunRole::Checker;
        spec.limits.process_count = 1;
        spec.environment
            .insert("JUDGEDESK_PYTHON_ISOLATED".into(), "1".into());
        assert!(validate_run(&root, &spec)
            .unwrap_err()
            .contains("marker is valid only"));

        spec.environment.clear();
        spec.executable_id = "workspaces/workspace/checker".into();
        spec.limits.process_count = 2;
        assert!(validate_run(&root, &spec)
            .unwrap_err()
            .contains("checker roles require processCount=1"));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn built_in_toolchain_grant_is_component_and_role_scoped() {
        let root = test_root();
        let built_in = root.with_extension("built-in");
        let workspace = root.join("workspaces").join("workspace");
        let package = built_in.join("runtime-pack");
        let executable = package.join("bin").join("runtime");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(root.join("artifacts")).unwrap();
        fs::create_dir_all(root.join("toolchains")).unwrap();
        fs::create_dir_all(executable.parent().unwrap()).unwrap();
        fs::write(&executable, b"runtime").unwrap();
        fs::write(
            package.join(PACKAGE_RECEIPT),
            serde_json::to_vec(&serde_json::json!({
                "schemaVersion": 1,
                "packageId": "runtime-pack",
                "version": "1.0.0",
                "archiveSha256": "a".repeat(64),
                "entrypointComponentId": "runtime",
                "components": [
                    {
                        "id": "runtime",
                        "kind": "executable",
                        "relativePath": "bin/runtime",
                        "roles": ["submission-runtime", "checker-runtime"]
                    },
                    {
                        "id": "runtime-root",
                        "kind": "support-root",
                        "relativePath": ".",
                        "roles": ["submission-runtime", "checker-runtime"]
                    }
                ]
            }))
            .unwrap(),
        )
        .unwrap();

        let mut spec = sample_spec(
            RunRole::Submission,
            "builtin-toolchains/runtime-pack/bin/runtime",
        );
        spec.toolchain = Some(ToolchainGrant {
            package_id: "runtime-pack".into(),
            package_digest: "a".repeat(64),
            component_id: "runtime".into(),
            role: ToolchainGrantRole::SubmissionRuntime,
        });
        let validated = validate_run_with_builtin_root(&root, &spec, Some(&built_in)).unwrap();
        assert_eq!(validated.executable, fs::canonicalize(&executable).unwrap());
        assert_eq!(
            validated.toolchain_package_root,
            Some(fs::canonicalize(&package).unwrap())
        );

        spec.toolchain.as_mut().unwrap().role = ToolchainGrantRole::Compiler;
        assert!(
            validate_run_with_builtin_root(&root, &spec, Some(&built_in))
                .unwrap_err()
                .contains("does not permit")
        );
        spec.toolchain.as_mut().unwrap().role = ToolchainGrantRole::SubmissionRuntime;
        spec.toolchain.as_mut().unwrap().package_digest = "b".repeat(64);
        assert!(
            validate_run_with_builtin_root(&root, &spec, Some(&built_in))
                .unwrap_err()
                .contains("does not match")
        );

        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(built_in).unwrap();
    }

    #[test]
    fn a_toolchain_grant_cannot_be_attached_to_a_native_checker() {
        let root = test_root();
        let built_in = root.with_extension("built-in");
        let workspace = root.join("workspaces").join("workspace");
        let package = built_in.join("runtime-pack");
        let executable = package.join("bin").join("runtime");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(root.join("artifacts")).unwrap();
        fs::create_dir_all(root.join("toolchains")).unwrap();
        fs::create_dir_all(executable.parent().unwrap()).unwrap();
        fs::write(&executable, b"runtime").unwrap();
        fs::write(
            package.join(PACKAGE_RECEIPT),
            serde_json::to_vec(&serde_json::json!({
                "schemaVersion": 1,
                "packageId": "runtime-pack",
                "version": "1.0.0",
                "archiveSha256": "a".repeat(64),
                "entrypointComponentId": "runtime",
                "components": [{
                    "id": "runtime",
                    "kind": "executable",
                    "relativePath": "bin/runtime",
                    "roles": ["checker-runtime"]
                }]
            }))
            .unwrap(),
        )
        .unwrap();
        let mut spec = sample_spec(
            RunRole::Checker,
            "builtin-toolchains/runtime-pack/bin/runtime",
        );
        spec.toolchain = Some(ToolchainGrant {
            package_id: "runtime-pack".into(),
            package_digest: "a".repeat(64),
            component_id: "runtime".into(),
            role: ToolchainGrantRole::CheckerRuntime,
        });
        assert!(
            validate_run_with_builtin_root(&root, &spec, Some(&built_in))
                .unwrap_err()
                .contains("this executor role cannot use a toolchain grant")
        );
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(built_in).unwrap();
    }

    fn sample_spec(role: RunRole, executable_id: &str) -> RunSpec {
        RunSpec {
            run_id: "run".into(),
            role,
            workspace_id: "workspace".into(),
            executable_id: executable_id.into(),
            args: Vec::new(),
            stdin_file: None,
            stdout_file: "stdout.txt".into(),
            stderr_file: "stderr.txt".into(),
            environment: BTreeMap::new(),
            toolchain: None,
            limits: RunLimits {
                wall_time_ms: 1_000,
                memory_bytes: 64 * 1024 * 1024,
                process_count: 1,
                thread_count: 16,
                output_bytes: 1_024,
                total_write_bytes: 2_048,
                open_files: 16,
                created_files: 16,
            },
        }
    }

    fn test_root() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "judgedesk-request-validation-{}-{nonce}",
            std::process::id()
        ))
    }
}
