use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

static PREFS_WRITE_NONCE: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionPolicyMode {
    ManagedOnly,
    QuickVerifiedDirect,
    FreezeRequired,
}

pub fn default_execution_policy_mode_for_kind(kind: &str) -> ExecutionPolicyMode {
    if cfg!(target_os = "linux") {
        let _ = kind;
        return ExecutionPolicyMode::QuickVerifiedDirect;
    }
    match kind {
        "pascal" | "java" | "scratch" => ExecutionPolicyMode::ManagedOnly,
        _ => ExecutionPolicyMode::QuickVerifiedDirect,
    }
}

pub fn canonical_profile_id_for_kind(kind: &str) -> &'static str {
    match kind {
        "cpp" => "cpp-legacy-v1",
        "c" => "c-gcc14",
        "python" => "python-cpython312",
        "pascal" => "pascal-fpc322",
        "java" => "java-temurin21",
        "scratch" => "scratch-turbowarp-v1",
        _ => "cpp-legacy-v1",
    }
}

pub fn is_managed_only_kind(kind: &str) -> bool {
    matches!(
        default_execution_policy_mode_for_kind(kind),
        ExecutionPolicyMode::ManagedOnly
    )
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolchainComponent {
    pub id: String,
    pub kind: String,
    pub relative_path: String,
    #[serde(default)]
    pub roles: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolchainPackageReceipt {
    pub schema_version: u32,
    pub package_id: String,
    pub version: String,
    pub archive_sha256: String,
    pub entrypoint_component_id: String,
    #[serde(default)]
    pub components: Vec<ToolchainComponent>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProfilePreferenceEntry {
    pub mode: String, // "none", "managed", "local_path", "local_auto"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ToolchainPreferencesDoc {
    pub schema_version: u32,
    #[serde(default)]
    pub profiles: HashMap<String, ProfilePreferenceEntry>,
}

#[derive(Debug, Clone)]
pub struct ResolvedToolchain {
    pub kind: String, // "cpp", "c", "python", "pascal", "java", "scratch"
    pub profile_id: String,
    pub source_mode: String, // "none", "managed", "local_path", "local_auto", "system"
    pub version: String,
    pub executable_path: PathBuf,
    pub runtime_executable_path: Option<PathBuf>,
    pub package_root: Option<PathBuf>,
    pub package_id: Option<String>,
    pub package_digest: Option<String>,
    pub ready: bool,
    pub diagnostic: Option<String>,
}

pub fn normalize_language_kind(profile_id: &str) -> &'static str {
    let lower = profile_id.to_ascii_lowercase();
    if lower.contains("python") {
        "python"
    } else if lower.contains("scratch") {
        "scratch"
    } else if lower.contains("pascal") {
        "pascal"
    } else if lower.contains("java") {
        "java"
    } else if lower.starts_with("c-") || lower == "c" {
        "c"
    } else {
        "cpp"
    }
}

pub fn get_app_data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("THEMIS_APP_DATA_DIR") {
        if !dir.trim().is_empty() {
            return PathBuf::from(dir);
        }
    }

    #[cfg(windows)]
    {
        if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
            return PathBuf::from(local_app_data).join("ThemisV2");
        }
        if let Ok(user_profile) = std::env::var("USERPROFILE") {
            return PathBuf::from(user_profile)
                .join("AppData")
                .join("Local")
                .join("ThemisV2");
        }
        PathBuf::from(r"C:\ThemisV2")
    }

    #[cfg(target_os = "macos")]
    {
        if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
            if !local_app_data.trim().is_empty() {
                return PathBuf::from(local_app_data).join("ThemisV2");
            }
        }
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join("ThemisV2");
        }
        PathBuf::from("/tmp/ThemisV2")
    }

    #[cfg(not(any(windows, target_os = "macos")))]
    {
        if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
            if !local_app_data.trim().is_empty() {
                return PathBuf::from(local_app_data).join("ThemisV2");
            }
        }
        if let Ok(xdg_data_home) = std::env::var("XDG_DATA_HOME") {
            if !xdg_data_home.trim().is_empty() {
                return PathBuf::from(xdg_data_home).join("ThemisV2");
            }
        }
        if let Ok(home) = std::env::var("HOME") {
            let local_share = PathBuf::from(&home)
                .join(".local")
                .join("share")
                .join("ThemisV2");
            let legacy_dev = PathBuf::from(&home).join(".themisv2-dev");
            if !local_share.exists() && legacy_dev.exists() {
                return legacy_dev;
            }
            return local_share;
        }
        PathBuf::from("/tmp/ThemisV2")
    }
}

pub fn get_managed_toolchains_dir() -> PathBuf {
    get_app_data_dir().join("toolchains")
}

pub fn get_preferences_file_path_in(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("toolchain-preferences.json")
}

pub fn get_preferences_file_path() -> PathBuf {
    get_preferences_file_path_in(&get_app_data_dir())
}

pub fn load_persisted_preferences_in(app_data_dir: &Path) -> Option<ToolchainPreferencesDoc> {
    for candidate in [
        get_preferences_file_path_in(app_data_dir),
        app_data_dir.join("toolchains.json"),
    ] {
        if candidate.is_file() {
            if let Ok(content) = fs::read_to_string(&candidate) {
                if let Ok(doc) = serde_json::from_str::<ToolchainPreferencesDoc>(&content) {
                    if doc.schema_version == 2 {
                        return Some(doc);
                    }
                }
            }
        }
    }
    None
}

pub fn load_persisted_preferences() -> Option<ToolchainPreferencesDoc> {
    load_persisted_preferences_in(&get_app_data_dir())
}

pub fn save_persisted_preferences_in(
    app_data_dir: &Path,
    selections: &HashMap<String, ProfilePreferenceEntry>,
) -> Result<(), String> {
    fs::create_dir_all(app_data_dir).map_err(|e| {
        format!(
            "failed to create appData directory {}: {e}",
            app_data_dir.display()
        )
    })?;

    let mut profiles = HashMap::new();
    for (key, entry) in selections {
        let kind = normalize_language_kind(key);
        let canonical_id = canonical_profile_id_for_kind(kind);
        let normalized_entry = ProfilePreferenceEntry {
            mode: entry.mode.clone(),
            local_path: if entry.mode == "local_path" {
                entry.local_path.clone()
            } else {
                None
            },
        };
        profiles.insert(canonical_id.to_string(), normalized_entry.clone());
        profiles.insert(kind.to_string(), normalized_entry);
    }

    let doc = ToolchainPreferencesDoc {
        schema_version: 2,
        profiles,
    };

    let serialized = serde_json::to_string_pretty(&doc)
        .map_err(|e| format!("failed to serialize toolchain preferences: {e}"))?;

    let target = get_preferences_file_path_in(app_data_dir);
    let nonce = PREFS_WRITE_NONCE.fetch_add(1, Ordering::Relaxed);
    let tmp_path = app_data_dir.join(format!(
        ".toolchain-preferences.json.tmp.{}.{}",
        std::process::id(),
        nonce
    ));

    {
        let mut file = fs::File::create(&tmp_path)
            .map_err(|e| format!("failed to create temp preferences file: {e}"))?;
        file.write_all(serialized.as_bytes())
            .map_err(|e| format!("failed to write temp preferences file: {e}"))?;
        file.write_all(b"\n")
            .map_err(|e| format!("failed to write newline to temp preferences file: {e}"))?;
        file.sync_all()
            .map_err(|e| format!("failed to sync temp preferences file: {e}"))?;
    }

    fs::rename(&tmp_path, &target).map_err(|e| {
        let _ = fs::remove_file(&tmp_path);
        format!("failed to commit toolchain-preferences.json: {e}")
    })?;

    Ok(())
}

pub fn read_package_receipt(package_root: &Path) -> Option<ToolchainPackageReceipt> {
    let receipt_path = package_root.join(".judgedesk-package.json");
    if receipt_path.is_file() {
        if let Ok(content) = fs::read_to_string(&receipt_path) {
            if let Ok(receipt) = serde_json::from_str::<ToolchainPackageReceipt>(&content) {
                if receipt.schema_version >= 1
                    && !receipt.package_id.trim().is_empty()
                    && !receipt.version.trim().is_empty()
                    && receipt.archive_sha256.len() == 64
                {
                    return Some(receipt);
                }
            }
        }
    }
    None
}

pub fn is_isolated_test_root(dir: &Path) -> bool {
    for ancestor in dir.ancestors() {
        if ancestor.join(".judgedesk-test-root").is_file()
            || is_seeded_contract_fixture_env(ancestor)
        {
            return true;
        }
    }
    false
}

pub fn bundled_resource_toolchains_dirs_for(toolchains_dir: &Path) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let isolated_test = is_isolated_test_root(toolchains_dir);

    if let Ok(res_dir) = std::env::var("THEMIS_RESOURCE_DIR") {
        let trimmed = res_dir.trim();
        if !trimmed.is_empty() {
            let res_path = PathBuf::from(trimmed);
            let allow_res = if isolated_test {
                toolchains_dir
                    .ancestors()
                    .find(|a| a.join(".judgedesk-test-root").is_file())
                    .is_some_and(|test_root| res_path.starts_with(test_root))
            } else {
                true
            };
            if allow_res {
                dirs.push(res_path.join("toolchains"));
            }
        }
    }

    #[cfg(not(any(windows, target_os = "macos")))]
    if !isolated_test && std::env::var_os("THEMIS_APP_DATA_DIR").is_none() {
        for candidate in [
            "/usr/lib/JudgeDesk/toolchains",
            "/usr/lib/judgedesk/toolchains",
            "/opt/judgedesk/toolchains",
            "/usr/share/JudgeDesk/toolchains",
            "/usr/share/judgedesk/toolchains",
        ] {
            let p = PathBuf::from(candidate);
            if !dirs.contains(&p) {
                dirs.push(p);
            }
        }
    }

    dirs
}

fn scan_toolchains_dir_into(toolchains_dir: &Path, installed: &mut HashSet<String>) {
    let Ok(entries) = fs::read_dir(toolchains_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let pkg_dir = entry.path();
        if !pkg_dir.is_dir() {
            continue;
        }
        if let Some(receipt) = read_package_receipt(&pkg_dir) {
            let entrypoint_ok = receipt
                .components
                .iter()
                .find(|c| c.id == receipt.entrypoint_component_id)
                .map(|c| pkg_dir.join(&c.relative_path).is_file())
                .unwrap_or(true);
            if entrypoint_ok {
                installed.insert(receipt.package_id);
                if let Some(dir_name) = pkg_dir.file_name().and_then(|n| n.to_str()) {
                    installed.insert(dir_name.to_string());
                }
            }
        }
    }
}

pub fn discover_installed_managed_packages_in(toolchains_dir: &Path) -> HashSet<String> {
    let mut installed = HashSet::new();
    scan_toolchains_dir_into(toolchains_dir, &mut installed);
    for bundled_dir in bundled_resource_toolchains_dirs_for(toolchains_dir) {
        scan_toolchains_dir_into(&bundled_dir, &mut installed);
    }
    installed
}

pub fn preserve_bundled_toolchains_in(app_data_dir: &Path) -> Result<usize, String> {
    let target_toolchains_dir = app_data_dir.join("toolchains");
    let bundled_dirs = bundled_resource_toolchains_dirs_for(&target_toolchains_dir);
    let mut preserved = 0usize;

    for bundled_dir in bundled_dirs {
        if bundled_dir == target_toolchains_dir || !bundled_dir.is_dir() {
            continue;
        }
        let Ok(entries) = fs::read_dir(&bundled_dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let src_pkg_dir = entry.path();
            if !src_pkg_dir.is_dir() {
                continue;
            }
            let Some(receipt) = read_package_receipt(&src_pkg_dir) else {
                continue;
            };
            let entrypoint_ok = receipt
                .components
                .iter()
                .find(|c| c.id == receipt.entrypoint_component_id)
                .map(|c| src_pkg_dir.join(&c.relative_path).is_file())
                .unwrap_or(true);
            if !entrypoint_ok {
                continue;
            }
            let Some(pkg_name) = src_pkg_dir.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            let dst_pkg_dir = target_toolchains_dir.join(pkg_name);
            if read_package_receipt(&dst_pkg_dir).is_some() {
                continue;
            }

            fs::create_dir_all(&target_toolchains_dir).map_err(|e| {
                format!(
                    "failed to create toolchains directory {}: {e}",
                    target_toolchains_dir.display()
                )
            })?;

            let nonce = PREFS_WRITE_NONCE.fetch_add(1, Ordering::Relaxed);
            let staging_dir = target_toolchains_dir.join(format!(
                ".preserve-{pkg_name}.{}.{nonce}.staging",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&staging_dir);
            if let Err(e) = copy_dir_recursive(&src_pkg_dir, &staging_dir) {
                let _ = fs::remove_dir_all(&staging_dir);
                return Err(format!("failed to stage bundled toolchain {pkg_name}: {e}"));
            }
            if read_package_receipt(&staging_dir).is_none() {
                let _ = fs::remove_dir_all(&staging_dir);
                return Err(format!(
                    "staged bundled toolchain {pkg_name} is missing a valid package receipt"
                ));
            }
            let _ = fs::remove_dir_all(&dst_pkg_dir);
            if let Err(e) = fs::rename(&staging_dir, &dst_pkg_dir) {
                let _ = fs::remove_dir_all(&staging_dir);
                return Err(format!(
                    "failed to commit preserved toolchain {pkg_name}: {e}"
                ));
            }
            preserved += 1;
        }
    }

    Ok(preserved)
}

pub fn managed_package_name_for(kind: &str) -> &'static str {
    #[cfg(windows)]
    match kind {
        "cpp" | "c" => "gcc-windows-x64",
        "python" => "python-windows-x64",
        "pascal" => "fpc-windows-x64",
        "java" => "temurin21-windows-x64",
        "scratch" => "scratch-windows-x64",
        _ => "gcc-windows-x64",
    }

    #[cfg(target_os = "macos")]
    match kind {
        "cpp" | "c" => "gcc-macos-arm64",
        "python" => "python-macos-arm64",
        "pascal" => "fpc-macos-arm64",
        "java" => "temurin21-macos-arm64",
        "scratch" => "scratch-macos-arm64",
        _ => "gcc-macos-arm64",
    }

    #[cfg(not(any(windows, target_os = "macos")))]
    match kind {
        "cpp" | "c" => "gcc-linux-x64",
        "python" => "python-linux-x64",
        "pascal" => "fpc-linux-x64",
        "java" => "temurin21-linux-x64",
        "scratch" => "scratch-linux-x64",
        _ => "gcc-linux-x64",
    }
}

fn find_managed_toolchain_direct(toolchains_dir: &Path, kind: &str) -> Option<ResolvedToolchain> {
    let package_name = managed_package_name_for(kind);
    let package_root = toolchains_dir.join(package_name);

    if !package_root.is_dir() {
        return None;
    }

    let receipt = read_package_receipt(&package_root)?;

    let (exe_rel, runtime_rel) = match kind {
        "cpp" => {
            let rel = receipt
                .components
                .iter()
                .find(|c| c.id == "gcc.cxx" || c.relative_path.contains("g++"))
                .map(|c| c.relative_path.as_str())
                .unwrap_or(if cfg!(windows) {
                    "bin/g++.exe"
                } else {
                    "bin/g++"
                });
            (rel, None)
        }
        "c" => {
            let rel = receipt
                .components
                .iter()
                .find(|c| c.id == "gcc.c" || c.relative_path.contains("gcc"))
                .map(|c| c.relative_path.as_str())
                .unwrap_or(if cfg!(windows) {
                    "bin/gcc.exe"
                } else {
                    "bin/gcc"
                });
            (rel, None)
        }
        "python" => {
            let rel = receipt
                .components
                .iter()
                .find(|c| {
                    c.id == "python.runtime" || c.roles.iter().any(|r| r == "submission-runtime")
                })
                .map(|c| c.relative_path.as_str())
                .unwrap_or(if cfg!(windows) {
                    "python.exe"
                } else {
                    "python3"
                });
            (rel, None)
        }
        "pascal" => {
            let rel = receipt
                .components
                .iter()
                .find(|c| c.id == "fpc.compiler" || c.roles.iter().any(|r| r == "compiler"))
                .map(|c| c.relative_path.as_str())
                .unwrap_or(if cfg!(windows) {
                    "bin/ppcx64.exe"
                } else {
                    "bin/ppcx64"
                });
            (rel, None)
        }
        "java" => {
            let javac_rel = receipt
                .components
                .iter()
                .find(|c| c.id == "java.compiler" || c.relative_path.contains("javac"))
                .map(|c| c.relative_path.as_str())
                .unwrap_or(if cfg!(windows) {
                    "bin/javac.exe"
                } else {
                    "bin/javac"
                });
            let java_rel = receipt
                .components
                .iter()
                .find(|c| {
                    c.id == "java.runtime"
                        || c.relative_path.contains("java.exe")
                        || c.relative_path.ends_with("/java")
                })
                .map(|c| c.relative_path.as_str())
                .unwrap_or(if cfg!(windows) {
                    "bin/java.exe"
                } else {
                    "bin/java"
                });
            (javac_rel, Some(java_rel))
        }
        "scratch" => {
            let rel = receipt
                .components
                .iter()
                .find(|c| c.id == "scratch.runtime" || c.relative_path.contains("scratch-run"))
                .map(|c| c.relative_path.as_str())
                .unwrap_or(if cfg!(windows) {
                    "scratch-run.exe"
                } else {
                    "scratch-run"
                });
            (rel, None)
        }
        _ => return None,
    };

    let exe_path = package_root.join(exe_rel);
    if !exe_path.is_file() {
        return None;
    }

    let runtime_path = runtime_rel.map(|r| package_root.join(r));

    Some(ResolvedToolchain {
        kind: kind.to_string(),
        profile_id: kind.to_string(),
        source_mode: "managed".to_string(),
        version: receipt.version.clone(),
        executable_path: exe_path,
        runtime_executable_path: runtime_path,
        package_root: Some(package_root),
        package_id: Some(receipt.package_id.clone()),
        package_digest: Some(receipt.archive_sha256.clone()),
        ready: true,
        diagnostic: None,
    })
}

pub fn find_managed_toolchain_in(toolchains_dir: &Path, kind: &str) -> Option<ResolvedToolchain> {
    if let Some(found) = find_managed_toolchain_direct(toolchains_dir, kind) {
        return Some(found);
    }
    for bundled_dir in bundled_resource_toolchains_dirs_for(toolchains_dir) {
        if let Some(found) = find_managed_toolchain_direct(&bundled_dir, kind) {
            return Some(found);
        }
    }
    None
}

pub fn find_managed_toolchain(kind: &str) -> Option<ResolvedToolchain> {
    if let Some(found) = find_managed_toolchain_in(&get_managed_toolchains_dir(), kind) {
        return Some(found);
    }
    #[cfg(windows)]
    if std::env::var_os("THEMIS_APP_DATA_DIR").is_none() {
        if let Ok(user_profile) = std::env::var("USERPROFILE") {
            let host_toolchains = PathBuf::from(user_profile)
                .join("AppData")
                .join("Local")
                .join("ThemisV2")
                .join("toolchains");
            if let Some(found) = find_managed_toolchain_direct(&host_toolchains, kind) {
                return Some(found);
            }
        }
    }
    #[cfg(target_os = "macos")]
    if std::env::var_os("THEMIS_APP_DATA_DIR").is_none() {
        if let Ok(home) = std::env::var("HOME") {
            let host_toolchains = PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join("ThemisV2")
                .join("toolchains");
            if let Some(found) = find_managed_toolchain_direct(&host_toolchains, kind) {
                return Some(found);
            }
        }
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    if std::env::var_os("THEMIS_APP_DATA_DIR").is_none() {
        let mut candidates = Vec::new();
        if let Ok(res_dir) = std::env::var("THEMIS_RESOURCE_DIR") {
            if !res_dir.trim().is_empty() {
                candidates.push(PathBuf::from(res_dir.trim()).join("toolchains"));
            }
        }
        if let Ok(home) = std::env::var("HOME") {
            candidates.push(
                PathBuf::from(&home)
                    .join(".local")
                    .join("share")
                    .join("ThemisV2")
                    .join("toolchains"),
            );
            candidates.push(
                PathBuf::from(&home)
                    .join(".themisv2-dev")
                    .join("toolchains"),
            );
        }
        candidates.push(PathBuf::from("/usr/lib/JudgeDesk/toolchains"));
        candidates.push(PathBuf::from("/usr/lib/judgedesk/toolchains"));
        candidates.push(PathBuf::from("/opt/judgedesk/toolchains"));
        candidates.push(PathBuf::from("/usr/share/JudgeDesk/toolchains"));
        candidates.push(PathBuf::from("/usr/share/judgedesk/toolchains"));
        candidates
            .push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../src-tauri/toolchains"));
        for candidate in candidates {
            if let Some(found) = find_managed_toolchain_direct(&candidate, kind) {
                return Some(found);
            }
        }
    }
    None
}

pub fn clean_canonical_path(path: &Path) -> PathBuf {
    let canon = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    #[cfg(windows)]
    {
        let s = canon.to_string_lossy();
        if let Some(stripped) = s.strip_prefix(r"\\?\") {
            return PathBuf::from(stripped);
        }
    }
    canon
}

/// Resolves macOS Framework Python launcher stubs (`.../Versions/3.x/bin/python3`)
/// to the direct interpreter binary (`.../Versions/3.x/Resources/Python.app/Contents/MacOS/Python`)
/// and returns `(canonical_executable_path, canonical_toolchain_root)`.
pub fn resolve_macos_framework_python_executable(candidate: &Path) -> Option<(PathBuf, PathBuf)> {
    if !candidate.is_file() {
        return None;
    }
    let canonical = clean_canonical_path(candidate);

    // Case 1: Candidate is `<ver_root>/bin/python*` where `<ver_root>/Resources/Python.app/Contents/MacOS/Python` exists
    if let Some(bin_dir) = canonical.parent() {
        if bin_dir
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.eq_ignore_ascii_case("bin"))
        {
            if let Some(ver_root) = bin_dir.parent().filter(|p| p.parent().is_some()) {
                let framework_direct = ver_root
                    .join("Resources")
                    .join("Python.app")
                    .join("Contents")
                    .join("MacOS")
                    .join("Python");
                if framework_direct.is_file() {
                    let direct_canon = clean_canonical_path(&framework_direct);
                    let root_canon = clean_canonical_path(ver_root);
                    return Some((direct_canon, root_canon));
                }
                let root_canon = clean_canonical_path(ver_root);
                return Some((canonical, root_canon));
            }
        }

        // Case 2: Candidate is already `<ver_root>/Resources/Python.app/Contents/MacOS/Python`
        if bin_dir
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.eq_ignore_ascii_case("MacOS"))
        {
            if let Some(ver_root) = bin_dir
                .parent()
                .and_then(|p| p.parent())
                .and_then(|p| p.parent())
            {
                let root_canon = clean_canonical_path(ver_root);
                return Some((canonical, root_canon));
            }
        }

        let root_canon = clean_canonical_path(bin_dir);
        return Some((canonical, root_canon));
    }

    None
}

fn configure_background_command(cmd: &mut std::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}

fn run_command_bounded(
    mut cmd: std::process::Command,
    timeout: Duration,
) -> Result<std::process::Output, String> {
    configure_background_command(&mut cmd);
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn executable: {e}"))?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                return child
                    .wait_with_output()
                    .map_err(|e| format!("failed to collect process output: {e}"));
            }
            Ok(None) => {
                if start.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("LOCAL_PROBE_TIMEOUT: compatibility probe timed out".to_string());
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("failed waiting on probe process: {e}"));
            }
        }
    }
}

pub fn query_executable_version(exe_path: &Path, kind: &str) -> String {
    let args: &[&str] = match kind {
        "pascal" => &["-iV"],
        "java" => &["--version", "-version"],
        _ => &["--version"],
    };

    for arg in args {
        let mut cmd = std::process::Command::new(exe_path);
        cmd.arg(arg);

        if let Ok(output) = run_command_bounded(cmd, Duration::from_millis(3_000)) {
            if !output.status.success() {
                continue;
            }
            let text = if output.stdout.is_empty() {
                String::from_utf8_lossy(&output.stderr)
            } else {
                String::from_utf8_lossy(&output.stdout)
            };
            for line in text.lines() {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                for word in trimmed.split_whitespace() {
                    let stripped = word.trim_start_matches(|c: char| !c.is_ascii_digit());
                    let prefix = stripped
                        .split(['-', '~', ')', '"', '\'', ';', ','])
                        .next()
                        .unwrap_or("");
                    let clean = prefix.trim_matches(|c: char| !c.is_ascii_digit() && c != '.');
                    if clean.chars().filter(|&c| c == '.').count() >= 1
                        && clean.chars().next().is_some_and(|c| c.is_ascii_digit())
                        && clean.chars().last().is_some_and(|c| c.is_ascii_digit())
                        && clean.chars().all(|c| c.is_ascii_digit() || c == '.')
                    {
                        return clean.to_string();
                    }
                }
            }
        }
    }
    "unknown".to_string()
}

/// Runs the `quick_verified_direct` bounded native compatibility probe for local toolchains.
pub fn run_quick_verified_direct_probe(exe_path: &Path, kind: &str) -> Result<String, String> {
    if !exe_path.is_file() {
        return Err("LOCAL_EXECUTABLE_MISSING: executable does not exist".to_string());
    }
    let clean_exe = clean_canonical_path(exe_path);
    let version = query_executable_version(&clean_exe, kind);
    if version == "unknown" {
        return Err(format!(
            "LOCAL_PROBE_FAILED: failed to query version from {}",
            clean_exe.display()
        ));
    }

    match kind {
        "python" => {
            let mut cmd = std::process::Command::new(&clean_exe);
            cmd.args([
                "-I",
                "-B",
                "-S",
                "-c",
                "import sys; sys.stdout.write('JD_PY_OK:' + sys.version.split()[0])",
            ]);
            let output = run_command_bounded(cmd, Duration::from_millis(3_000))?;
            let stdout = String::from_utf8_lossy(&output.stdout);
            if !output.status.success() || !stdout.contains("JD_PY_OK:") {
                return Err(format!(
                    "LOCAL_PROBE_FAILED: Python isolated probe failed for {}",
                    clean_exe.display()
                ));
            }
            Ok(version)
        }
        "c" | "cpp" => {
            let nonce = PREFS_WRITE_NONCE.fetch_add(1, Ordering::Relaxed);
            let probe_dir = std::env::temp_dir().join(format!(
                "jd_quick_probe_{}_{}",
                std::process::id(),
                nonce
            ));
            fs::create_dir_all(&probe_dir)
                .map_err(|e| format!("failed to create probe dir: {e}"))?;
            let src_file = probe_dir.join(if kind == "c" { "probe.c" } else { "probe.cpp" });
            let obj_file = probe_dir.join("probe.o");
            let _ = fs::write(&src_file, b"int main(void) { return 0; }\n");

            let mut cmd = std::process::Command::new(&clean_exe);
            cmd.env_remove("C_INCLUDE_PATH")
                .env_remove("CPATH")
                .env_remove("CPLUS_INCLUDE_PATH");
            if kind == "c" {
                cmd.arg("-std=c11");
            } else {
                cmd.arg("-std=c++14");
            }
            cmd.arg("-c").arg(&src_file).arg("-o").arg(&obj_file);
            if let Some(bin_dir) = clean_exe.parent() {
                if let Ok(curr_path) = std::env::var("PATH") {
                    let sep = if cfg!(windows) { ";" } else { ":" };
                    cmd.env("PATH", format!("{}{sep}{curr_path}", bin_dir.display()));
                }
            }

            let res = run_command_bounded(cmd, Duration::from_millis(5_000));
            let obj_exists = obj_file.is_file();
            let _ = fs::remove_dir_all(&probe_dir);

            let output = res?;
            if !output.status.success() || !obj_exists {
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err(format!(
                    "LOCAL_PROBE_FAILED: minimal {kind} compile probe failed: {}",
                    stderr.trim()
                ));
            }
            Ok(version)
        }
        "pascal" | "scratch" => Ok(version),
        "java" => {
            let java_runtime =
                clean_exe.with_file_name(if cfg!(windows) { "java.exe" } else { "java" });
            if !java_runtime.is_file() {
                return Err(format!(
                    "LOCAL_PROBE_FAILED: sibling java runtime executable not found beside {}",
                    clean_exe.display()
                ));
            }
            Ok(version)
        }
        _ => Err(format!(
            "LOCAL_NOT_SANDBOX_COMPATIBLE: {kind} does not support quick_verified_direct"
        )),
    }
}

fn sha256_digest(data: &[u8]) -> [u8; 32] {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut state: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    let bit_len = (data.len() as u64).wrapping_mul(8);
    let mut padded = Vec::with_capacity((data.len() + 9).div_ceil(64) * 64);
    padded.extend_from_slice(data);
    padded.push(0x80);
    while (padded.len() % 64) != 56 {
        padded.push(0);
    }
    padded.extend_from_slice(&bit_len.to_be_bytes());

    for chunk in padded.chunks_exact(64) {
        let mut w = [0u32; 64];
        for (i, word) in w.iter_mut().take(16).enumerate() {
            let off = i * 4;
            *word =
                u32::from_be_bytes([chunk[off], chunk[off + 1], chunk[off + 2], chunk[off + 3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = state;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = h
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);

            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }
        for (st, delta) in state.iter_mut().zip([a, b, c, d, e, f, g, h]) {
            *st = st.wrapping_add(delta);
        }
    }

    let mut out = [0u8; 32];
    for (i, word) in state.iter().enumerate() {
        out[i * 4..(i + 1) * 4].copy_from_slice(&word.to_be_bytes());
    }
    out
}

pub fn compute_binary_sha256_hex(exe_path: &Path) -> Result<String, String> {
    let bytes =
        fs::read(exe_path).map_err(|e| format!("failed to read binary for digest check: {e}"))?;
    let digest = sha256_digest(&bytes);
    let mut hex = String::with_capacity(64);
    for b in digest {
        use std::fmt::Write as _;
        let _ = write!(&mut hex, "{b:02x}");
    }
    Ok(hex)
}

pub fn verify_binary_certificate_thumbprint(
    exe_path: &Path,
    expected_thumbprint: Option<&str>,
) -> Result<String, String> {
    let raw_expected = expected_thumbprint
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            "CERTIFICATION_REQUIRED: freeze_required policy demands a verified certificate thumbprint or snapshot digest".to_string()
        })?;

    let normalized_expected: String = raw_expected
        .chars()
        .filter(|c| c.is_ascii_hexdigit())
        .map(|c| c.to_ascii_lowercase())
        .collect();

    if normalized_expected.len() != 40 && normalized_expected.len() != 64 {
        return Err(
            "CERTIFICATE_THUMBPRINT_MISMATCH: invalid thumbprint format (expected 40-hex SHA-1 or 64-hex SHA-256)".to_string(),
        );
    }

    let sha256_hex = compute_binary_sha256_hex(exe_path)?;
    if normalized_expected == sha256_hex {
        return Ok(sha256_hex);
    }

    #[cfg(windows)]
    {
        if normalized_expected.len() == 40 {
            let mut ps_cmd = std::process::Command::new("powershell");
            configure_background_command(&mut ps_cmd);
            if let Ok(output) = ps_cmd
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    "$sig = Get-AuthenticodeSignature -LiteralPath $env:JD_VERIFY_CERT_PATH; if ($null -ne $sig.SignerCertificate) { [Console]::Out.Write($sig.SignerCertificate.Thumbprint) }",
                ])
                .env("JD_VERIFY_CERT_PATH", exe_path.as_os_str())
                .output()
            {
                if output.status.success() {
                    let actual: String = String::from_utf8_lossy(&output.stdout)
                        .chars()
                        .filter(|c| c.is_ascii_hexdigit())
                        .map(|c| c.to_ascii_lowercase())
                        .collect();
                    if !actual.is_empty() && actual == normalized_expected {
                        return Ok(actual);
                    }
                }
            }
        }
    }

    Err(format!(
        "CERTIFICATE_THUMBPRINT_MISMATCH: binary digest/thumbprint of '{}' does not match frozen certificate snapshot",
        exe_path.display()
    ))
}

pub fn find_system_executable(kind: &str) -> Option<PathBuf> {
    let candidates: &[&str] = match kind {
        "cpp" => {
            #[cfg(windows)]
            {
                &[
                    "g++.exe",
                    "clang++.exe",
                    r"C:\Themis\GCC\bin\g++.exe",
                    r"C:\MinGW\bin\g++.exe",
                ]
            }
            #[cfg(target_os = "macos")]
            {
                &[
                    "/Library/Developer/CommandLineTools/usr/bin/clang++",
                    "/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang++",
                    "/usr/bin/clang++",
                    "/usr/bin/g++",
                    "clang++",
                    "g++",
                ]
            }
            #[cfg(not(any(windows, target_os = "macos")))]
            {
                &[
                    "g++",
                    "clang++",
                    "/usr/bin/g++",
                    "/usr/local/bin/g++",
                    "g++-14",
                    "g++-13",
                    "g++-12",
                    "g++-11",
                    "/usr/bin/clang++",
                ]
            }
        }
        "c" => {
            #[cfg(windows)]
            {
                &[
                    "gcc.exe",
                    "clang.exe",
                    r"C:\Themis\GCC\bin\gcc.exe",
                    r"C:\MinGW\bin\gcc.exe",
                ]
            }
            #[cfg(target_os = "macos")]
            {
                &[
                    "/Library/Developer/CommandLineTools/usr/bin/clang",
                    "/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang",
                    "/usr/bin/clang",
                    "/usr/bin/gcc",
                    "clang",
                    "gcc",
                ]
            }
            #[cfg(not(any(windows, target_os = "macos")))]
            {
                &[
                    "gcc",
                    "clang",
                    "/usr/bin/gcc",
                    "/usr/local/bin/gcc",
                    "gcc-14",
                    "gcc-13",
                    "gcc-12",
                    "gcc-11",
                    "/usr/bin/clang",
                ]
            }
        }
        "python" => {
            #[cfg(windows)]
            {
                &["python.exe", "python3.exe", r"C:\Themis\Python\python.exe"]
            }
            #[cfg(target_os = "macos")]
            {
                &[
                    "/Library/Frameworks/Python.framework/Versions/Current/bin/python3",
                    "/Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/Current/bin/python3",
                    "/usr/bin/python3",
                    "python3",
                    "python",
                ]
            }
            #[cfg(not(any(windows, target_os = "macos")))]
            {
                &[
                    "python3",
                    "python",
                    "/usr/bin/python3",
                    "/usr/local/bin/python3",
                    "python3.13",
                    "python3.12",
                    "python3.11",
                    "python3.10",
                ]
            }
        }
        "pascal" => {
            #[cfg(windows)]
            {
                &["fpc.exe", "ppcx64.exe"]
            }
            #[cfg(target_os = "macos")]
            {
                &[
                    "/usr/local/bin/fpc",
                    "/opt/homebrew/bin/fpc",
                    "fpc",
                    "ppcx64",
                    "ppca64",
                ]
            }
            #[cfg(not(any(windows, target_os = "macos")))]
            {
                &[
                    "fpc",
                    "ppcx64",
                    "/usr/bin/fpc",
                    "/usr/local/bin/fpc",
                    "/usr/bin/ppcx64",
                ]
            }
        }
        "java" => {
            #[cfg(windows)]
            {
                &["javac.exe"]
            }
            #[cfg(target_os = "macos")]
            {
                &["/usr/bin/javac", "/opt/homebrew/bin/javac", "javac"]
            }
            #[cfg(not(any(windows, target_os = "macos")))]
            {
                &["javac", "/usr/bin/javac", "/usr/local/bin/javac"]
            }
        }
        "scratch" => {
            #[cfg(windows)]
            {
                &["scratch-run.exe"]
            }
            #[cfg(target_os = "macos")]
            {
                &["scratch-run", "/usr/local/bin/scratch-run"]
            }
            #[cfg(not(any(windows, target_os = "macos")))]
            {
                &[
                    "scratch-run",
                    "/usr/local/bin/scratch-run",
                    "/usr/bin/scratch-run",
                    "/usr/lib/JudgeDesk/toolchains/scratch-linux-x64/scratch-run",
                    "/usr/lib/judgedesk/toolchains/scratch-linux-x64/scratch-run",
                ]
            }
        }
        _ => &[],
    };

    for candidate in candidates {
        let p = Path::new(candidate);
        if p.is_absolute() && p.is_file() {
            return Some(p.to_path_buf());
        }
        #[cfg(windows)]
        {
            let mut where_cmd = std::process::Command::new("where.exe");
            configure_background_command(&mut where_cmd);
            if let Ok(output) = where_cmd
                .arg(candidate)
                .output()
            {
                if output.status.success() {
                    for line in String::from_utf8_lossy(&output.stdout).lines() {
                        let trimmed = line.trim();
                        if trimmed.is_empty() || trimmed.contains("WindowsApps") {
                            continue;
                        }
                        let path = PathBuf::from(trimmed);
                        if path.is_file() {
                            return Some(path);
                        }
                    }
                }
            }
        }
        #[cfg(not(windows))]
        {
            if let Ok(output) = std::process::Command::new("which").arg(candidate).output() {
                if output.status.success() {
                    let first = String::from_utf8_lossy(&output.stdout)
                        .lines()
                        .next()
                        .map(|l| l.trim().to_string());
                    if let Some(path_str) = first {
                        let path = PathBuf::from(path_str);
                        if path.is_file() {
                            return Some(path);
                        }
                    }
                }
            }
        }
    }
    None
}

pub fn is_seeded_contract_fixture_env(app_data_dir: &Path) -> bool {
    app_data_dir
        .join("toolchain-distribution-state-v1.json")
        .is_file()
        && fs::read_to_string(app_data_dir.join("toolchain-discovery-v2.json"))
            .is_ok_and(|c| c.contains("2026-09-20T10:00:00.000Z"))
}

pub fn resolve_toolchain_for_profile_with_policy(
    profile_id: &str,
    preference_mode: Option<&str>,
    preference_local_path: Option<&str>,
    policy_mode: ExecutionPolicyMode,
    expected_thumbprint: Option<&str>,
) -> ResolvedToolchain {
    resolve_toolchain_for_profile_with_policy_in(
        None,
        profile_id,
        preference_mode,
        preference_local_path,
        policy_mode,
        expected_thumbprint,
    )
}

pub fn resolve_toolchain_for_profile_with_policy_in(
    app_data_dir: Option<&Path>,
    profile_id: &str,
    preference_mode: Option<&str>,
    preference_local_path: Option<&str>,
    policy_mode: ExecutionPolicyMode,
    expected_thumbprint: Option<&str>,
) -> ResolvedToolchain {
    let kind = normalize_language_kind(profile_id);
    let effective_policy = if is_managed_only_kind(kind) {
        ExecutionPolicyMode::ManagedOnly
    } else {
        policy_mode
    };

    let (mode, local_path, explicit_mode) = match (preference_mode, preference_local_path) {
        (Some(m), p) => (m.to_string(), p.map(String::from), true),
        (None, _) => {
            let doc = match app_data_dir {
                Some(dir) => load_persisted_preferences_in(dir),
                None => load_persisted_preferences(),
            };
            let entry = doc.as_ref().and_then(|d| {
                d.profiles
                    .get(profile_id)
                    .or_else(|| d.profiles.get(canonical_profile_id_for_kind(kind)))
                    .or_else(|| {
                        d.profiles
                            .iter()
                            .find(|(k, _)| normalize_language_kind(k) == kind)
                            .map(|(_, v)| v)
                    })
            });
            match entry {
                Some(e) => (e.mode.clone(), e.local_path.clone(), true),
                None => ("managed".to_string(), None, false),
            }
        }
    };

    match mode.as_str() {
        "none" => ResolvedToolchain {
            kind: kind.to_string(),
            profile_id: profile_id.to_string(),
            source_mode: "none".to_string(),
            version: "unknown".to_string(),
            executable_path: PathBuf::new(),
            runtime_executable_path: None,
            package_root: None,
            package_id: None,
            package_digest: None,
            ready: false,
            diagnostic: Some("Toolchain profile is disabled (mode=none).".to_string()),
        },
        "managed" => {
            let managed_opt = match app_data_dir {
                Some(dir) => {
                    find_managed_toolchain_in(&dir.join("toolchains"), kind).or_else(|| {
                        if !is_seeded_contract_fixture_env(dir) {
                            find_managed_toolchain(kind)
                        } else {
                            None
                        }
                    })
                }
                None => find_managed_toolchain(kind),
            };
            if let Some(managed) = managed_opt {
                return ResolvedToolchain {
                    profile_id: profile_id.to_string(),
                    ..managed
                };
            }
            // If no explicit mode was requested and no preference file was saved on disk,
            // allow non-managed_only languages (C/C++/Python) to check local_auto on dev hosts.
            if !explicit_mode && !is_managed_only_kind(kind) {
                return resolve_toolchain_for_profile_with_policy_in(
                    app_data_dir,
                    profile_id,
                    Some("local_auto"),
                    None,
                    effective_policy,
                    expected_thumbprint,
                );
            }
            ResolvedToolchain {
                kind: kind.to_string(),
                profile_id: profile_id.to_string(),
                source_mode: "managed".to_string(),
                version: "unknown".to_string(),
                executable_path: PathBuf::new(),
                runtime_executable_path: None,
                package_root: None,
                package_id: None,
                package_digest: None,
                ready: false,
                diagnostic: Some(format!(
                    "MANAGED_TOOLCHAIN_NOT_READY: Managed package for {kind} is not installed or its receipt is missing."
                )),
            }
        }
        "local_path" => {
            if matches!(effective_policy, ExecutionPolicyMode::ManagedOnly) {
                return ResolvedToolchain {
                    kind: kind.to_string(),
                    profile_id: profile_id.to_string(),
                    source_mode: "local_path".to_string(),
                    version: "unknown".to_string(),
                    executable_path: PathBuf::new(),
                    runtime_executable_path: None,
                    package_root: None,
                    package_id: None,
                    package_digest: None,
                    ready: false,
                    diagnostic: Some(format!(
                        "LOCAL_NOT_SANDBOX_COMPATIBLE: {kind} only supports managed toolchains."
                    )),
                };
            }
            let Some(ref path_str) = local_path else {
                return ResolvedToolchain {
                    kind: kind.to_string(),
                    profile_id: profile_id.to_string(),
                    source_mode: "local_path".to_string(),
                    version: "unknown".to_string(),
                    executable_path: PathBuf::new(),
                    runtime_executable_path: None,
                    package_root: None,
                    package_id: None,
                    package_digest: None,
                    ready: false,
                    diagnostic: Some(
                        "LOCAL_PATH_MISSING: No local executable path configured.".to_string(),
                    ),
                };
            };
            let raw_path = PathBuf::from(path_str);
            if !raw_path.is_file() {
                return ResolvedToolchain {
                    kind: kind.to_string(),
                    profile_id: profile_id.to_string(),
                    source_mode: "local_path".to_string(),
                    version: "unknown".to_string(),
                    executable_path: PathBuf::new(),
                    runtime_executable_path: None,
                    package_root: None,
                    package_id: None,
                    package_digest: None,
                    ready: false,
                    diagnostic: Some(format!(
                        "LOCAL_EXECUTABLE_NOT_FOUND: Configured local executable '{}' does not exist.",
                        raw_path.display()
                    )),
                };
            }

            let (exe_path, inferred_root) = if kind == "python" {
                resolve_macos_framework_python_executable(&raw_path).unwrap_or_else(|| {
                    let canon = clean_canonical_path(&raw_path);
                    let root = canon
                        .parent()
                        .and_then(|p| {
                            if cfg!(target_os = "linux")
                                && p.file_name()
                                    .and_then(|n| n.to_str())
                                    .is_some_and(|n| n.eq_ignore_ascii_case("bin"))
                            {
                                p.parent()
                                    .filter(|pp| pp.parent().is_some())
                                    .map(Path::to_path_buf)
                                    .or_else(|| Some(p.to_path_buf()))
                            } else {
                                Some(p.to_path_buf())
                            }
                        })
                        .unwrap_or_else(|| PathBuf::from("."));
                    (canon, root)
                })
            } else {
                let canon = clean_canonical_path(&raw_path);
                let root = canon
                    .parent()
                    .and_then(|p| {
                        if p.file_name()
                            .and_then(|n| n.to_str())
                            .is_some_and(|n| n.eq_ignore_ascii_case("bin"))
                        {
                            p.parent()
                                .filter(|pp| pp.parent().is_some())
                                .map(Path::to_path_buf)
                                .or_else(|| Some(p.to_path_buf()))
                        } else {
                            Some(p.to_path_buf())
                        }
                    })
                    .unwrap_or_else(|| PathBuf::from("."));
                (canon, root)
            };

            if matches!(effective_policy, ExecutionPolicyMode::FreezeRequired) {
                if let Err(err) =
                    verify_binary_certificate_thumbprint(&exe_path, expected_thumbprint)
                {
                    return ResolvedToolchain {
                        kind: kind.to_string(),
                        profile_id: profile_id.to_string(),
                        source_mode: "local_path".to_string(),
                        version: "unknown".to_string(),
                        executable_path: exe_path,
                        runtime_executable_path: None,
                        package_root: Some(inferred_root),
                        package_id: None,
                        package_digest: None,
                        ready: false,
                        diagnostic: Some(err),
                    };
                }
            }

            match run_quick_verified_direct_probe(&exe_path, kind) {
                Ok(ver) => {
                    let runtime_exe = if kind == "java" {
                        let sibling = exe_path.with_file_name(if cfg!(windows) {
                            "java.exe"
                        } else {
                            "java"
                        });
                        sibling.is_file().then_some(sibling)
                    } else {
                        None
                    };
                    ResolvedToolchain {
                        kind: kind.to_string(),
                        profile_id: profile_id.to_string(),
                        source_mode: "local_path".to_string(),
                        version: ver,
                        executable_path: exe_path,
                        runtime_executable_path: runtime_exe,
                        package_root: Some(inferred_root),
                        package_id: None,
                        package_digest: None,
                        ready: true,
                        diagnostic: None,
                    }
                }
                Err(err) => ResolvedToolchain {
                    kind: kind.to_string(),
                    profile_id: profile_id.to_string(),
                    source_mode: "local_path".to_string(),
                    version: "unknown".to_string(),
                    executable_path: exe_path,
                    runtime_executable_path: None,
                    package_root: Some(inferred_root),
                    package_id: None,
                    package_digest: None,
                    ready: false,
                    diagnostic: Some(err),
                },
            }
        }
        "local_auto" | "system" => {
            if matches!(effective_policy, ExecutionPolicyMode::ManagedOnly) {
                return ResolvedToolchain {
                    kind: kind.to_string(),
                    profile_id: profile_id.to_string(),
                    source_mode: mode,
                    version: "unknown".to_string(),
                    executable_path: PathBuf::new(),
                    runtime_executable_path: None,
                    package_root: None,
                    package_id: None,
                    package_digest: None,
                    ready: false,
                    diagnostic: Some(format!(
                        "LOCAL_NOT_SANDBOX_COMPATIBLE: {kind} only supports managed toolchains."
                    )),
                };
            }
            if let Some(sys_exe) = find_system_executable(kind) {
                let (exe_path, inferred_root) = if kind == "python" {
                    resolve_macos_framework_python_executable(&sys_exe).unwrap_or_else(|| {
                        let canon = clean_canonical_path(&sys_exe);
                        let root = canon
                            .parent()
                            .and_then(|p| {
                                if cfg!(target_os = "linux")
                                    && p.file_name()
                                        .and_then(|n| n.to_str())
                                        .is_some_and(|n| n.eq_ignore_ascii_case("bin"))
                                {
                                    p.parent()
                                        .filter(|pp| pp.parent().is_some())
                                        .map(Path::to_path_buf)
                                        .or_else(|| Some(p.to_path_buf()))
                                } else {
                                    Some(p.to_path_buf())
                                }
                            })
                            .unwrap_or_else(|| PathBuf::from("."));
                        (canon, root)
                    })
                } else {
                    let canon = clean_canonical_path(&sys_exe);
                    let root = canon
                        .parent()
                        .and_then(|p| {
                            if p.file_name()
                                .and_then(|n| n.to_str())
                                .is_some_and(|n| n.eq_ignore_ascii_case("bin"))
                            {
                                p.parent()
                                    .filter(|pp| pp.parent().is_some())
                                    .map(Path::to_path_buf)
                                    .or_else(|| Some(p.to_path_buf()))
                            } else {
                                Some(p.to_path_buf())
                            }
                        })
                        .unwrap_or_else(|| PathBuf::from("."));
                    (canon, root)
                };

                if matches!(effective_policy, ExecutionPolicyMode::FreezeRequired) {
                    if let Err(err) =
                        verify_binary_certificate_thumbprint(&exe_path, expected_thumbprint)
                    {
                        return ResolvedToolchain {
                            kind: kind.to_string(),
                            profile_id: profile_id.to_string(),
                            source_mode: "system".to_string(),
                            version: "unknown".to_string(),
                            executable_path: exe_path,
                            runtime_executable_path: None,
                            package_root: Some(inferred_root),
                            package_id: None,
                            package_digest: None,
                            ready: false,
                            diagnostic: Some(err),
                        };
                    }
                }

                if let Ok(ver) = run_quick_verified_direct_probe(&exe_path, kind) {
                    let runtime_exe = if kind == "java" {
                        let sibling = exe_path.with_file_name(if cfg!(windows) {
                            "java.exe"
                        } else {
                            "java"
                        });
                        sibling.is_file().then_some(sibling)
                    } else {
                        None
                    };
                    return ResolvedToolchain {
                        kind: kind.to_string(),
                        profile_id: profile_id.to_string(),
                        source_mode: "system".to_string(),
                        version: ver,
                        executable_path: exe_path,
                        runtime_executable_path: runtime_exe,
                        package_root: Some(inferred_root),
                        package_id: None,
                        package_digest: None,
                        ready: true,
                        diagnostic: None,
                    };
                }
            }
            if cfg!(target_os = "linux")
                && kind == "scratch"
                && !app_data_dir.is_some_and(is_seeded_contract_fixture_env)
            {
                let managed_fallback = match app_data_dir {
                    Some(dir) => find_managed_toolchain_in(&dir.join("toolchains"), kind)
                        .or_else(|| find_managed_toolchain(kind)),
                    None => find_managed_toolchain(kind),
                };
                if let Some(managed) = managed_fallback {
                    return ResolvedToolchain {
                        profile_id: profile_id.to_string(),
                        ..managed
                    };
                }
            }
            ResolvedToolchain {
                kind: kind.to_string(),
                profile_id: profile_id.to_string(),
                source_mode: mode,
                version: "unknown".to_string(),
                executable_path: PathBuf::new(),
                runtime_executable_path: None,
                package_root: None,
                package_id: None,
                package_digest: None,
                ready: false,
                diagnostic: Some(format!(
                    "No functional local compiler or runtime discovered for {kind}."
                )),
            }
        }
        other => ResolvedToolchain {
            kind: kind.to_string(),
            profile_id: profile_id.to_string(),
            source_mode: other.to_string(),
            version: "unknown".to_string(),
            executable_path: PathBuf::new(),
            runtime_executable_path: None,
            package_root: None,
            package_id: None,
            package_digest: None,
            ready: false,
            diagnostic: Some(format!("Unsupported toolchain source mode '{other}'.")),
        },
    }
}

pub fn resolve_toolchain_for_profile(
    profile_id: &str,
    preference_mode: Option<&str>,
    preference_local_path: Option<&str>,
) -> ResolvedToolchain {
    resolve_toolchain_for_profile_in(None, profile_id, preference_mode, preference_local_path)
}

pub fn resolve_toolchain_for_profile_in(
    app_data_dir: Option<&Path>,
    profile_id: &str,
    preference_mode: Option<&str>,
    preference_local_path: Option<&str>,
) -> ResolvedToolchain {
    let kind = normalize_language_kind(profile_id);
    let default_policy = default_execution_policy_mode_for_kind(kind);
    resolve_toolchain_for_profile_with_policy_in(
        app_data_dir,
        profile_id,
        preference_mode,
        preference_local_path,
        default_policy,
        None,
    )
}

pub fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let dest_path = dst.join(entry.file_name());
        #[cfg(unix)]
        if file_type.is_symlink() {
            let link_target = fs::read_link(entry.path())?;
            std::os::unix::fs::symlink(link_target, &dest_path)?;
            continue;
        }
        if file_type.is_dir() {
            copy_dir_recursive(&entry.path(), &dest_path)?;
        } else {
            fs::copy(entry.path(), dest_path)?;
        }
    }
    Ok(())
}

pub fn fpc_host_target_triple() -> &'static str {
    if cfg!(windows) {
        "x86_64-win64"
    } else if cfg!(target_os = "linux") {
        if cfg!(target_arch = "aarch64") {
            "aarch64-linux"
        } else {
            "x86_64-linux"
        }
    } else {
        "aarch64-darwin"
    }
}

pub fn find_fpc_units_dir(root: &Path, target_triple: &str) -> Option<PathBuf> {
    let direct = root.join("units").join(target_triple);
    if direct.is_dir() {
        return Some(direct);
    }
    let fpc_bases = [
        root.join("lib").join("fpc"),
        root.join("lib").join("x86_64-linux-gnu").join("fpc"),
        root.join("lib").join("aarch64-linux-gnu").join("fpc"),
    ];
    for base in &fpc_bases {
        if !base.is_dir() {
            continue;
        }
        let Ok(entries) = fs::read_dir(base) else {
            continue;
        };
        let mut ver_dirs: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
        ver_dirs.sort_by(|a, b| b.cmp(a));
        for ver_dir in ver_dirs {
            let candidate = ver_dir.join("units").join(target_triple);
            if candidate.is_dir() {
                return Some(candidate);
            }
        }
    }
    None
}

pub fn managed_cache_id(package_id: &str, version: &str) -> String {
    let clean_version: String = version
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' {
                c.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect();
    format!("{package_id}_{clean_version}")
}

static CACHE_IMPORT_LOCKS: std::sync::OnceLock<
    std::sync::Mutex<HashMap<String, std::sync::Arc<std::sync::Mutex<()>>>>,
> = std::sync::OnceLock::new();

fn cache_import_lock_for(key: &str) -> std::sync::Arc<std::sync::Mutex<()>> {
    let map = CACHE_IMPORT_LOCKS.get_or_init(|| std::sync::Mutex::new(HashMap::new()));
    let mut guard = map.lock().unwrap_or_else(|e| e.into_inner());
    guard
        .entry(key.to_string())
        .or_insert_with(|| std::sync::Arc::new(std::sync::Mutex::new(())))
        .clone()
}

pub fn ensure_cached_managed_toolchain(
    platform_root: &Path,
    source_package_root: &Path,
    receipt: &ToolchainPackageReceipt,
) -> Result<PathBuf, String> {
    let cache_id = managed_cache_id(&receipt.package_id, &receipt.version);
    let toolchains_cache_root = platform_root.join("toolchains");
    fs::create_dir_all(&toolchains_cache_root)
        .map_err(|e| format!("cannot create toolchains cache directory: {e}"))?;

    let dest_root = toolchains_cache_root.join(&cache_id);
    let lock = cache_import_lock_for(&dest_root.to_string_lossy());
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());

    let marker_file = dest_root.join(".judgedesk-import-complete");
    let expected_marker = format!(
        "4-receipt-digest\n{}\n{}\n{}\n",
        receipt.package_id, receipt.version, receipt.archive_sha256
    );

    if marker_file.is_file() {
        if let Ok(content) = fs::read_to_string(&marker_file) {
            if content == expected_marker {
                return Ok(dest_root);
            }
        }
    }

    let nonce = PREFS_WRITE_NONCE.fetch_add(1, Ordering::Relaxed);
    let staging_root = toolchains_cache_root.join(format!(
        "{}.staging.{}.{}",
        cache_id,
        std::process::id(),
        nonce
    ));
    let _ = fs::remove_dir_all(&staging_root);

    copy_dir_recursive(source_package_root, &staging_root)
        .map_err(|e| format!("failed to stage managed toolchain: {e}"))?;

    fs::write(
        staging_root.join(".judgedesk-import-complete"),
        expected_marker,
    )
    .map_err(|e| format!("failed to write import marker: {e}"))?;

    let _ = fs::remove_dir_all(&dest_root);
    fs::rename(&staging_root, &dest_root)
        .map_err(|e| format!("failed to commit imported toolchain: {e}"))?;

    Ok(dest_root)
}

const DEFAULT_SNAPSHOT_MAX_FILES: usize = 200_000;
const DEFAULT_SNAPSHOT_MAX_BYTES: u64 = 8 * 1024 * 1024 * 1024;
const LOCAL_SNAPSHOT_MARKER_NAME: &str = ".judgedesk-local-snapshot.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryTreeInspection {
    pub canonical_root: PathBuf,
    pub tree_digest: String,
    pub file_count: usize,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalSnapshotMarker {
    pub file_count: usize,
    pub kind: String,
    pub relative_executable_path: String,
    pub schema_version: u32,
    pub snapshot_digest: String,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalToolchainSnapshot {
    pub canonical_root: PathBuf,
    pub tree_digest: String,
    pub file_count: usize,
    pub total_bytes: u64,
    pub kind: String,
    pub root: PathBuf,
    pub payload_root: PathBuf,
    pub executable_path: PathBuf,
    pub relative_executable_path: String,
    pub created: bool,
}

pub(crate) fn sha256_bytes_hex(bytes: &[u8]) -> String {
    let digest = sha256_digest(bytes);
    let mut hex = String::with_capacity(64);
    for b in digest {
        use std::fmt::Write as _;
        let _ = write!(&mut hex, "{b:02x}");
    }
    hex
}

pub fn inspect_directory_tree(root: &Path) -> Result<DirectoryTreeInspection, String> {
    if !root.is_absolute() {
        return Err("Snapshot root must be absolute.".to_string());
    }
    let meta = fs::symlink_metadata(root)
        .map_err(|e| format!("Snapshot root cannot be inspected: {e}"))?;
    if !meta.is_dir() || meta.file_type().is_symlink() {
        return Err("Snapshot root must be a regular directory, not a link.".to_string());
    }
    let canonical_root = clean_canonical_path(root);

    enum TreeRecord {
        Dir {
            relative: String,
        },
        File {
            relative: String,
            size: u64,
            digest: String,
        },
    }

    let mut records = Vec::new();
    let mut pending = vec![(canonical_root.clone(), String::new())];
    let mut file_count = 0usize;
    let mut total_bytes = 0u64;

    while let Some((current_abs, current_rel)) = pending.pop() {
        let mut entries: Vec<_> = fs::read_dir(&current_abs)
            .map_err(|e| {
                format!(
                    "Failed to read snapshot directory {}: {e}",
                    current_abs.display()
                )
            })?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| {
                format!(
                    "Failed to read directory entry in {}: {e}",
                    current_abs.display()
                )
            })?;
        entries.sort_by_key(|e| e.file_name());

        let mut subdirs = Vec::new();
        for entry in entries {
            let name_os = entry.file_name();
            let Some(name) = name_os.to_str() else {
                return Err("Snapshot entry name is not valid UTF-8.".to_string());
            };
            let abs = current_abs.join(name);
            let rel = if current_rel.is_empty() {
                name.to_string()
            } else {
                format!("{current_rel}/{name}")
            };
            let entry_meta = fs::symlink_metadata(&abs)
                .map_err(|e| format!("Failed to stat snapshot entry {rel}: {e}"))?;
            if entry_meta.file_type().is_symlink() {
                return Err(format!(
                    "Snapshot source contains a symbolic link or junction: {rel}"
                ));
            }
            if entry_meta.is_dir() {
                records.push(TreeRecord::Dir {
                    relative: rel.clone(),
                });
                subdirs.push((abs, rel));
            } else if entry_meta.is_file() {
                file_count = file_count.saturating_add(1);
                if file_count > DEFAULT_SNAPSHOT_MAX_FILES {
                    return Err("Snapshot source exceeds the file-count limit.".to_string());
                }
                let size = entry_meta.len();
                total_bytes = total_bytes.saturating_add(size);
                if total_bytes > DEFAULT_SNAPSHOT_MAX_BYTES {
                    return Err("Snapshot source exceeds the byte limit.".to_string());
                }
                let digest = compute_binary_sha256_hex(&abs)?;
                let after_meta = fs::symlink_metadata(&abs)
                    .map_err(|e| format!("Failed to re-stat snapshot entry {rel}: {e}"))?;
                if after_meta.len() != size {
                    return Err(format!(
                        "TOOLCHAIN_DRIFTED: snapshot source changed while hashing '{}'.",
                        abs.display()
                    ));
                }
                records.push(TreeRecord::File {
                    relative: rel,
                    size,
                    digest,
                });
            } else {
                return Err(format!(
                    "Snapshot source contains an unsupported entry: {rel}"
                ));
            }
        }
        for subdir in subdirs.into_iter().rev() {
            pending.push(subdir);
        }
    }

    let mut tree_buf = Vec::new();
    tree_buf.extend_from_slice(b"judgedesk-local-snapshot-tree-v1\0");
    for rec in &records {
        match rec {
            TreeRecord::Dir { relative } => {
                tree_buf.extend_from_slice(b"D\0");
                tree_buf.extend_from_slice(relative.as_bytes());
                tree_buf.extend_from_slice(b"\0");
            }
            TreeRecord::File {
                relative,
                size,
                digest,
            } => {
                tree_buf.extend_from_slice(b"F\0");
                tree_buf.extend_from_slice(relative.as_bytes());
                tree_buf.extend_from_slice(b"\0");
                tree_buf.extend_from_slice(size.to_string().as_bytes());
                tree_buf.extend_from_slice(b"\0");
                tree_buf.extend_from_slice(digest.as_bytes());
                tree_buf.extend_from_slice(b"\0");
            }
        }
    }

    Ok(DirectoryTreeInspection {
        canonical_root,
        tree_digest: sha256_bytes_hex(&tree_buf),
        file_count,
        total_bytes,
    })
}

pub fn create_local_toolchain_snapshot(
    cache_base_dir: &Path,
    kind: &str,
    source_root: &Path,
    executable_path: &Path,
) -> Result<LocalToolchainSnapshot, String> {
    let before = inspect_directory_tree(source_root)?;
    let canon_exe = clean_canonical_path(executable_path);
    let rel_exe_path = canon_exe
        .strip_prefix(&before.canonical_root)
        .map_err(|_| "Snapshot executable is outside the selected toolchain root.".to_string())?;
    let rel_exe_str = rel_exe_path.to_string_lossy().replace('\\', "/");
    if rel_exe_str.is_empty() || rel_exe_str.starts_with('/') || rel_exe_str.contains("..") {
        return Err("Snapshot executable path is not a normalized relative path.".to_string());
    }

    let toolchains_root = cache_base_dir.join("toolchains");
    fs::create_dir_all(&toolchains_root)
        .map_err(|e| format!("Failed to create toolchains snapshot directory: {e}"))?;

    let snapshot_dir_name = format!("local_{kind}_{}", before.tree_digest);
    let snapshot_root = toolchains_root.join(&snapshot_dir_name);

    let marker_file = snapshot_root.join(LOCAL_SNAPSHOT_MARKER_NAME);
    if marker_file.is_file() {
        if let Ok(existing) =
            verify_local_toolchain_snapshot(cache_base_dir, kind, &before.tree_digest)
        {
            if existing.relative_executable_path == rel_exe_str {
                return Ok(LocalToolchainSnapshot {
                    created: false,
                    ..existing
                });
            }
        }
    }

    let nonce = PREFS_WRITE_NONCE.fetch_add(1, Ordering::Relaxed);
    let staging = toolchains_root.join(format!(
        ".local_{kind}_pending.{}.{nonce}.staging",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&staging);
    let payload_staging = staging.join("payload");
    if let Err(e) = copy_dir_recursive(&before.canonical_root, &payload_staging) {
        let _ = fs::remove_dir_all(&staging);
        return Err(format!(
            "Failed to copy local toolchain into snapshot staging: {e}"
        ));
    }

    let copied = match inspect_directory_tree(&payload_staging) {
        Ok(c) => c,
        Err(e) => {
            let _ = fs::remove_dir_all(&staging);
            return Err(e);
        }
    };
    if copied.tree_digest != before.tree_digest
        || copied.file_count != before.file_count
        || copied.total_bytes != before.total_bytes
    {
        let _ = fs::remove_dir_all(&staging);
        return Err("TOOLCHAIN_DRIFTED: snapshot source changed while it was copied.".to_string());
    }

    let marker = LocalSnapshotMarker {
        file_count: copied.file_count,
        kind: kind.to_string(),
        relative_executable_path: rel_exe_str.clone(),
        schema_version: 1,
        snapshot_digest: copied.tree_digest.clone(),
        total_bytes: copied.total_bytes,
    };
    let mut marker_json =
        serde_json::to_string(&marker).map_err(|e| format!("Marker serialize error: {e}"))?;
    marker_json.push('\n');

    if let Err(e) = fs::write(
        staging.join(LOCAL_SNAPSHOT_MARKER_NAME),
        marker_json.as_bytes(),
    ) {
        let _ = fs::remove_dir_all(&staging);
        return Err(format!("Failed to write snapshot marker: {e}"));
    }

    let _ = fs::remove_dir_all(&snapshot_root);
    if let Err(e) = fs::rename(&staging, &snapshot_root) {
        let _ = fs::remove_dir_all(&staging);
        return Err(format!("Failed to commit local toolchain snapshot: {e}"));
    }

    let final_payload = clean_canonical_path(&snapshot_root.join("payload"));
    let final_exe = clean_canonical_path(&final_payload.join(&rel_exe_str));

    Ok(LocalToolchainSnapshot {
        canonical_root: final_payload.clone(),
        tree_digest: copied.tree_digest,
        file_count: copied.file_count,
        total_bytes: copied.total_bytes,
        kind: kind.to_string(),
        root: snapshot_root,
        payload_root: final_payload,
        executable_path: final_exe,
        relative_executable_path: rel_exe_str,
        created: true,
    })
}

pub fn verify_local_toolchain_snapshot(
    cache_base_dir: &Path,
    kind: &str,
    snapshot_digest: &str,
) -> Result<LocalToolchainSnapshot, String> {
    let normalized_digest: String = snapshot_digest
        .trim()
        .chars()
        .filter(|c| c.is_ascii_hexdigit())
        .map(|c| c.to_ascii_lowercase())
        .collect();
    if normalized_digest.len() != 64 {
        return Err("CERTIFICATE_STALE: invalid snapshot digest format.".to_string());
    }

    let snapshot_root = cache_base_dir
        .join("toolchains")
        .join(format!("local_{kind}_{normalized_digest}"));
    let marker_path = snapshot_root.join(LOCAL_SNAPSHOT_MARKER_NAME);
    let marker_raw = fs::read_to_string(&marker_path).map_err(|_| {
        "CERTIFICATE_STALE: local toolchain snapshot marker is missing or invalid.".to_string()
    })?;
    let marker: LocalSnapshotMarker = serde_json::from_str(&marker_raw).map_err(|_| {
        "CERTIFICATE_STALE: local toolchain snapshot marker is missing or invalid.".to_string()
    })?;
    if marker.schema_version != 1
        || marker.kind != kind
        || marker.snapshot_digest != normalized_digest
    {
        return Err(
            "CERTIFICATE_STALE: local toolchain snapshot marker is missing or invalid.".to_string(),
        );
    }

    let payload_root = snapshot_root.join("payload");
    let inspection = inspect_directory_tree(&payload_root)?;
    if inspection.tree_digest != marker.snapshot_digest
        || inspection.file_count != marker.file_count
        || inspection.total_bytes != marker.total_bytes
    {
        return Err("TOOLCHAIN_DRIFTED: local toolchain snapshot content changed.".to_string());
    }

    let exe_path = payload_root.join(&marker.relative_executable_path);
    if !exe_path.is_file() {
        return Err(
            "CERTIFICATE_STALE: snapshot executable does not resolve inside its payload root."
                .to_string(),
        );
    }
    let canon_payload = clean_canonical_path(&payload_root);
    let canon_exe = clean_canonical_path(&exe_path);
    if !canon_exe.starts_with(&canon_payload) {
        return Err("CERTIFICATE_STALE: snapshot executable escaped its payload root.".to_string());
    }

    Ok(LocalToolchainSnapshot {
        canonical_root: canon_payload.clone(),
        tree_digest: inspection.tree_digest,
        file_count: inspection.file_count,
        total_bytes: inspection.total_bytes,
        kind: kind.to_string(),
        root: snapshot_root,
        payload_root: canon_payload,
        executable_path: canon_exe,
        relative_executable_path: marker.relative_executable_path,
        created: false,
    })
}

#[cfg(test)]
mod tests {
    use super::{preserve_bundled_toolchains_in, read_package_receipt};
    use std::fs;

    #[test]
    fn preserve_bundled_toolchains_copies_valid_packages_to_app_data() {
        let temp_root = std::env::temp_dir().join(format!(
            "judgedesk-preserve-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let _ = fs::remove_dir_all(&temp_root);
        fs::create_dir_all(&temp_root).unwrap();
        fs::write(temp_root.join(".judgedesk-test-root"), b"1\n").unwrap();

        let resource_dir = temp_root.join("resources");
        let bundled_pkg = resource_dir.join("toolchains").join("python-test-pkg");
        fs::create_dir_all(bundled_pkg.join("bin")).unwrap();
        fs::write(bundled_pkg.join("bin").join("python3"), b"#!/bin/sh\n").unwrap();
        let receipt_json = serde_json::json!({
            "schemaVersion": 1,
            "packageId": "python-test-pkg",
            "version": "3.12.0",
            "archiveSha256": "a".repeat(64),
            "entrypointComponentId": "entrypoint",
            "components": [
                {
                    "id": "entrypoint",
                    "kind": "executable",
                    "relativePath": "bin/python3",
                    "roles": ["submission-runtime"]
                }
            ]
        });
        fs::write(
            bundled_pkg.join(".judgedesk-package.json"),
            serde_json::to_string_pretty(&receipt_json).unwrap(),
        )
        .unwrap();

        let app_data_dir = temp_root.join("app-data");
        fs::create_dir_all(&app_data_dir).unwrap();

        let prev_res = std::env::var_os("THEMIS_RESOURCE_DIR");
        std::env::set_var("THEMIS_RESOURCE_DIR", &resource_dir);

        let preserved_first = preserve_bundled_toolchains_in(&app_data_dir).unwrap();
        assert_eq!(preserved_first, 1);

        let preserved_pkg = app_data_dir.join("toolchains").join("python-test-pkg");
        assert!(read_package_receipt(&preserved_pkg).is_some());
        assert!(preserved_pkg.join("bin").join("python3").is_file());

        // Idempotent second call when destination already has a valid receipt
        let preserved_second = preserve_bundled_toolchains_in(&app_data_dir).unwrap();
        assert_eq!(preserved_second, 0);

        match prev_res {
            Some(val) => std::env::set_var("THEMIS_RESOURCE_DIR", val),
            None => std::env::remove_var("THEMIS_RESOURCE_DIR"),
        }
        let _ = fs::remove_dir_all(&temp_root);
    }
}
