use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

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
    pub mode: String, // "managed", "local_path", "local_auto", "system"
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
    pub source_mode: String, // "managed", "local_path", "system"
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
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home).join(".themisv2-dev");
        }
        PathBuf::from(".themisv2-dev")
    }
}

pub fn get_managed_toolchains_dir() -> PathBuf {
    get_app_data_dir().join("toolchains")
}

pub fn get_preferences_file_path() -> PathBuf {
    get_app_data_dir().join("toolchains.json")
}

pub fn load_persisted_preferences() -> Option<ToolchainPreferencesDoc> {
    let path = get_preferences_file_path();
    if path.is_file() {
        if let Ok(content) = fs::read_to_string(&path) {
            if let Ok(doc) = serde_json::from_str::<ToolchainPreferencesDoc>(&content) {
                return Some(doc);
            }
        }
    }
    None
}

pub fn read_package_receipt(package_root: &Path) -> Option<ToolchainPackageReceipt> {
    let receipt_path = package_root.join(".judgedesk-package.json");
    if receipt_path.is_file() {
        if let Ok(content) = fs::read_to_string(&receipt_path) {
            if let Ok(receipt) = serde_json::from_str::<ToolchainPackageReceipt>(&content) {
                return Some(receipt);
            }
        }
    }
    None
}

fn managed_package_name_for(kind: &str) -> &'static str {
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
        "python" => "python-linux-x64",
        _ => "gcc-linux-x64",
    }
}

pub fn find_managed_toolchain(kind: &str) -> Option<ResolvedToolchain> {
    let toolchains_dir = get_managed_toolchains_dir();
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

pub fn query_executable_version(exe_path: &Path, kind: &str) -> String {
    let arg = match kind {
        "pascal" => "-iV",
        "java" => "--version",
        "scratch" => "--version",
        _ => "--version",
    };

    let mut cmd = std::process::Command::new(exe_path);
    cmd.arg(arg);

    if let Ok(output) = cmd.output() {
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
            // Look for version numbers in first meaningful line
            for word in trimmed.split_whitespace() {
                let clean = word.trim_matches(|c: char| !c.is_ascii_digit() && c != '.');
                if clean.chars().filter(|&c| c == '.').count() >= 1
                    && clean.chars().next().is_some_and(|c| c.is_ascii_digit())
                {
                    return clean.to_string();
                }
            }
        }
    }
    "unknown".to_string()
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
            #[cfg(not(windows))]
            {
                &["g++", "clang++", "/usr/bin/g++", "/usr/local/bin/g++"]
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
            #[cfg(not(windows))]
            {
                &["gcc", "clang", "/usr/bin/gcc", "/usr/local/bin/gcc"]
            }
        }
        "python" => {
            #[cfg(windows)]
            {
                &["python.exe", "python3.exe", r"C:\Themis\Python\python.exe"]
            }
            #[cfg(not(windows))]
            {
                &[
                    "python3",
                    "python",
                    "/usr/bin/python3",
                    "/usr/local/bin/python3",
                ]
            }
        }
        "pascal" => {
            #[cfg(windows)]
            {
                &[
                    "fpc.exe",
                    r"C:\FPC\3.2.2\bin\i386-win32\fpc.exe",
                    r"C:\Themis\FPC\bin\i386-win32\fpc.exe",
                ]
            }
            #[cfg(not(windows))]
            {
                &["fpc", "/usr/bin/fpc", "/usr/local/bin/fpc"]
            }
        }
        "java" => {
            #[cfg(windows)]
            {
                &[
                    "javac.exe",
                    r"C:\Program Files\Eclipse Adoptium\jdk-21\bin\javac.exe",
                ]
            }
            #[cfg(not(windows))]
            {
                &["javac", "/usr/bin/javac"]
            }
        }
        "scratch" => {
            #[cfg(windows)]
            {
                &["scratch-run.exe"]
            }
            #[cfg(not(windows))]
            {
                &["scratch-run"]
            }
        }
        _ => &[],
    };

    for candidate in candidates {
        let p = Path::new(candidate);
        if p.is_absolute() && p.is_file() {
            return Some(p.to_path_buf());
        }
        // Search on PATH
        #[cfg(windows)]
        {
            if let Ok(output) = std::process::Command::new("where.exe")
                .arg(candidate)
                .output()
            {
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

pub fn resolve_toolchain_for_profile(
    profile_id: &str,
    preference_mode: Option<&str>,
    preference_local_path: Option<&str>,
) -> ResolvedToolchain {
    let kind = normalize_language_kind(profile_id);

    // 1. Check preference passed or loaded from toolchains.json
    let (mode, local_path) = match (preference_mode, preference_local_path) {
        (Some(m), p) => (m.to_string(), p.map(String::from)),
        (None, _) => {
            let doc = load_persisted_preferences();
            let entry = doc.as_ref().and_then(|d| {
                d.profiles.get(profile_id).or_else(|| {
                    // Try by kind
                    d.profiles
                        .iter()
                        .find(|(k, _)| normalize_language_kind(k) == kind)
                        .map(|(_, v)| v)
                })
            });
            match entry {
                Some(e) => (e.mode.clone(), e.local_path.clone()),
                None => ("managed".to_string(), None),
            }
        }
    };

    // 2. If mode is local_path:
    if mode == "local_path" {
        if let Some(ref path_str) = local_path {
            let p = PathBuf::from(path_str);
            if p.is_file() {
                let ver = query_executable_version(&p, kind);
                return ResolvedToolchain {
                    kind: kind.to_string(),
                    profile_id: profile_id.to_string(),
                    source_mode: "local_path".to_string(),
                    version: ver,
                    executable_path: p,
                    runtime_executable_path: None,
                    package_root: None,
                    package_id: None,
                    package_digest: None,
                    ready: true,
                    diagnostic: None,
                };
            }
        }
    }

    // 3. If mode is managed or fallback:
    if mode == "managed" || mode == "local_auto" {
        if let Some(managed) = find_managed_toolchain(kind) {
            return ResolvedToolchain {
                profile_id: profile_id.to_string(),
                ..managed
            };
        }
    }

    // 4. If mode is system or managed not found: try system executable
    if let Some(sys_exe) = find_system_executable(kind) {
        let ver = query_executable_version(&sys_exe, kind);
        return ResolvedToolchain {
            kind: kind.to_string(),
            profile_id: profile_id.to_string(),
            source_mode: "system".to_string(),
            version: ver,
            executable_path: sys_exe,
            runtime_executable_path: None,
            package_root: None,
            package_id: None,
            package_digest: None,
            ready: true,
            diagnostic: None,
        };
    }

    // 5. Not found
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
            "No functional compiler or runtime discovered for {kind}."
        )),
    }
}

pub fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let dest_path = dst.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive(&entry.path(), &dest_path)?;
        } else {
            fs::copy(entry.path(), dest_path)?;
        }
    }
    Ok(())
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

    let staging_root =
        toolchains_cache_root.join(format!("{}.staging.{}", cache_id, std::process::id()));
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
