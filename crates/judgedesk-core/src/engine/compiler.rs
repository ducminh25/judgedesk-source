use crate::executor_client::ExecutorClient;
use crate::storage::OwnedWorkspace;
use crate::toolchains::discovery::{
    clean_canonical_path, ensure_cached_managed_toolchain, find_fpc_units_dir,
    fpc_host_target_triple, managed_cache_id, normalize_language_kind, read_package_receipt,
    resolve_macos_framework_python_executable, resolve_toolchain_for_profile, ResolvedToolchain,
};
use judgedesk_native_executor::protocol::{
    LocalToolchainGrant, LocalToolchainIsolation, RunLimits, RunReason, RunRole, RunSpec,
    ToolchainGrant, ToolchainGrantRole,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

pub const SUBMISSION_COMPILE_WALL_TIME_MS: u64 = 15_000;
pub const CHECKER_COMPILE_WALL_TIME_MS: u64 = 60_000;

const MAX_PROJECT_JSON_BYTES: usize = 16 * 1024 * 1024;
const MAX_ARCHIVE_ENTRY_BYTES: usize = 64 * 1024 * 1024;
const MAX_ARCHIVE_UNCOMPRESSED_BYTES: usize = 256 * 1024 * 1024;
const MAX_COMPILED_BINARY_BYTES: u64 = 32 * 1024 * 1024;

static COMPILE_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompilationFailureProvenance {
    SubmissionError,
    JudgeEnvironment,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompilationOutput {
    pub status: String, // "OK", "CE", "JE"
    pub error: Option<String>,
    pub executable: Option<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provenance: Option<CompilationFailureProvenance>,
}

impl CompilationOutput {
    pub fn ok(executable: PathBuf) -> Self {
        Self {
            status: "OK".to_string(),
            error: None,
            executable: Some(executable),
            provenance: None,
        }
    }

    pub fn submission_ce(message: impl Into<String>) -> Self {
        Self {
            status: "CE".to_string(),
            error: Some(message.into()),
            executable: None,
            provenance: Some(CompilationFailureProvenance::SubmissionError),
        }
    }

    pub fn environment_je(message: impl Into<String>) -> Self {
        Self {
            status: "JE".to_string(),
            error: Some(message.into()),
            executable: None,
            provenance: Some(CompilationFailureProvenance::JudgeEnvironment),
        }
    }
}

pub struct CompileSubmissionRequest<'a> {
    pub language: &'a str,
    pub source_path: &'a Path,
    pub output_dir: &'a Path,
    pub platform: &'a ExecutorClient,
    pub timeout_ms: Option<u64>,
    pub extra_include_dirs: &'a [PathBuf],
}

pub fn compile_submission(
    language: &str,
    _source_path: &Path,
    _output_dir: &Path,
) -> CompilationOutput {
    CompilationOutput::environment_je(format!(
        "COMPILER_REQUIRES_SANDBOX_EXECUTOR: direct host compilation for '{language}' is disabled; use compile_submission_with_executor"
    ))
}

pub fn compile_checker(checker_path: &Path, _output_dir: &Path) -> CompilationOutput {
    let lower = checker_path.to_string_lossy().to_lowercase();
    if lower.ends_with(".exe") || lower.ends_with(".py") || (!cfg!(windows) && !lower.contains('.'))
    {
        return CompilationOutput::ok(checker_path.to_path_buf());
    }
    CompilationOutput::environment_je(
        "CHECKER_COMPILER_REQUIRES_SANDBOX_EXECUTOR: direct host checker compilation is disabled; use compile_checker_with_executor",
    )
}

pub fn compile_checker_with_executor(
    checker_path: &Path,
    output_dir: &Path,
    platform: &ExecutorClient,
) -> CompilationOutput {
    let lower = checker_path.to_string_lossy().to_lowercase();
    if lower.ends_with(".exe") || (!cfg!(windows) && !lower.contains('.')) {
        return CompilationOutput::ok(checker_path.to_path_buf());
    }
    let checker_stem = checker_path
        .file_stem()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("checker");
    let checker_out_dir = output_dir
        .join("__judgedesk_checker_build")
        .join(checker_stem);
    let _ = fs::create_dir_all(&checker_out_dir);
    if lower.ends_with(".py") {
        return compile_submission_with_executor(CompileSubmissionRequest {
            language: "python",
            source_path: checker_path,
            output_dir: &checker_out_dir,
            platform,
            timeout_ms: Some(CHECKER_COMPILE_WALL_TIME_MS),
            extra_include_dirs: &[],
        });
    }
    if lower.ends_with(".cpp") || lower.ends_with(".cc") || lower.ends_with(".cxx") {
        let mut include_dirs = Vec::new();
        if let Some(parent) = checker_path.parent() {
            if parent.join("testlib.h").is_file() {
                include_dirs.push(parent.to_path_buf());
            }
        }
        let judgers_dir = Path::new("judgers");
        if judgers_dir.join("testlib.h").is_file() {
            include_dirs.push(judgers_dir.to_path_buf());
        }
        if include_dirs.is_empty() {
            let staged_testlib = checker_out_dir.join("testlib.h");
            if fs::write(
                &staged_testlib,
                include_bytes!("../../../../judgers/testlib.h"),
            )
            .is_ok()
            {
                include_dirs.push(checker_out_dir.clone());
            }
        }
        return compile_submission_with_executor(CompileSubmissionRequest {
            language: "cpp",
            source_path: checker_path,
            output_dir: &checker_out_dir,
            platform,
            timeout_ms: Some(CHECKER_COMPILE_WALL_TIME_MS),
            extra_include_dirs: &include_dirs,
        });
    }
    CompilationOutput::submission_ce(format!(
        "Unsupported custom checker file format: {}",
        checker_path.display()
    ))
}

pub fn compile_submission_with_executor(req: CompileSubmissionRequest<'_>) -> CompilationOutput {
    compile_submission_with_config(req, None)
}

pub fn compile_submission_with_config(
    req: CompileSubmissionRequest<'_>,
    compile_config: Option<&crate::discovery::ProblemCompileConfig>,
) -> CompilationOutput {
    compile_submission_with_selection(req, compile_config, None, None)
}

pub fn compile_submission_with_selection(
    req: CompileSubmissionRequest<'_>,
    compile_config: Option<&crate::discovery::ProblemCompileConfig>,
    preferred_mode: Option<&str>,
    custom_path: Option<&str>,
) -> CompilationOutput {
    let health = req.platform.health();
    if !health.ready || req.platform.is_admission_closed() {
        return CompilationOutput::environment_je(format!(
            "SECURE_RUNNER_UNAVAILABLE: {}",
            health.diagnostics.join("; ")
        ));
    }
    if !req.source_path.is_file() {
        return CompilationOutput::environment_je(format!(
            "SOURCE_FILE_MISSING: {}",
            req.source_path.display()
        ));
    }
    if let Err(err) = fs::create_dir_all(req.output_dir) {
        return CompilationOutput::environment_je(format!(
            "OUTPUT_DIR_UNAVAILABLE: failed to create {}: {err}",
            req.output_dir.display()
        ));
    }

    let kind = match req.language.trim().to_ascii_lowercase().as_str() {
        "cpp" | "c++" | "cc" | "cxx" => "cpp",
        "c" => "c",
        "python" | "py" | "python3" => "python",
        "pascal" | "pas" | "pp" | "fpc" => "pascal",
        "java" => "java",
        "scratch" | "sb3" | "sb2" => "scratch",
        other => {
            return CompilationOutput::submission_ce(format!("Unsupported language: {other}"));
        }
    };

    let toolchain = resolve_toolchain_for_profile(kind, preferred_mode, custom_path);
    if !toolchain.ready || !toolchain.executable_path.is_file() {
        let diag = toolchain
            .diagnostic
            .unwrap_or_else(|| format!("TOOLCHAIN_{}_MISSING", kind.to_ascii_uppercase()));
        return CompilationOutput::environment_je(diag);
    }

    compile_resolved_submission(req, &toolchain, compile_config)
}

// Diagnostics and judging must exercise the same compiler invocation and mounts.
// The caller has already checked executor health and resolved this exact selection.
pub(crate) fn compile_resolved_submission(
    req: CompileSubmissionRequest<'_>,
    toolchain: &ResolvedToolchain,
    compile_config: Option<&crate::discovery::ProblemCompileConfig>,
) -> CompilationOutput {
    let kind = toolchain.kind.as_str();
    let timeout_ms = req.timeout_ms.unwrap_or(SUBMISSION_COMPILE_WALL_TIME_MS);

    match kind {
        "scratch" => compile_scratch_submission(req.source_path, req.output_dir),
        "python" => compile_python_submission(&req, toolchain, timeout_ms),
        "java" => compile_java_submission(&req, toolchain, timeout_ms),
        "cpp" | "c" | "pascal" => {
            compile_native_submission(kind, &req, toolchain, timeout_ms, compile_config)
        }
        _ => CompilationOutput::submission_ce(format!(
            "Unsupported language: {}",
            normalize_language_kind(kind)
        )),
    }
}

#[cfg(target_os = "macos")]
fn infer_darwin_developer_root_from_path(path: &Path) -> Option<PathBuf> {
    let canon = clean_canonical_path(path);
    let clt = Path::new("/Library/Developer/CommandLineTools");
    if clt.is_dir() {
        let clt_canon = clean_canonical_path(clt);
        if canon == clt_canon || canon.starts_with(&clt_canon) {
            return Some(clt_canon);
        }
    }
    canon
        .ancestors()
        .find(|cand| {
            cand.file_name().and_then(|n| n.to_str()) == Some("Developer")
                && cand
                    .parent()
                    .and_then(|p| p.file_name())
                    .and_then(|n| n.to_str())
                    == Some("Contents")
                && cand
                    .parent()
                    .and_then(|p| p.parent())
                    .and_then(|p| p.extension())
                    .and_then(|e| e.to_str())
                    == Some("app")
                && cand.starts_with("/Applications")
        })
        .map(Path::to_path_buf)
}

#[cfg(target_os = "macos")]
fn resolve_macos_sdk_path_for_developer_root(developer_root: &Path) -> Option<String> {
    let dev_canon = clean_canonical_path(developer_root);
    if let Ok(sdk) = std::env::var("SDKROOT") {
        let trimmed = sdk.trim();
        if !trimmed.is_empty() && Path::new(trimmed).is_dir() {
            let sdk_canon = clean_canonical_path(Path::new(trimmed));
            if sdk_canon.starts_with(&dev_canon) {
                return Some(sdk_canon.to_string_lossy().into_owned());
            }
        }
    }
    let candidates = [
        dev_canon
            .join("Platforms")
            .join("MacOSX.platform")
            .join("Developer")
            .join("SDKs")
            .join("MacOSX.sdk"),
        dev_canon.join("SDKs").join("MacOSX.sdk"),
    ];
    for candidate in candidates {
        if candidate.is_dir() {
            let sdk_canon = clean_canonical_path(&candidate);
            if sdk_canon.starts_with(&dev_canon) {
                return Some(sdk_canon.to_string_lossy().into_owned());
            }
        }
    }
    None
}

#[cfg(target_os = "macos")]
type DarwinCompilerSupportTuple = (
    PathBuf,
    PathBuf,
    PathBuf,
    String,
    Vec<String>,
    BTreeMap<String, String>,
);

#[cfg(target_os = "macos")]
fn resolve_darwin_compiler_support(
    compiler_path: &Path,
    kind: &str,
) -> Result<DarwinCompilerSupportTuple, String> {
    let compiler = clean_canonical_path(compiler_path);
    let clt = Path::new("/Library/Developer/CommandLineTools");
    let clt_canon = if clt.is_dir() {
        Some(clean_canonical_path(clt))
    } else {
        None
    };

    let toolchain_root = compiler
        .ancestors()
        .find(|cand| {
            cand.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.ends_with(".xctoolchain"))
        })
        .map(Path::to_path_buf)
        .or_else(|| {
            clt_canon
                .as_ref()
                .filter(|root| compiler.starts_with(root))
                .cloned()
        })
        .ok_or_else(|| {
            "TOOLCHAIN_NOT_SANDBOX_COMPATIBLE: use Apple Clang from Xcode or Command Line Tools"
                .to_string()
        })?;

    let developer_root = infer_darwin_developer_root_from_path(&compiler).ok_or_else(|| {
        "TOOLCHAIN_NOT_SANDBOX_COMPATIBLE: Apple Developer root was not found".to_string()
    })?;

    let clang_driver = clean_canonical_path(&toolchain_root.join("usr").join("bin").join("clang"));
    if !clang_driver.is_file() {
        return Err(
            "TOOLCHAIN_NOT_SANDBOX_COMPATIBLE: approved Apple Clang driver was not found"
                .to_string(),
        );
    }

    let resource_base = toolchain_root.join("usr").join("lib").join("clang");
    let mut resource_dirs = Vec::new();
    if let Ok(entries) = fs::read_dir(&resource_base) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() && p.join("include").is_dir() {
                resource_dirs.push(clean_canonical_path(&p));
            }
        }
    }
    resource_dirs.sort();
    let resource_dir = resource_dirs.pop().ok_or_else(|| {
        "TOOLCHAIN_NOT_SANDBOX_COMPATIBLE: Apple Clang resource directory was not found".to_string()
    })?;

    let sdk_dir = resolve_macos_sdk_path_for_developer_root(&developer_root).ok_or_else(|| {
        "TOOLCHAIN_NOT_SANDBOX_COMPATIBLE: macOS SDK directory was not found".to_string()
    })?;

    let clang_bin_dir = clang_driver
        .parent()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| "/usr/bin".to_string());

    let arg_prefix = vec![
        if kind == "cpp" {
            "--driver-mode=g++".to_string()
        } else {
            "--driver-mode=gcc".to_string()
        },
        "-ccc-install-dir".to_string(),
        clang_bin_dir.clone(),
        "-resource-dir".to_string(),
        resource_dir.to_string_lossy().into_owned(),
        "-isysroot".to_string(),
        sdk_dir.clone(),
        format!("-B{clang_bin_dir}/"),
    ];

    let mut env = BTreeMap::new();
    env.insert(
        "JUDGEDESK_COMPILER_TOOLCHAIN_ROOT".to_string(),
        toolchain_root.to_string_lossy().into_owned(),
    );
    env.insert(
        "JUDGEDESK_COMPILER_DEVELOPER_ROOT".to_string(),
        developer_root.to_string_lossy().into_owned(),
    );
    env.insert(
        "JUDGEDESK_COMPILER_EXECUTABLE".to_string(),
        clang_driver.to_string_lossy().into_owned(),
    );

    Ok((
        clang_driver,
        toolchain_root,
        developer_root,
        sdk_dir,
        arg_prefix,
        env,
    ))
}

#[cfg(target_os = "macos")]
fn find_darwin_system_clang() -> Option<PathBuf> {
    let mut developer_roots = Vec::new();
    if let Ok(dev_dir) = std::env::var("DEVELOPER_DIR") {
        let trimmed = dev_dir.trim();
        if !trimmed.is_empty() && Path::new(trimmed).is_dir() {
            if let Some(root) = infer_darwin_developer_root_from_path(Path::new(trimmed)) {
                developer_roots.push(root);
            }
        }
    }
    if let Ok(sdk_dir) = std::env::var("SDKROOT") {
        let trimmed = sdk_dir.trim();
        if !trimmed.is_empty() && Path::new(trimmed).is_dir() {
            if let Some(root) = infer_darwin_developer_root_from_path(Path::new(trimmed)) {
                if !developer_roots.contains(&root) {
                    developer_roots.push(root);
                }
            }
        }
    }
    for candidate in [
        "/var/db/xcode_select_link",
        "/Library/Developer/CommandLineTools",
        "/Applications/Xcode.app/Contents/Developer",
    ] {
        let p = Path::new(candidate);
        if p.is_dir() {
            if let Some(root) = infer_darwin_developer_root_from_path(p) {
                if !developer_roots.contains(&root) {
                    developer_roots.push(root);
                }
            }
        }
    }
    for root in developer_roots {
        let candidates = [
            root.join("Toolchains")
                .join("XcodeDefault.xctoolchain")
                .join("usr")
                .join("bin")
                .join("clang"),
            root.join("usr").join("bin").join("clang"),
        ];
        for c in candidates {
            if c.is_file() && resolve_darwin_compiler_support(&c, "c").is_ok() {
                return Some(clean_canonical_path(&c));
            }
        }
    }
    None
}

type CompilerMountTuple = (
    String,
    Option<ToolchainGrant>,
    Option<LocalToolchainGrant>,
    BTreeMap<String, String>,
    PathBuf,
);

fn prepare_compiler_mount(
    kind: &str,
    toolchain: &ResolvedToolchain,
    platform: &ExecutorClient,
) -> Result<CompilerMountTuple, String> {
    let exe_canon = clean_canonical_path(&toolchain.executable_path);
    let mut root_canon = toolchain
        .package_root
        .as_ref()
        .map(|p| clean_canonical_path(p))
        .or_else(|| exe_canon.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."));

    let mut rel_exe = exe_canon
        .strip_prefix(&root_canon)
        .ok()
        .filter(|rel| !rel.as_os_str().is_empty())
        .map(|rel| rel.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();

    if rel_exe.is_empty() {
        if let Some(parent) = exe_canon.parent() {
            root_canon = parent.to_path_buf();
        }
        rel_exe = exe_canon
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| "compiler executable has no file name".to_string())?
            .to_string();
    }

    let mut env = BTreeMap::new();
    let mut path_entries = Vec::new();
    if let Some(bin_dir) = exe_canon.parent() {
        path_entries.push(bin_dir.to_string_lossy().into_owned());
    }
    let root_bin = root_canon.join("bin");
    if root_bin.is_dir() {
        let root_bin_str = root_bin.to_string_lossy().into_owned();
        if !path_entries.contains(&root_bin_str) {
            path_entries.push(root_bin_str);
        }
    }
    if cfg!(windows) {
        env.insert("TMPDIR".to_string(), ".".to_string());
    }
    #[cfg(target_os = "linux")]
    for system_bin in ["/usr/bin", "/bin"] {
        if !path_entries.iter().any(|entry| entry == system_bin) {
            path_entries.push(system_bin.to_string());
        }
    }
    if !path_entries.is_empty() {
        let sep = if cfg!(windows) { ";" } else { ":" };
        env.insert("PATH".to_string(), path_entries.join(sep));
    }

    if cfg!(target_os = "macos")
        || kind == "java"
        || crate::toolchains::linux_managed::is_managed_linux_toolchain(toolchain)
    {
        if let Some(ref pkg_root) = toolchain.package_root {
            if let Some(receipt) = read_package_receipt(pkg_root) {
                let comp = receipt
                    .components
                    .iter()
                    .find(|c| {
                        c.roles.iter().any(|r| r == "compiler")
                            && match kind {
                                "c" => {
                                    c.id == "gcc.c"
                                        || c.relative_path.ends_with("gcc")
                                        || c.relative_path.ends_with("gcc.exe")
                                }
                                "cpp" => c.id == "gcc.cxx" || c.relative_path.contains("g++"),
                                "java" => {
                                    c.id == "java.compiler" || c.relative_path.contains("javac")
                                }
                                "pascal" => {
                                    c.id == "fpc.compiler"
                                        || c.relative_path.contains("ppc")
                                        || c.relative_path.contains("fpc")
                                }
                                _ => true,
                            }
                    })
                    .or_else(|| {
                        receipt
                            .components
                            .iter()
                            .find(|c| c.roles.iter().any(|r| r == "compiler"))
                    });
                if let Some(comp) = comp {
                    let cached_root =
                        ensure_cached_managed_toolchain(&platform.root(), pkg_root, &receipt)?;
                    let cache_id = managed_cache_id(
                        &receipt.package_id,
                        &receipt.version,
                        &receipt.archive_sha256,
                    );
                    let cached_bin = cached_root.join("bin");
                    if cached_bin.is_dir() {
                        env.insert(
                            "PATH".to_string(),
                            cached_bin.to_string_lossy().into_owned(),
                        );
                    } else {
                        env.insert(
                            "PATH".to_string(),
                            cached_root.to_string_lossy().into_owned(),
                        );
                    }
                    #[cfg(target_os = "macos")]
                    if kind == "pascal" {
                        let clang_path = find_darwin_system_clang().ok_or_else(|| {
                            "PLATFORM_LINKER_UNAVAILABLE: install Apple Command Line Tools"
                                .to_string()
                        })?;
                        let (clang_exe, _, _, _, _, darwin_env) =
                            resolve_darwin_compiler_support(&clang_path, "c")?;
                        for (k, v) in darwin_env {
                            env.insert(k, v);
                        }
                        if let Some(clang_dir) = clang_exe.parent() {
                            env.insert(
                                "PATH".to_string(),
                                format!("{}:/usr/bin:/bin", clang_dir.display()),
                            );
                        }
                    }
                    return Ok((
                        format!("toolchains/{cache_id}/{}", comp.relative_path),
                        Some(ToolchainGrant {
                            package_id: receipt.package_id,
                            package_digest: receipt.archive_sha256,
                            component_id: comp.id.clone(),
                            role: ToolchainGrantRole::Compiler,
                        }),
                        None,
                        env,
                        cached_root,
                    ));
                }
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        if kind == "cpp" || kind == "c" {
            let (clang_driver, _tc_root, _dev_root, _sdk_dir, _prefix, darwin_env) =
                resolve_darwin_compiler_support(&exe_canon, kind)?;
            for (k, v) in darwin_env {
                env.insert(k, v);
            }
            let clang_bin_dir = clang_driver
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| PathBuf::from("/usr/bin"));
            let clang_name = clang_driver
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("clang")
                .to_string();
            return Ok((
                format!("local-toolchain/{clang_name}"),
                None,
                Some(LocalToolchainGrant {
                    root_path: clang_bin_dir.to_string_lossy().into_owned(),
                    executable_relative_path: clang_name,
                    isolation: LocalToolchainIsolation::ResourceOnly,
                    role: ToolchainGrantRole::Compiler,
                }),
                env,
                clang_bin_dir,
            ));
        }
    }

    let isolation = if cfg!(target_os = "linux") {
        LocalToolchainIsolation::Strict
    } else {
        LocalToolchainIsolation::ResourceOnly
    };

    Ok((
        format!("local-toolchain/{rel_exe}"),
        None,
        Some(LocalToolchainGrant {
            root_path: root_canon.to_string_lossy().into_owned(),
            executable_relative_path: rel_exe,
            isolation,
            role: ToolchainGrantRole::Compiler,
        }),
        env,
        root_canon,
    ))
}

fn build_compile_limits(timeout_ms: u64) -> RunLimits {
    RunLimits {
        wall_time_ms: timeout_ms.clamp(1, 300_000),
        memory_bytes: 768 * 1024 * 1024,
        process_count: 32,
        thread_count: 128,
        output_bytes: 4 * 1024 * 1024,
        total_write_bytes: 64 * 1024 * 1024,
        open_files: 256,
        created_files: 512,
    }
}

fn read_workspace_compiler_diagnostics(workspace_dir: &Path) -> String {
    let mut combined = String::new();
    for file_name in ["stderr.txt", "stdout.txt"] {
        let p = workspace_dir.join(file_name);
        if p.is_file() {
            if let Ok(bytes) = fs::read(&p) {
                let text = String::from_utf8_lossy(&bytes);
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    if !combined.is_empty() {
                        combined.push('\n');
                    }
                    combined.push_str(trimmed);
                }
            }
        }
    }
    combined
}

fn is_pch_related_diagnostic(diag: &str) -> bool {
    let lower = diag.to_ascii_lowercase();
    lower.contains("stdc++.h.gch")
        || lower.contains("invalid-pch")
        || lower.contains("precompiled header")
        || lower.contains("pch files were found")
}

fn classify_failed_compile_run(
    reason: &RunReason,
    exit_code: Option<i32>,
    diagnostic: Option<String>,
    workspace_diagnostics: String,
) -> CompilationOutput {
    let detail = if !workspace_diagnostics.is_empty() {
        workspace_diagnostics
    } else if let Some(d) = diagnostic {
        d
    } else {
        format!(
            "Compiler failed with reason {:?} (exit code {:?})",
            reason, exit_code
        )
    };

    match reason {
        RunReason::Exited => CompilationOutput::submission_ce(detail),
        RunReason::WallTimeLimit => {
            CompilationOutput::submission_ce(format!("COMPILER_TIMEOUT: {detail}"))
        }
        RunReason::MemoryLimit => {
            CompilationOutput::submission_ce(format!("COMPILER_MEMORY_LIMIT_EXCEEDED: {detail}"))
        }
        RunReason::OutputLimit | RunReason::WriteLimit => {
            CompilationOutput::submission_ce(format!("COMPILER_WRITE_LIMIT_EXCEEDED: {detail}"))
        }
        RunReason::ProcessLimit | RunReason::ThreadLimit => {
            CompilationOutput::submission_ce(format!("COMPILER_RESOURCE_LIMIT_EXCEEDED: {detail}"))
        }
        RunReason::Cancelled => {
            CompilationOutput::environment_je(format!("COMPILER_CANCELLED: {detail}"))
        }
        RunReason::SandboxDenied | RunReason::LaunchError | RunReason::InternalError => {
            CompilationOutput::environment_je(format!("COMPILER_SANDBOX_ERROR: {detail}"))
        }
    }
}

pub fn compile_cpp_pch_in_sandbox(
    platform: &ExecutorClient,
    toolchain: &ResolvedToolchain,
    source_header: &Path,
    output_gch_path: &Path,
    compiler_flags: &[String],
) -> Result<(), String> {
    let health = platform.health();
    if !health.ready || platform.is_admission_closed() {
        return Err(format!(
            "SECURE_RUNNER_UNAVAILABLE: {}",
            health.diagnostics.join("; ")
        ));
    }
    let count = COMPILE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let workspace_id = format!("comp_pch_{}_{}", std::process::id(), count);
    let run_id = format!("crun_pch_{}_{}", std::process::id(), count);

    let workspaces_root = platform.root().join("workspaces");
    let workspace = OwnedWorkspace::create_with_id(&workspaces_root, &workspace_id)?;

    let header_bytes = fs::read(source_header).map_err(|e| {
        format!(
            "Failed to read stdc++.h source {}: {e}",
            source_header.display()
        )
    })?;
    workspace.write_file(Path::new("compiler-pch/bits/stdc++.h"), &header_bytes)?;

    let (executable_id, tc_grant, local_grant, env, root_canon) =
        prepare_compiler_mount("cpp", toolchain, platform)?;

    let mut args = Vec::new();
    if crate::toolchains::linux_managed::is_managed_linux_toolchain(toolchain) {
        args.extend(crate::toolchains::linux_managed::compiler_support_args(
            "cpp",
            &root_canon,
            false,
        )?);
    }
    #[cfg(target_os = "macos")]
    {
        if let Ok((_, _, _, _, prefix, _)) =
            resolve_darwin_compiler_support(&toolchain.executable_path, "cpp")
        {
            args.extend(prefix);
        }
    }
    for flag in compiler_flags {
        args.push(flag.clone());
    }
    #[cfg(target_os = "macos")]
    {
        args.push("-fsanitize=integer-divide-by-zero".to_string());
        args.push("-fsanitize-trap=integer-divide-by-zero".to_string());
    }
    let exe_lower = toolchain
        .executable_path
        .to_string_lossy()
        .to_ascii_lowercase();
    if cfg!(target_os = "macos") || exe_lower.contains("clang") {
        args.push("-Xclang".to_string());
        args.push("-fmodules-embed-all-files".to_string());
    }
    args.push("-x".to_string());
    args.push("c++-header".to_string());
    args.push("compiler-pch/bits/stdc++.h".to_string());
    args.push("-o".to_string());
    args.push("compiler-pch/bits/stdc++.h.gch".to_string());

    let mut limits = build_compile_limits(45_000);
    limits.memory_bytes = 1024 * 1024 * 1024;
    limits.total_write_bytes = 256 * 1024 * 1024;

    let spec = RunSpec {
        run_id,
        role: RunRole::Compiler,
        workspace_id,
        executable_id,
        args,
        stdin_file: None,
        stdout_file: "stdout.txt".to_string(),
        stderr_file: "stderr.txt".to_string(),
        environment: env,
        toolchain: tc_grant,
        local_toolchain: local_grant,
        limits,
    };

    let run_result = platform
        .run_sync(Box::new(spec))
        .map_err(|e| format!("PCH_EXECUTOR_ERROR: {e}"))?;
    let ws_diag = read_workspace_compiler_diagnostics(workspace.root());
    if !matches!(run_result.reason, RunReason::Exited) || run_result.exit_code != Some(0) {
        return Err(format!(
            "PCH compilation failed ({:?}, exit {:?}): {}",
            run_result.reason, run_result.exit_code, ws_diag
        ));
    }

    let produced_gch = workspace
        .root()
        .join("compiler-pch")
        .join("bits")
        .join("stdc++.h.gch");
    if !produced_gch.is_file() {
        return Err(format!(
            "PCH compilation exited 0 but produced no .gch file: {ws_diag}"
        ));
    }

    if let Some(parent) = output_gch_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create PCH output dir: {e}"))?;
    }
    fs::copy(&produced_gch, output_gch_path)
        .map_err(|e| format!("Failed to copy generated .gch artifact: {e}"))?;
    Ok(())
}

fn compile_native_submission(
    kind: &str,
    req: &CompileSubmissionRequest<'_>,
    toolchain: &ResolvedToolchain,
    timeout_ms: u64,
    compile_config: Option<&crate::discovery::ProblemCompileConfig>,
) -> CompilationOutput {
    compile_native_submission_attempt(kind, req, toolchain, timeout_ms, compile_config, true)
}

fn compile_native_submission_attempt(
    kind: &str,
    req: &CompileSubmissionRequest<'_>,
    toolchain: &ResolvedToolchain,
    timeout_ms: u64,
    compile_config: Option<&crate::discovery::ProblemCompileConfig>,
    allow_pch: bool,
) -> CompilationOutput {
    let count = COMPILE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let workspace_id = format!("comp_{}_{}_{}", kind, std::process::id(), count);
    let run_id = format!("crun_{}_{}_{}", kind, std::process::id(), count);

    let workspaces_root = req.platform.root().join("workspaces");
    let workspace = match OwnedWorkspace::create_with_id(&workspaces_root, &workspace_id) {
        Ok(ws) => ws,
        Err(e) => {
            return CompilationOutput::environment_je(format!(
                "Failed to create compile workspace: {e}"
            ));
        }
    };

    let staged_src_name = match kind {
        "cpp" => "submission.cpp",
        "c" => "submission.c",
        "pascal" => "submission.pas",
        _ => "submission.src",
    };
    let staged_exe_name = if cfg!(windows) {
        "compiled.exe"
    } else {
        "compiled"
    };

    let source_bytes = match fs::read(req.source_path) {
        Ok(b) => b,
        Err(e) => {
            return CompilationOutput::environment_je(format!(
                "Failed to read source file {}: {e}",
                req.source_path.display()
            ));
        }
    };
    if let Err(e) = workspace.write_file(Path::new(staged_src_name), &source_bytes) {
        return CompilationOutput::environment_je(format!(
            "Failed to stage source into compile workspace: {e}"
        ));
    }

    // Stage any extra headers (such as testlib.h for custom checkers) into workspace root
    let mut staged_extra_include = false;
    for inc_dir in req.extra_include_dirs {
        let testlib = inc_dir.join("testlib.h");
        if testlib.is_file() {
            if let Ok(bytes) = fs::read(&testlib) {
                let _ = workspace.write_file(Path::new("testlib.h"), &bytes);
                staged_extra_include = true;
            }
        }
    }

    let (executable_id, tc_grant, local_grant, env, root_canon) =
        match prepare_compiler_mount(kind, toolchain, req.platform) {
            Ok(m) => m,
            Err(e) => return CompilationOutput::environment_je(e),
        };

    let effective_compile_cfg = compile_config.cloned().unwrap_or_default();
    let mut args = Vec::new();
    let mut staged_pch_dir: Option<PathBuf> = None;
    let linux_full = crate::toolchains::linux_managed::is_managed_linux_toolchain(toolchain);
    if linux_full {
        match crate::toolchains::linux_managed::compiler_support_args(kind, &root_canon, true) {
            Ok(support) => args.extend(support),
            Err(error) => return CompilationOutput::environment_je(error),
        }
    }

    match kind {
        "cpp" | "c" => {
            let lang_flags = effective_compile_cfg.flags_for_language(kind);
            let flags_json = serde_json::Value::Array(
                lang_flags
                    .iter()
                    .cloned()
                    .map(serde_json::Value::String)
                    .collect(),
            );
            if let Err(e) =
                crate::discovery::compile_config::validate_custom_compile_flags(&flags_json)
            {
                return CompilationOutput::environment_je(e);
            }

            if kind == "cpp" && allow_pch && !staged_extra_include {
                if let Some(pch_flags) =
                    crate::toolchains::pch::extract_pch_compiler_flags(lang_flags)
                {
                    staged_pch_dir = crate::toolchains::pch::stage_cpp_pch_into_workspace(
                        &workspace, toolchain, &pch_flags,
                    );
                }
            }

            #[cfg(target_os = "macos")]
            {
                if let Ok((_, _, _, _, prefix, _)) =
                    resolve_darwin_compiler_support(&toolchain.executable_path, kind)
                {
                    args.extend(prefix);
                }
                if kind == "cpp" && staged_pch_dir.is_none() {
                    let compat_bytes = crate::toolchains::pch::find_bundled_compat_stdcxx_header()
                        .and_then(|p| fs::read(p).ok())
                        .unwrap_or_else(|| {
                            include_bytes!("../../../../compiler-compat/include/bits/stdc++.h")
                                .to_vec()
                        });
                    if workspace
                        .write_file(
                            Path::new("compiler-compat/include/bits/stdc++.h"),
                            &compat_bytes,
                        )
                        .is_ok()
                    {
                        args.push("-isystem".to_string());
                        args.push("compiler-compat/include".to_string());
                    }
                }
            }

            if staged_pch_dir.is_some() {
                let exe_lower = toolchain
                    .executable_path
                    .to_string_lossy()
                    .to_ascii_lowercase();
                let is_clang = cfg!(target_os = "macos") || exe_lower.contains("clang");
                if is_clang {
                    args.push("-isystem".to_string());
                    args.push("compiler-pch".to_string());
                    args.push("-Xclang".to_string());
                    args.push("-fno-validate-pch".to_string());
                    args.push("-include-pch".to_string());
                    args.push("compiler-pch/bits/stdc++.h.gch".to_string());
                } else {
                    args.push("-Icompiler-pch".to_string());
                }
                args.push("-Winvalid-pch".to_string());
                args.push("-Werror=invalid-pch".to_string());
            }

            for flag in lang_flags {
                args.push(flag.clone());
            }
            if kind == "cpp" {
                let exe_str = toolchain.executable_path.to_string_lossy();
                if exe_str.ends_with("clang") || exe_str.ends_with("clang.exe") {
                    args.push("-lc++".to_string());
                }
            }
            #[cfg(target_os = "macos")]
            {
                args.push("-fsanitize=integer-divide-by-zero".to_string());
                args.push("-fsanitize-trap=integer-divide-by-zero".to_string());
            }
            if staged_extra_include {
                args.push("-I.".to_string());
            }
            if !cfg!(target_os = "macos") && !linux_full {
                args.push("-static".to_string());
            }
            if cfg!(windows) {
                args.push("-Wl,--stack,66060288".to_string());
            }
            args.push("-o".to_string());
            args.push(staged_exe_name.to_string());
            args.push(staged_src_name.to_string());
            if !cfg!(target_os = "macos") && kind == "c" {
                args.push("-lm".to_string());
            }
        }
        "pascal" => {
            let target_triple = fpc_host_target_triple();
            let units_dir = find_fpc_units_dir(&root_canon, target_triple);
            if !cfg!(target_os = "linux") || units_dir.is_some() {
                args.push("-n".to_string());
            }
            #[cfg(windows)]
            {
                args.push("-Px86_64".to_string());
                args.push("-Twin64".to_string());
            }
            #[cfg(target_os = "macos")]
            {
                args.push("-Paarch64".to_string());
                args.push("-Tdarwin".to_string());
            }
            #[cfg(target_os = "linux")]
            {
                if cfg!(target_arch = "aarch64") {
                    args.push("-Paarch64".to_string());
                } else {
                    args.push("-Px86_64".to_string());
                }
                args.push("-Tlinux".to_string());
            }
            if let Some(ref units_dir) = units_dir {
                let compiler_units =
                    if crate::toolchains::linux_managed::is_managed_linux_toolchain(toolchain) {
                        match crate::toolchains::linux_managed::compiler_visible_path(
                            &root_canon,
                            units_dir,
                        ) {
                            Ok(path) => path,
                            Err(error) => return CompilationOutput::environment_je(error),
                        }
                    } else {
                        units_dir.clone()
                    };
                args.push(format!("-Fu{}", compiler_units.join("*").display()));
                args.push(format!("-Fu{}", compiler_units.join("rtl").display()));
            }
            #[cfg(windows)]
            {
                let bin_dir = root_canon.join("bin");
                if bin_dir.is_dir() {
                    args.push(format!("-FD{}", bin_dir.display()));
                }
                args.push("-XPx86_64-win64-".to_string());
            }
            #[cfg(target_os = "linux")]
            {
                if root_canon != Path::new("/usr")
                    && !crate::toolchains::linux_managed::is_managed_linux_toolchain(toolchain)
                {
                    let bin_dir = root_canon.join("bin");
                    if bin_dir.is_dir() {
                        args.push(format!("-FD{}", bin_dir.display()));
                    }
                }
            }
            #[cfg(target_os = "macos")]
            {
                let darwin_support = env
                    .get("JUDGEDESK_COMPILER_EXECUTABLE")
                    .map(PathBuf::from)
                    .or_else(find_darwin_system_clang)
                    .and_then(|p| resolve_darwin_compiler_support(&p, "c").ok());
                if let Some((clang_exe, _, _, sdk, _, _)) = darwin_support {
                    args.push(format!("-XR{sdk}"));
                    if let Some(clang_dir) = clang_exe.parent() {
                        args.push(format!("-FD{}", clang_dir.display()));
                    }
                }
            }
            args.push("-O2".to_string());
            args.push("-XS".to_string());
            args.push("-Sg".to_string());
            if cfg!(windows) {
                args.push("-WR".to_string());
                args.push("-Xs".to_string());
                args.push("-Cs66060288".to_string());
            }
            args.push(format!("-o{staged_exe_name}"));
            args.push(staged_src_name.to_string());
        }
        _ => {}
    }

    let spec = RunSpec {
        run_id,
        role: RunRole::Compiler,
        workspace_id,
        executable_id,
        args,
        stdin_file: None,
        stdout_file: "stdout.txt".to_string(),
        stderr_file: "stderr.txt".to_string(),
        environment: env,
        toolchain: tc_grant,
        local_toolchain: local_grant,
        limits: build_compile_limits(timeout_ms),
    };

    let run_result = match req.platform.run_sync(Box::new(spec)) {
        Ok(r) => r,
        Err(e) => {
            if let Some(ref pch_dir) = staged_pch_dir {
                drop(workspace);
                let retry_out = compile_native_submission_attempt(
                    kind,
                    req,
                    toolchain,
                    timeout_ms,
                    compile_config,
                    false,
                );
                if retry_out.status == "OK" {
                    crate::toolchains::pch::invalidate_pch_cache_dir(pch_dir);
                }
                return retry_out;
            }
            return CompilationOutput::environment_je(format!("COMPILER_EXECUTOR_ERROR: {e}"));
        }
    };

    let ws_diag = read_workspace_compiler_diagnostics(workspace.root());
    if !matches!(run_result.reason, RunReason::Exited) || run_result.exit_code != Some(0) {
        if let Some(ref pch_dir) = staged_pch_dir {
            drop(workspace);
            let retry_out = compile_native_submission_attempt(
                kind,
                req,
                toolchain,
                timeout_ms,
                compile_config,
                false,
            );
            if retry_out.status == "OK" || is_pch_related_diagnostic(&ws_diag) {
                crate::toolchains::pch::invalidate_pch_cache_dir(pch_dir);
            }
            return retry_out;
        }
        return classify_failed_compile_run(
            &run_result.reason,
            run_result.exit_code,
            run_result.diagnostic,
            ws_diag,
        );
    }

    let produced_exe = workspace.root().join(staged_exe_name);
    if !produced_exe.is_file() {
        if let Some(ref pch_dir) = staged_pch_dir {
            drop(workspace);
            let retry_out = compile_native_submission_attempt(
                kind,
                req,
                toolchain,
                timeout_ms,
                compile_config,
                false,
            );
            if retry_out.status == "OK" || is_pch_related_diagnostic(&ws_diag) {
                crate::toolchains::pch::invalidate_pch_cache_dir(pch_dir);
            }
            return retry_out;
        }
        return CompilationOutput::submission_ce(if ws_diag.is_empty() {
            "Compiler exited with 0 but produced no executable output.".to_string()
        } else {
            ws_diag
        });
    }

    if let Ok(meta) = fs::metadata(&produced_exe) {
        if meta.len() > MAX_COMPILED_BINARY_BYTES {
            return CompilationOutput::submission_ce(format!(
                "Compiled binary exceeds maximum allowed size of {} bytes.",
                MAX_COMPILED_BINARY_BYTES
            ));
        }
    }

    let out_file_name = if timeout_ms == CHECKER_COMPILE_WALL_TIME_MS {
        if cfg!(windows) {
            "checker.exe"
        } else {
            "checker"
        }
    } else if cfg!(windows) {
        "submission.exe"
    } else {
        "submission"
    };
    let final_exe = req.output_dir.join(out_file_name);
    if let Err(e) = fs::copy(&produced_exe, &final_exe) {
        return CompilationOutput::environment_je(format!(
            "Failed to copy compiled artifact to {}: {e}",
            final_exe.display()
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&final_exe, fs::Permissions::from_mode(0o755));
    }

    CompilationOutput::ok(final_exe)
}

fn compile_python_submission(
    req: &CompileSubmissionRequest<'_>,
    toolchain: &ResolvedToolchain,
    timeout_ms: u64,
) -> CompilationOutput {
    let count = COMPILE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let workspace_id = format!("comp_py_{}_{}", std::process::id(), count);
    let run_id = format!("crun_py_{}_{}", std::process::id(), count);

    let workspaces_root = req.platform.root().join("workspaces");
    let workspace = match OwnedWorkspace::create_with_id(&workspaces_root, &workspace_id) {
        Ok(ws) => ws,
        Err(e) => {
            return CompilationOutput::environment_je(format!(
                "Failed to create Python syntax-check workspace: {e}"
            ));
        }
    };

    let source_bytes = match fs::read(req.source_path) {
        Ok(b) => b,
        Err(e) => {
            return CompilationOutput::environment_je(format!(
                "Failed to read Python source {}: {e}",
                req.source_path.display()
            ));
        }
    };
    if let Err(e) = workspace.write_file(Path::new("main.py"), &source_bytes) {
        return CompilationOutput::environment_je(format!(
            "Failed to stage Python source into workspace: {e}"
        ));
    }

    let check_script = "import ast\nwith open('main.py', 'rb') as f:\n    src = f.read()\nast.parse(src, filename='main.py')\n";
    if let Err(e) = workspace.write_file(Path::new("_syntax_check.py"), check_script.as_bytes()) {
        return CompilationOutput::environment_je(format!(
            "Failed to stage Python syntax checker: {e}"
        ));
    }

    let receipt = toolchain
        .package_root
        .as_ref()
        .and_then(|p| read_package_receipt(p));

    let (executable_id, tc_grant, local_grant, env) =
        if let (Some(pkg_root), Some(rec)) = (&toolchain.package_root, receipt) {
            let cached_root =
                match ensure_cached_managed_toolchain(&req.platform.root(), pkg_root, &rec) {
                    Ok(c) => c,
                    Err(e) => return CompilationOutput::environment_je(e),
                };
            let cache_id = managed_cache_id(&rec.package_id, &rec.version, &rec.archive_sha256);
            let relative_exe = rec
                .components
                .iter()
                .find(|c| c.id == rec.entrypoint_component_id)
                .map(|c| c.relative_path.as_str())
                .unwrap_or(if cfg!(windows) {
                    "python.exe"
                } else {
                    "bin/python3"
                });
            let exe_dir = cached_root
                .join(relative_exe)
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| cached_root.clone());
            let mut env = BTreeMap::new();
            env.insert("JUDGEDESK_PYTHON_ISOLATED".to_string(), "1".to_string());
            env.insert("PYTHONNOUSERSITE".to_string(), "1".to_string());
            env.insert("PYTHONDONTWRITEBYTECODE".to_string(), "1".to_string());
            env.insert(
                "PYTHONHOME".to_string(),
                cached_root.to_string_lossy().into_owned(),
            );
            env.insert("PATH".to_string(), exe_dir.to_string_lossy().into_owned());
            (
                format!("toolchains/{cache_id}/{relative_exe}"),
                Some(ToolchainGrant {
                    package_id: rec.package_id,
                    package_digest: rec.archive_sha256,
                    component_id: rec.entrypoint_component_id,
                    role: ToolchainGrantRole::SubmissionRuntime,
                }),
                None,
                env,
            )
        } else {
            let (exe_canon, mut python_root) =
                resolve_macos_framework_python_executable(&toolchain.executable_path)
                    .unwrap_or_else(|| {
                        let canon = clean_canonical_path(&toolchain.executable_path);
                        let root = toolchain
                            .package_root
                            .as_ref()
                            .map(|p| clean_canonical_path(p))
                            .or_else(|| canon.parent().map(Path::to_path_buf))
                            .unwrap_or_else(|| PathBuf::from("."));
                        (canon, root)
                    });
            if let Some(ref pkg_root) = toolchain.package_root {
                let pkg_canon = clean_canonical_path(pkg_root);
                if exe_canon.starts_with(&pkg_canon) {
                    python_root = pkg_canon;
                }
            }
            let mut rel_exe = exe_canon
                .strip_prefix(&python_root)
                .ok()
                .filter(|rel| !rel.as_os_str().is_empty())
                .map(|rel| rel.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            if rel_exe.is_empty() {
                if let Some(parent) = exe_canon.parent() {
                    python_root = parent.to_path_buf();
                }
                rel_exe = exe_canon
                    .file_name()
                    .and_then(|f| f.to_str())
                    .unwrap_or(if cfg!(windows) {
                        "python.exe"
                    } else {
                        "python3"
                    })
                    .to_string();
            }
            let exe_dir = exe_canon
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| python_root.clone());
            let mut env = BTreeMap::new();
            env.insert("JUDGEDESK_PYTHON_ISOLATED".to_string(), "1".to_string());
            env.insert("PYTHONNOUSERSITE".to_string(), "1".to_string());
            env.insert("PYTHONDONTWRITEBYTECODE".to_string(), "1".to_string());
            env.insert(
                "PYTHONHOME".to_string(),
                python_root.to_string_lossy().into_owned(),
            );
            env.insert("PATH".to_string(), exe_dir.to_string_lossy().into_owned());
            let isolation = if cfg!(target_os = "linux") {
                LocalToolchainIsolation::Strict
            } else {
                LocalToolchainIsolation::ResourceOnly
            };
            (
                format!("local-toolchain/{rel_exe}"),
                None,
                Some(LocalToolchainGrant {
                    root_path: python_root.to_string_lossy().into_owned(),
                    executable_relative_path: rel_exe,
                    isolation,
                    role: ToolchainGrantRole::SubmissionRuntime,
                }),
                env,
            )
        };

    let spec = RunSpec {
        run_id,
        role: RunRole::Submission,
        workspace_id,
        executable_id,
        args: vec![
            "-I".to_string(),
            "-B".to_string(),
            "_syntax_check.py".to_string(),
        ],
        stdin_file: None,
        stdout_file: "stdout.txt".to_string(),
        stderr_file: "stderr.txt".to_string(),
        environment: env,
        toolchain: tc_grant,
        local_toolchain: local_grant,
        limits: RunLimits {
            wall_time_ms: timeout_ms.clamp(1, 300_000),
            memory_bytes: 256 * 1024 * 1024,
            process_count: 1,
            thread_count: 16,
            output_bytes: 1024 * 1024,
            total_write_bytes: 4 * 1024 * 1024,
            open_files: 64,
            created_files: 64,
        },
    };

    let run_result = match req.platform.run_sync(Box::new(spec)) {
        Ok(r) => r,
        Err(e) => {
            return CompilationOutput::environment_je(format!("PYTHON_COMPILER_ERROR: {e}"));
        }
    };

    let ws_diag = read_workspace_compiler_diagnostics(workspace.root());
    if !matches!(run_result.reason, RunReason::Exited) || run_result.exit_code != Some(0) {
        return classify_failed_compile_run(
            &run_result.reason,
            run_result.exit_code,
            run_result.diagnostic,
            ws_diag,
        );
    }

    let out_py = req.output_dir.join("submission.py");
    if let Err(e) = fs::write(&out_py, &source_bytes) {
        return CompilationOutput::environment_je(format!(
            "Failed to stage validated Python script to {}: {e}",
            out_py.display()
        ));
    }

    CompilationOutput::ok(out_py)
}

fn strip_java_comments_and_strings(source: &str) -> String {
    let bytes = source.as_bytes();
    let mut out = String::with_capacity(source.len());
    let mut i = 0;
    while i < bytes.len() {
        if i + 1 < bytes.len() && bytes[i] == b'/' && bytes[i + 1] == b'/' {
            i += 2;
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
        } else if i + 1 < bytes.len() && bytes[i] == b'/' && bytes[i + 1] == b'*' {
            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                if bytes[i] == b'\n' {
                    out.push('\n');
                }
                i += 1;
            }
            i = (i + 2).min(bytes.len());
            out.push(' ');
        } else if bytes[i] == b'"' || bytes[i] == b'\'' {
            let quote = bytes[i];
            out.push(' ');
            i += 1;
            while i < bytes.len() {
                if bytes[i] == b'\\' {
                    i = (i + 2).min(bytes.len());
                    continue;
                }
                if bytes[i] == quote {
                    i += 1;
                    break;
                }
                i += 1;
            }
        } else {
            out.push(bytes[i] as char);
            i += 1;
        }
    }
    out
}

fn inspect_java_source(source: &str) -> Result<String, String> {
    let stripped = strip_java_comments_and_strings(source);
    let tokens: Vec<&str> = stripped
        .split(|c: char| !c.is_ascii_alphanumeric() && c != '_' && c != '$' && c != ';')
        .filter(|t| !t.is_empty())
        .collect();

    for (idx, &tok) in tokens.iter().enumerate() {
        if tok == "package" {
            // Check if at start of file or after ';'
            if idx == 0 || tokens[idx - 1].ends_with(';') {
                return Err(
                    "JAVA_PACKAGE_UNSUPPORTED: package declarations are not supported in JudgeDesk submissions"
                        .to_string(),
                );
            }
        }
    }

    // Look for `public [final|abstract|sealed|non-sealed]* (class|record|enum|interface) <Name>`
    for i in 0..tokens.len() {
        if tokens[i] == "public" {
            let mut j = i + 1;
            while j < tokens.len()
                && matches!(tokens[j], "final" | "abstract" | "sealed" | "Strictfp")
            {
                j += 1;
            }
            if j + 1 < tokens.len()
                && matches!(tokens[j], "class" | "record" | "enum" | "interface")
            {
                let candidate = tokens[j + 1].trim_end_matches(';');
                if !candidate.is_empty()
                    && candidate
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
                {
                    return Ok(candidate.to_string());
                }
            }
        }
    }

    Ok("Main".to_string())
}

fn compile_java_submission(
    req: &CompileSubmissionRequest<'_>,
    toolchain: &ResolvedToolchain,
    timeout_ms: u64,
) -> CompilationOutput {
    let source_text = match fs::read_to_string(req.source_path) {
        Ok(s) => s,
        Err(e) => {
            return CompilationOutput::submission_ce(format!(
                "JAVA_SOURCE_INVALID_UTF8: failed to read Java source as UTF-8: {e}"
            ));
        }
    };

    let entrypoint_class = match inspect_java_source(&source_text) {
        Ok(cls) => cls,
        Err(err) => return CompilationOutput::submission_ce(err),
    };

    let count = COMPILE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let workspace_id = format!("comp_java_{}_{}", std::process::id(), count);
    let run_id = format!("crun_java_{}_{}", std::process::id(), count);

    let workspaces_root = req.platform.root().join("workspaces");
    let workspace = match OwnedWorkspace::create_with_id(&workspaces_root, &workspace_id) {
        Ok(ws) => ws,
        Err(e) => {
            return CompilationOutput::environment_je(format!(
                "Failed to create Java compile workspace: {e}"
            ));
        }
    };

    let staged_src_name = format!("{entrypoint_class}.java");
    if let Err(e) = workspace.write_file(Path::new(&staged_src_name), source_text.as_bytes()) {
        return CompilationOutput::environment_je(format!(
            "Failed to stage Java source into workspace: {e}"
        ));
    }
    let classes_out_dir = workspace.root().join("classes_out");
    if let Err(e) = fs::create_dir_all(&classes_out_dir) {
        return CompilationOutput::environment_je(format!(
            "Failed to create Java classes_out directory: {e}"
        ));
    }

    let (executable_id, tc_grant, local_grant, mut env, root_canon) =
        match prepare_compiler_mount("java", toolchain, req.platform) {
            Ok(m) => m,
            Err(e) => return CompilationOutput::environment_je(e),
        };

    env.insert(
        "JAVA_HOME".to_string(),
        root_canon.to_string_lossy().into_owned(),
    );

    let spec = RunSpec {
        run_id,
        role: RunRole::Compiler,
        workspace_id,
        executable_id,
        args: vec![
            "-J-XX:+UseSerialGC".to_string(),
            "-J-XX:ActiveProcessorCount=1".to_string(),
            "-J-XX:TieredStopAtLevel=1".to_string(),
            "-J-Xshare:auto".to_string(),
            "-J-XX:-UsePerfData".to_string(),
            "-J-Xmx512m".to_string(),
            "-encoding".to_string(),
            "UTF-8".to_string(),
            "-Xlint:none".to_string(),
            "-d".to_string(),
            "classes_out".to_string(),
            staged_src_name,
        ],
        stdin_file: None,
        stdout_file: "stdout.txt".to_string(),
        stderr_file: "stderr.txt".to_string(),
        environment: env,
        toolchain: tc_grant,
        local_toolchain: local_grant,
        limits: build_compile_limits(timeout_ms),
    };

    let run_result = match req.platform.run_sync(Box::new(spec)) {
        Ok(r) => r,
        Err(e) => {
            return CompilationOutput::environment_je(format!("JAVA_COMPILER_ERROR: {e}"));
        }
    };

    let ws_diag = read_workspace_compiler_diagnostics(workspace.root());
    if !matches!(run_result.reason, RunReason::Exited) || run_result.exit_code != Some(0) {
        return classify_failed_compile_run(
            &run_result.reason,
            run_result.exit_code,
            run_result.diagnostic,
            ws_diag,
        );
    }

    let out_classes_dir = req.output_dir.join("java_classes");
    let _ = fs::remove_dir_all(&out_classes_dir);
    if let Err(e) = fs::create_dir_all(&out_classes_dir) {
        return CompilationOutput::environment_je(format!(
            "Failed to create output java_classes directory: {e}"
        ));
    }

    let entries = match fs::read_dir(&classes_out_dir) {
        Ok(e) => e,
        Err(e) => {
            return CompilationOutput::environment_je(format!(
                "Failed to inspect compiled Java classes: {e}"
            ));
        }
    };

    let mut class_count = 0usize;
    let mut found_entrypoint = false;
    let mut first_class_name: Option<String> = None;

    for entry in entries.flatten() {
        let p = entry.path();
        if !p.is_file() {
            return CompilationOutput::submission_ce(
                "JAVA_ARTIFACT_INVALID: nested package directories are not supported",
            );
        }
        let Some(name) = p.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !name.ends_with(".class") {
            continue;
        }
        let stem = name.trim_end_matches(".class");
        if stem == entrypoint_class {
            found_entrypoint = true;
        }
        if first_class_name.is_none() {
            first_class_name = Some(stem.to_string());
        }
        if let Err(e) = fs::copy(&p, out_classes_dir.join(name)) {
            return CompilationOutput::environment_je(format!(
                "Failed to copy compiled Java class {name}: {e}"
            ));
        }
        class_count += 1;
    }

    if class_count == 0 {
        return CompilationOutput::submission_ce(
            "JAVA_ENTRYPOINT_INVALID: compilation produced no .class files",
        );
    }

    let resolved_entry = if found_entrypoint {
        entrypoint_class
    } else if out_classes_dir.join("Main.class").is_file() {
        "Main".to_string()
    } else {
        first_class_name.unwrap_or_else(|| "Main".to_string())
    };

    if let Err(e) = fs::write(
        out_classes_dir.join(".judgedesk-entrypoint"),
        resolved_entry.as_bytes(),
    ) {
        return CompilationOutput::environment_je(format!(
            "Failed to write Java entrypoint metadata: {e}"
        ));
    }

    CompilationOutput::ok(out_classes_dir)
}

fn compile_scratch_submission(source_path: &Path, output_dir: &Path) -> CompilationOutput {
    let ext = source_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_else(|| "sb3".to_string());

    let bytes = match fs::read(source_path) {
        Ok(b) => b,
        Err(e) => {
            return CompilationOutput::environment_je(format!(
                "Failed to read Scratch project {}: {e}",
                source_path.display()
            ));
        }
    };

    if let Err(err) = validate_scratch_project_bytes(&bytes, &ext) {
        return CompilationOutput::submission_ce(err);
    }

    let staged_name = format!("submission.{ext}");
    let out_path = output_dir.join(staged_name);
    if let Err(e) = fs::write(&out_path, &bytes) {
        return CompilationOutput::environment_je(format!(
            "Failed to write validated Scratch project to {}: {e}",
            out_path.display()
        ));
    }

    CompilationOutput::ok(out_path)
}

pub fn validate_scratch_project_bytes(buf: &[u8], ext: &str) -> Result<(), String> {
    match ext {
        "sb3" => {
            let project_json = extract_project_json_from_zip(buf)?;
            let parsed: serde_json::Value = serde_json::from_str(&project_json).map_err(|_| {
                "SCRATCH_PROJECT_MALFORMED: Unparseable project.json in .sb3 archive".to_string()
            })?;
            if !parsed.get("targets").is_some_and(|t| t.is_array()) {
                return Err(
                    "SCRATCH_PROJECT_MALFORMED: Invalid Scratch 3.0 project schema, missing targets"
                        .to_string(),
                );
            }
            Ok(())
        }
        "sb2" => {
            let project_json = extract_project_json_from_zip(buf)?;
            let parsed: serde_json::Value = serde_json::from_str(&project_json).map_err(|_| {
                "SCRATCH_PROJECT_MALFORMED: Unparseable project.json in .sb2 archive".to_string()
            })?;
            if parsed.get("objName").is_none() && parsed.get("children").is_none() {
                return Err(
                    "SCRATCH_PROJECT_MALFORMED: Invalid Scratch 2.0 project schema".to_string(),
                );
            }
            Ok(())
        }
        "json" => {
            if buf.len() > MAX_PROJECT_JSON_BYTES {
                return Err("SCRATCH_PROJECT_MALFORMED: Scratch JSON exceeds limit".to_string());
            }
            let text = std::str::from_utf8(buf).map_err(|_| {
                "SCRATCH_PROJECT_MALFORMED: Scratch JSON is not valid UTF-8".to_string()
            })?;
            let parsed: serde_json::Value = serde_json::from_str(text).map_err(|_| {
                "SCRATCH_PROJECT_MALFORMED: Unparseable Scratch project.json".to_string()
            })?;
            if !parsed.get("targets").is_some_and(|t| t.is_array())
                && parsed.get("objName").is_none()
            {
                return Err("SCRATCH_PROJECT_MALFORMED: Invalid Scratch JSON project".to_string());
            }
            Ok(())
        }
        _ => Err(format!(
            "SCRATCH_PROJECT_MALFORMED: Unsupported Scratch extension '.{ext}'"
        )),
    }
}

fn read_u16_le(buf: &[u8], offset: usize) -> Option<u16> {
    let slice = buf.get(offset..offset + 2)?;
    Some(u16::from_le_bytes([slice[0], slice[1]]))
}

fn read_u32_le(buf: &[u8], offset: usize) -> Option<u32> {
    let slice = buf.get(offset..offset + 4)?;
    Some(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

fn compute_crc32(bytes: &[u8]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for &b in bytes {
        crc ^= u32::from(b);
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0xedb8_8320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

fn is_safe_zip_entry_name(name: &str) -> bool {
    if name.is_empty()
        || name.contains('\0')
        || name.starts_with('/')
        || name.starts_with('\\')
        || name.contains('\\')
        || name.contains(':')
    {
        return false;
    }
    for part in name.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            return false;
        }
    }
    true
}

fn extract_project_json_from_zip(buf: &[u8]) -> Result<String, String> {
    if buf.len() < 22 {
        return Err(
            "SCRATCH_PROJECT_MALFORMED: Archive is too small to be a valid ZIP".to_string(),
        );
    }
    let search_start = buf.len().saturating_sub(22 + 0xffff);
    let mut end_record: Option<usize> = None;
    let mut cursor_search = buf.len() - 22;
    loop {
        if read_u32_le(buf, cursor_search) == Some(0x0605_4b50) {
            if let Some(comment_len) = read_u16_le(buf, cursor_search + 20) {
                if cursor_search + 22 + usize::from(comment_len) == buf.len() {
                    end_record = Some(cursor_search);
                    break;
                }
            }
        }
        if cursor_search <= search_start {
            break;
        }
        cursor_search -= 1;
    }

    let eocd = end_record.ok_or_else(|| {
        "SCRATCH_PROJECT_MALFORMED: Invalid .sb3/.sb2 archive, missing ZIP EOCD".to_string()
    })?;

    if read_u16_le(buf, eocd + 4) != Some(0) || read_u16_le(buf, eocd + 6) != Some(0) {
        return Err(
            "SCRATCH_PROJECT_MALFORMED: Multi-disk ZIP archives are unsupported".to_string(),
        );
    }

    let entry_count = usize::from(read_u16_le(buf, eocd + 10).unwrap_or(0));
    let disk_entries = usize::from(read_u16_le(buf, eocd + 8).unwrap_or(0));
    if entry_count == 0 || entry_count != disk_entries {
        return Err(
            "SCRATCH_PROJECT_MALFORMED: Invalid ZIP central directory entry count".to_string(),
        );
    }

    let cd_size = read_u32_le(buf, eocd + 12).unwrap_or(0) as usize;
    let cd_start = read_u32_le(buf, eocd + 16).unwrap_or(0) as usize;
    if cd_start.checked_add(cd_size) != Some(eocd) {
        return Err("SCRATCH_PROJECT_MALFORMED: Corrupt ZIP central directory bounds".to_string());
    }

    let mut cursor = cd_start;
    let mut project_json: Option<String> = None;
    let mut total_uncompressed = 0usize;

    for _ in 0..entry_count {
        if cursor + 46 > eocd || read_u32_le(buf, cursor) != Some(0x0201_4b50) {
            return Err("SCRATCH_PROJECT_MALFORMED: Corrupt central directory header".to_string());
        }
        let flags = read_u16_le(buf, cursor + 8).unwrap_or(0);
        let compression = read_u16_le(buf, cursor + 10).unwrap_or(0);
        let expected_crc = read_u32_le(buf, cursor + 16).unwrap_or(0);
        let compressed_u32 = read_u32_le(buf, cursor + 20).unwrap_or(0);
        let uncompressed_u32 = read_u32_le(buf, cursor + 24).unwrap_or(0);
        let name_len = usize::from(read_u16_le(buf, cursor + 28).unwrap_or(0));
        let extra_len = usize::from(read_u16_le(buf, cursor + 30).unwrap_or(0));
        let comment_len = usize::from(read_u16_le(buf, cursor + 32).unwrap_or(0));
        let local_offset_u32 = read_u32_le(buf, cursor + 42).unwrap_or(0);

        let next_cursor = cursor + 46 + name_len + extra_len + comment_len;
        if next_cursor > eocd
            || (flags & 1) != 0
            || compressed_u32 == 0xffff_ffff
            || uncompressed_u32 == 0xffff_ffff
            || local_offset_u32 == 0xffff_ffff
        {
            return Err(
                "SCRATCH_PROJECT_MALFORMED: Encrypted or ZIP64 entries are unsupported".to_string(),
            );
        }

        let compressed_size = compressed_u32 as usize;
        let uncompressed_size = uncompressed_u32 as usize;
        let local_offset = local_offset_u32 as usize;
        if compressed_size > MAX_ARCHIVE_ENTRY_BYTES || uncompressed_size > MAX_ARCHIVE_ENTRY_BYTES
        {
            return Err(
                "SCRATCH_PROJECT_MALFORMED: Archive entry exceeds 64 MiB limit".to_string(),
            );
        }
        total_uncompressed = total_uncompressed.saturating_add(uncompressed_size);
        if total_uncompressed > MAX_ARCHIVE_UNCOMPRESSED_BYTES {
            return Err(
                "SCRATCH_PROJECT_MALFORMED: Archive total uncompressed size exceeds 256 MiB"
                    .to_string(),
            );
        }

        let name_bytes = buf
            .get(cursor + 46..cursor + 46 + name_len)
            .ok_or_else(|| "SCRATCH_PROJECT_MALFORMED: Truncated entry name".to_string())?;
        let name = std::str::from_utf8(name_bytes)
            .map_err(|_| "SCRATCH_PROJECT_MALFORMED: Non-UTF8 entry name in archive".to_string())?;
        if !is_safe_zip_entry_name(name) {
            return Err(format!(
                "SCRATCH_ARCHIVE_UNSAFE: Unsafe archive entry path '{name}'"
            ));
        }

        if local_offset + 30 > cd_start || read_u32_le(buf, local_offset) != Some(0x0403_4b50) {
            return Err("SCRATCH_PROJECT_MALFORMED: Corrupt local file header".to_string());
        }
        let local_flags = read_u16_le(buf, local_offset + 6).unwrap_or(0);
        let local_comp = read_u16_le(buf, local_offset + 8).unwrap_or(0);
        let local_name_len = usize::from(read_u16_le(buf, local_offset + 26).unwrap_or(0));
        let local_extra_len = usize::from(read_u16_le(buf, local_offset + 28).unwrap_or(0));
        let local_name_bytes = buf
            .get(local_offset + 30..local_offset + 30 + local_name_len)
            .ok_or_else(|| "SCRATCH_PROJECT_MALFORMED: Truncated local entry name".to_string())?;
        if local_flags != flags || local_comp != compression || local_name_bytes != name_bytes {
            return Err(
                "SCRATCH_PROJECT_MALFORMED: Local header mismatch with central directory"
                    .to_string(),
            );
        }

        let data_start = local_offset + 30 + local_name_len + local_extra_len;
        let data_end = data_start.checked_add(compressed_size).ok_or_else(|| {
            "SCRATCH_PROJECT_MALFORMED: Compressed data offset overflow".to_string()
        })?;
        if data_end > cd_start {
            return Err(
                "SCRATCH_PROJECT_MALFORMED: Compressed entry overlaps central directory"
                    .to_string(),
            );
        }

        if (flags & 8) == 0
            && (read_u32_le(buf, local_offset + 14) != Some(expected_crc)
                || read_u32_le(buf, local_offset + 18) != Some(compressed_u32)
                || read_u32_le(buf, local_offset + 22) != Some(uncompressed_u32))
        {
            return Err("SCRATCH_PROJECT_MALFORMED: Local header CRC/size mismatch".to_string());
        }

        if name == "project.json"
            && (project_json.is_some() || uncompressed_size > MAX_PROJECT_JSON_BYTES)
        {
            return Err(
                "SCRATCH_PROJECT_MALFORMED: Duplicate or oversized project.json".to_string(),
            );
        }

        let compressed_slice = &buf[data_start..data_end];
        let decoded = match compression {
            0 => compressed_slice.to_vec(),
            8 => inflate_raw(compressed_slice, uncompressed_size)?,
            other => {
                return Err(format!(
                    "SCRATCH_PROJECT_MALFORMED: Unsupported ZIP compression method {other}"
                ));
            }
        };

        if decoded.len() != uncompressed_size || compute_crc32(&decoded) != expected_crc {
            return Err(
                "SCRATCH_PROJECT_MALFORMED: Entry CRC32 or uncompressed size mismatch".to_string(),
            );
        }

        if name == "project.json" {
            let text = String::from_utf8(decoded).map_err(|_| {
                "SCRATCH_PROJECT_MALFORMED: project.json is not valid UTF-8".to_string()
            })?;
            project_json = Some(text);
        }

        cursor = next_cursor;
    }

    if cursor != eocd {
        return Err(
            "SCRATCH_PROJECT_MALFORMED: Trailing bytes in ZIP central directory".to_string(),
        );
    }

    project_json.ok_or_else(|| {
        "SCRATCH_PROJECT_MALFORMED: Archive is missing required project.json".to_string()
    })
}

struct BitReader<'a> {
    data: &'a [u8],
    byte_pos: usize,
    bit_buf: u32,
    bit_count: u8,
}

impl<'a> BitReader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self {
            data,
            byte_pos: 0,
            bit_buf: 0,
            bit_count: 0,
        }
    }

    fn ensure_bits(&mut self, count: u8) -> Result<(), String> {
        while self.bit_count < count {
            let b = *self.data.get(self.byte_pos).ok_or_else(|| {
                "SCRATCH_PROJECT_MALFORMED: Unexpected EOF in Deflate stream".to_string()
            })?;
            self.byte_pos += 1;
            self.bit_buf |= u32::from(b) << self.bit_count;
            self.bit_count += 8;
        }
        Ok(())
    }

    fn read_bits(&mut self, count: u8) -> Result<u16, String> {
        if count == 0 {
            return Ok(0);
        }
        self.ensure_bits(count)?;
        let val = (self.bit_buf & ((1u32 << count) - 1)) as u16;
        self.bit_buf >>= count;
        self.bit_count -= count;
        Ok(val)
    }

    fn align_byte(&mut self) {
        self.bit_buf = 0;
        self.bit_count = 0;
    }

    fn read_u16_aligned(&mut self) -> Result<u16, String> {
        self.align_byte();
        let s = self
            .data
            .get(self.byte_pos..self.byte_pos + 2)
            .ok_or_else(|| {
                "SCRATCH_PROJECT_MALFORMED: Truncated uncompressed Deflate block".to_string()
            })?;
        self.byte_pos += 2;
        Ok(u16::from_le_bytes([s[0], s[1]]))
    }
}

struct HuffmanTree {
    counts: [u16; 16],
    symbols: Vec<u16>,
}

impl HuffmanTree {
    fn from_lengths(lengths: &[u8]) -> Result<Self, String> {
        let mut counts = [0u16; 16];
        for &len in lengths {
            if usize::from(len) >= counts.len() {
                return Err("SCRATCH_PROJECT_MALFORMED: Invalid Huffman code length".to_string());
            }
            if len > 0 {
                counts[usize::from(len)] += 1;
            }
        }
        let mut offsets = [0u16; 16];
        let mut total = 0u16;
        for bits in 1..=15 {
            offsets[bits] = total;
            total = total.saturating_add(counts[bits]);
        }
        let mut symbols = vec![0u16; usize::from(total)];
        for (sym, &len) in lengths.iter().enumerate() {
            if len > 0 {
                let idx = usize::from(offsets[usize::from(len)]);
                if let Some(slot) = symbols.get_mut(idx) {
                    *slot = sym as u16;
                }
                offsets[usize::from(len)] += 1;
            }
        }
        Ok(Self { counts, symbols })
    }

    fn decode(&self, reader: &mut BitReader<'_>) -> Result<u16, String> {
        let mut code = 0i32;
        let mut first = 0i32;
        let mut index = 0i32;
        for len in 1..=15 {
            code |= i32::from(reader.read_bits(1)?);
            let count = i32::from(self.counts[len]);
            if code - count < first {
                let sym_idx = (index + (code - first)) as usize;
                return self.symbols.get(sym_idx).copied().ok_or_else(|| {
                    "SCRATCH_PROJECT_MALFORMED: Invalid Huffman symbol".to_string()
                });
            }
            index += count;
            first = (first + count) << 1;
            code <<= 1;
        }
        Err("SCRATCH_PROJECT_MALFORMED: Undecodable Huffman code".to_string())
    }
}

fn inflate_raw(compressed: &[u8], max_out: usize) -> Result<Vec<u8>, String> {
    const LEN_BASE: [u16; 29] = [
        3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115,
        131, 163, 195, 227, 258,
    ];
    const LEN_EXTRA: [u8; 29] = [
        0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
    ];
    const DIST_BASE: [u16; 30] = [
        1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537,
        2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
    ];
    const DIST_EXTRA: [u8; 30] = [
        0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12,
        13, 13,
    ];
    const CL_ORDER: [usize; 19] = [
        16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
    ];

    let mut reader = BitReader::new(compressed);
    let mut out = Vec::with_capacity(max_out.min(64 * 1024));

    loop {
        let bfinal = reader.read_bits(1)?;
        let btype = reader.read_bits(2)?;
        match btype {
            0 => {
                let len = usize::from(reader.read_u16_aligned()?);
                let nlen = usize::from(reader.read_u16_aligned()?);
                if (len ^ 0xffff) != nlen {
                    return Err(
                        "SCRATCH_PROJECT_MALFORMED: Corrupt stored Deflate block length"
                            .to_string(),
                    );
                }
                if out.len().saturating_add(len) > max_out {
                    return Err(
                        "SCRATCH_PROJECT_MALFORMED: Deflate output exceeds expected size"
                            .to_string(),
                    );
                }
                let slice = reader
                    .data
                    .get(reader.byte_pos..reader.byte_pos + len)
                    .ok_or_else(|| {
                        "SCRATCH_PROJECT_MALFORMED: Truncated stored Deflate data".to_string()
                    })?;
                reader.byte_pos += len;
                out.extend_from_slice(slice);
            }
            1 | 2 => {
                let (lit_tree, dist_tree) = if btype == 1 {
                    let mut lit_lens = [0u8; 288];
                    lit_lens[..=143].fill(8);
                    lit_lens[144..=255].fill(9);
                    lit_lens[256..=279].fill(7);
                    lit_lens[280..=287].fill(8);
                    let dist_lens = [5u8; 32];
                    (
                        HuffmanTree::from_lengths(&lit_lens)?,
                        HuffmanTree::from_lengths(&dist_lens)?,
                    )
                } else {
                    let hlit = usize::from(reader.read_bits(5)?) + 257;
                    let hdist = usize::from(reader.read_bits(5)?) + 1;
                    let hclen = usize::from(reader.read_bits(4)?) + 4;
                    let mut cl_lens = [0u8; 19];
                    for i in 0..hclen {
                        cl_lens[CL_ORDER[i]] = reader.read_bits(3)? as u8;
                    }
                    let cl_tree = HuffmanTree::from_lengths(&cl_lens)?;
                    let mut lengths = Vec::with_capacity(hlit + hdist);
                    while lengths.len() < hlit + hdist {
                        let sym = cl_tree.decode(&mut reader)?;
                        match sym {
                            0..=15 => lengths.push(sym as u8),
                            16 => {
                                let prev = *lengths.last().ok_or_else(|| {
                                    "SCRATCH_PROJECT_MALFORMED: Invalid Huffman repeat code"
                                        .to_string()
                                })?;
                                let repeat = usize::from(reader.read_bits(2)?) + 3;
                                for _ in 0..repeat {
                                    lengths.push(prev);
                                }
                            }
                            17 => {
                                let repeat = usize::from(reader.read_bits(3)?) + 3;
                                lengths.resize(lengths.len() + repeat, 0);
                            }
                            18 => {
                                let repeat = usize::from(reader.read_bits(7)?) + 11;
                                lengths.resize(lengths.len() + repeat, 0);
                            }
                            _ => {
                                return Err(
                                    "SCRATCH_PROJECT_MALFORMED: Invalid code length symbol"
                                        .to_string(),
                                );
                            }
                        }
                    }
                    if lengths.len() != hlit + hdist {
                        return Err(
                            "SCRATCH_PROJECT_MALFORMED: Huffman table length overflow".to_string()
                        );
                    }
                    (
                        HuffmanTree::from_lengths(&lengths[..hlit])?,
                        HuffmanTree::from_lengths(&lengths[hlit..])?,
                    )
                };

                loop {
                    let sym = lit_tree.decode(&mut reader)?;
                    if sym < 256 {
                        if out.len() >= max_out {
                            return Err("SCRATCH_PROJECT_MALFORMED: Deflate stream exceeded uncompressed size".to_string());
                        }
                        out.push(sym as u8);
                    } else if sym == 256 {
                        break;
                    } else {
                        let len_idx = usize::from(sym - 257);
                        let base_len = *LEN_BASE.get(len_idx).ok_or_else(|| {
                            "SCRATCH_PROJECT_MALFORMED: Invalid length symbol".to_string()
                        })?;
                        let extra_bits = LEN_EXTRA[len_idx];
                        let length =
                            usize::from(base_len) + usize::from(reader.read_bits(extra_bits)?);

                        let dist_sym = usize::from(dist_tree.decode(&mut reader)?);
                        let base_dist = *DIST_BASE.get(dist_sym).ok_or_else(|| {
                            "SCRATCH_PROJECT_MALFORMED: Invalid distance symbol".to_string()
                        })?;
                        let dist_extra = DIST_EXTRA[dist_sym];
                        let distance =
                            usize::from(base_dist) + usize::from(reader.read_bits(dist_extra)?);

                        if distance == 0 || distance > out.len() {
                            return Err(
                                "SCRATCH_PROJECT_MALFORMED: Invalid LZ77 back-reference distance"
                                    .to_string(),
                            );
                        }
                        if out.len().saturating_add(length) > max_out {
                            return Err(
                                "SCRATCH_PROJECT_MALFORMED: Deflate LZ77 copy exceeded max size"
                                    .to_string(),
                            );
                        }
                        for _ in 0..length {
                            let b = out[out.len() - distance];
                            out.push(b);
                        }
                    }
                }
            }
            _ => {
                return Err("SCRATCH_PROJECT_MALFORMED: Reserved Deflate block type 3".to_string());
            }
        }
        if bfinal == 1 {
            break;
        }
    }

    Ok(out)
}
