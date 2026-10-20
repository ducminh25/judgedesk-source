use crate::discovery::compile_config::ProblemCompileConfig;
use crate::engine::compiler::compile_cpp_pch_in_sandbox;
use crate::executor_client::ExecutorClient;
use crate::storage::{is_symlink_or_reparse_point, OwnedWorkspace};
use crate::toolchains::discovery::{
    clean_canonical_path, compute_binary_sha256_hex, get_app_data_dir, query_executable_version,
    sha256_bytes_hex, ResolvedToolchain,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Instant, UNIX_EPOCH};

static PCH_TMP_NONCE: AtomicU64 = AtomicU64::new(1);
static PCH_SINGLE_FLIGHT_LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();

fn single_flight_lock_for(cache_key: &str) -> Arc<Mutex<()>> {
    let map_mutex = PCH_SINGLE_FLIGHT_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = map_mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    guard
        .entry(cache_key.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkStats {
    pub warmup_count: usize,
    pub trial_count: usize,
    pub samples_ms: Vec<f64>,
    pub p50_ms: f64,
    pub p90_ms: f64,
    pub p95_ms: f64,
    pub min_ms: f64,
    pub max_ms: f64,
    pub mean_ms: f64,
    pub failure_count: usize,
}

impl BenchmarkStats {
    pub fn from_samples(
        warmup_count: usize,
        samples_ms: &[f64],
        failure_count: usize,
    ) -> Result<Self, String> {
        if warmup_count < 3 {
            return Err(format!(
                "Benchmark requires at least 3 warmups (got {warmup_count})"
            ));
        }
        if samples_ms.len() < 20 {
            return Err(format!(
                "Benchmark requires at least 20 measurement trials (got {})",
                samples_ms.len()
            ));
        }
        let mut sorted: Vec<f64> = samples_ms
            .iter()
            .copied()
            .filter(|v| v.is_finite() && *v >= 0.0)
            .collect();
        if sorted.len() < 20 {
            return Err("Benchmark samples contained non-finite or negative latencies".to_string());
        }
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

        let n = sorted.len();
        let min_ms = sorted[0];
        let max_ms = sorted[n - 1];
        let sum: f64 = sorted.iter().sum();
        let mean_ms = sum / (n as f64);

        let percentile = |p: f64| -> f64 {
            let rank = ((p / 100.0) * (n as f64)).ceil() as usize;
            let idx = rank.saturating_sub(1).min(n - 1);
            sorted[idx]
        };

        Ok(Self {
            warmup_count,
            trial_count: n,
            samples_ms: samples_ms.to_vec(),
            p50_ms: percentile(50.0),
            p90_ms: percentile(90.0),
            p95_ms: percentile(95.0),
            min_ms,
            max_ms,
            mean_ms,
            failure_count,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PchCacheIdentity {
    pub compiler_path: String,
    pub compiler_size: u64,
    pub compiler_mtime_ms: u64,
    pub compiler_version: String,
    pub target_platform: String,
    pub target_arch: String,
    pub compiler_flags: Vec<String>,
    pub header_sha256: String,
    pub toolchain_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PchMetadata {
    pub schema_version: u32,
    pub cache_key: String,
    pub identity: PchCacheIdentity,
    pub pch_size_bytes: u64,
    pub pch_sample_fingerprint: String,
    pub compile_duration_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PchEnsureOutcome {
    pub pch_dir: PathBuf,
    pub cache_key: String,
    pub identity: PchCacheIdentity,
    pub generated: bool,
}

pub fn host_target_platform() -> &'static str {
    if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    }
}

pub fn host_target_arch() -> &'static str {
    if cfg!(target_arch = "x86_64") {
        "x64"
    } else if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        std::env::consts::ARCH
    }
}

pub fn compute_pch_cache_key(identity: &PchCacheIdentity) -> String {
    let normalized_path = if identity.target_platform == "win32" {
        identity.compiler_path.to_ascii_lowercase()
    } else {
        identity.compiler_path.clone()
    };
    let flags_json =
        serde_json::to_string(&identity.compiler_flags).unwrap_or_else(|_| "[]".to_string());
    let payload = [
        "cpp-pch-v2",
        normalized_path.as_str(),
        &identity.compiler_size.to_string(),
        &identity.compiler_mtime_ms.to_string(),
        identity.compiler_version.as_str(),
        identity.target_platform.as_str(),
        identity.target_arch.as_str(),
        flags_json.as_str(),
        identity.header_sha256.as_str(),
        identity.toolchain_digest.as_str(),
    ]
    .join(":");
    let digest = sha256_bytes_hex(payload.as_bytes());
    digest[..16].to_string()
}

pub fn extract_pch_compiler_flags(args: &[String]) -> Option<Vec<String>> {
    if args.iter().any(|arg| {
        arg.starts_with("-I")
            || arg.starts_with("-isystem")
            || arg.starts_with("-iquote")
            || arg.starts_with("-idirafter")
            || arg.starts_with("-include")
            || arg.starts_with("-imacros")
    }) {
        return None;
    }
    let mut flags = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        if arg == "-x" || arg == "-o" {
            i += 2;
            continue;
        }
        if arg == "-D" || arg == "-U" {
            flags.push(arg.clone());
            if i + 1 < args.len() {
                flags.push(args[i + 1].clone());
                i += 2;
            } else {
                i += 1;
            }
            continue;
        }
        if !arg.starts_with('-') {
            i += 1;
            continue;
        }
        if arg == "-c"
            || arg == "-s"
            || arg == "-static"
            || arg == "-lm"
            || arg.starts_with("-Wl,")
            || (cfg!(target_os = "macos")
                && (arg == "-fsanitize=integer-divide-by-zero"
                    || arg == "-fsanitize-trap=integer-divide-by-zero"))
        {
            i += 1;
            continue;
        }
        flags.push(arg.clone());
        i += 1;
    }
    if flags.is_empty() {
        let default_cfg = ProblemCompileConfig::default();
        return Some(default_cfg.flags_for_language("cpp").to_vec());
    }
    Some(flags)
}

fn check_candidate_version_dir_for_bits(candidate_dir: &Path) -> Option<PathBuf> {
    if !candidate_dir.is_dir() {
        return None;
    }
    let direct_bits = candidate_dir.join("bits").join("stdc++.h");
    if direct_bits.is_file() {
        return Some(direct_bits);
    }
    for triple in [
        "x86_64-w64-mingw32",
        "x86_64-linux-gnu",
        "aarch64-linux-gnu",
        "x86_64-pc-linux-gnu",
        "aarch64-unknown-linux-gnu",
    ] {
        let arch_bits = candidate_dir.join(triple).join("bits").join("stdc++.h");
        if arch_bits.is_file() {
            return Some(arch_bits);
        }
    }
    let nested_cxx = candidate_dir.join("include").join("c++");
    if nested_cxx.is_dir() {
        if let Some(found) = find_stdcxx_bits_in_root(candidate_dir, None) {
            return Some(found);
        }
    }
    if let Ok(sub_entries) = fs::read_dir(candidate_dir) {
        let mut sub_paths: Vec<PathBuf> = sub_entries.flatten().map(|e| e.path()).collect();
        sub_paths.sort_by(|a, b| b.cmp(a));
        for sub_path in sub_paths {
            if sub_path.is_dir() {
                let sub_bits = sub_path
                    .join("include")
                    .join("c++")
                    .join("bits")
                    .join("stdc++.h");
                if sub_bits.is_file() {
                    return Some(sub_bits);
                }
                if let Some(found) = find_stdcxx_bits_in_root(&sub_path, None) {
                    return Some(found);
                }
            }
        }
    }
    None
}

fn find_stdcxx_bits_in_root(
    toolchain_root: &Path,
    preferred_version: Option<&str>,
) -> Option<PathBuf> {
    let search_bases = [
        toolchain_root
            .join("include")
            .join("x86_64-linux-gnu")
            .join("c++"),
        toolchain_root
            .join("include")
            .join("aarch64-linux-gnu")
            .join("c++"),
        toolchain_root.join("include").join("c++"),
        toolchain_root
            .join("x86_64-w64-mingw32")
            .join("include")
            .join("c++"),
        toolchain_root
            .join("x86_64-linux-gnu")
            .join("include")
            .join("c++"),
        toolchain_root
            .join("aarch64-linux-gnu")
            .join("include")
            .join("c++"),
        toolchain_root.join("lib").join("gcc"),
    ];

    let major_ver = preferred_version
        .and_then(|v| v.split('.').next())
        .filter(|m| !m.is_empty() && m.chars().all(|c| c.is_ascii_digit()));

    for base in &search_bases {
        if !base.is_dir() {
            continue;
        }
        if let Some(ver) = preferred_version.filter(|v| !v.is_empty() && *v != "unknown") {
            if let Some(found) = check_candidate_version_dir_for_bits(&base.join(ver)) {
                return Some(found);
            }
        }
        if let Some(major) = major_ver {
            if Some(major) != preferred_version {
                if let Some(found) = check_candidate_version_dir_for_bits(&base.join(major)) {
                    return Some(found);
                }
            }
        }
        let Ok(entries) = fs::read_dir(base) else {
            continue;
        };
        let mut candidate_dirs: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
        candidate_dirs.sort_by(|a, b| b.cmp(a));
        for candidate_dir in candidate_dirs {
            if let Some(found) = check_candidate_version_dir_for_bits(&candidate_dir) {
                return Some(found);
            }
        }
    }
    None
}

pub fn find_bundled_compat_stdcxx_header() -> Option<PathBuf> {
    if let Ok(res_dir) = std::env::var("THEMIS_RESOURCE_DIR") {
        let candidate = Path::new(&res_dir)
            .join("compiler-compat")
            .join("include")
            .join("bits")
            .join("stdc++.h");
        if candidate.is_file() {
            return Some(clean_canonical_path(&candidate));
        }
    }
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            let direct = exe_dir
                .join("compiler-compat")
                .join("include")
                .join("bits")
                .join("stdc++.h");
            if direct.is_file() {
                return Some(clean_canonical_path(&direct));
            }
            if let Some(contents_dir) = exe_dir.parent() {
                let macos_resources = contents_dir
                    .join("Resources")
                    .join("compiler-compat")
                    .join("include")
                    .join("bits")
                    .join("stdc++.h");
                if macos_resources.is_file() {
                    return Some(clean_canonical_path(&macos_resources));
                }
                for rel in [
                    Path::new("lib").join("JudgeDesk"),
                    Path::new("lib").join("judgedesk"),
                    Path::new("lib").join("themis-v2"),
                    Path::new("share").join("JudgeDesk"),
                    Path::new("share").join("judgedesk"),
                ] {
                    let linux_res = contents_dir
                        .join(rel)
                        .join("compiler-compat")
                        .join("include")
                        .join("bits")
                        .join("stdc++.h");
                    if linux_res.is_file() {
                        return Some(clean_canonical_path(&linux_res));
                    }
                }
            }
        }
    }
    #[cfg(target_os = "linux")]
    for sys_res in [
        "/usr/lib/JudgeDesk/compiler-compat/include/bits/stdc++.h",
        "/usr/lib/judgedesk/compiler-compat/include/bits/stdc++.h",
        "/usr/lib/themis-v2/compiler-compat/include/bits/stdc++.h",
        "/usr/share/JudgeDesk/compiler-compat/include/bits/stdc++.h",
        "/usr/share/judgedesk/compiler-compat/include/bits/stdc++.h",
    ] {
        let candidate = Path::new(sys_res);
        if candidate.is_file() {
            return Some(clean_canonical_path(candidate));
        }
    }
    let manifest_compat = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("compiler-compat")
        .join("include")
        .join("bits")
        .join("stdc++.h");
    if manifest_compat.is_file() {
        return Some(clean_canonical_path(&manifest_compat));
    }
    None
}

pub fn find_stdcxx_header_for_toolchain(toolchain: &ResolvedToolchain) -> Option<PathBuf> {
    if toolchain.kind != "cpp" || !toolchain.executable_path.is_file() {
        return None;
    }
    if !cfg!(target_os = "macos") {
        let mut candidate_roots = Vec::new();
        if let Some(ref root) = toolchain.package_root {
            candidate_roots.push(clean_canonical_path(root));
        }
        let exe_canon = clean_canonical_path(&toolchain.executable_path);
        if let Some(bin_dir) = exe_canon.parent() {
            candidate_roots.push(bin_dir.to_path_buf());
            if let Some(parent_root) = bin_dir.parent() {
                candidate_roots.push(parent_root.to_path_buf());
            }
        }
        let preferred_ver = (!toolchain.version.is_empty() && toolchain.version != "unknown")
            .then_some(toolchain.version.as_str());
        for root in candidate_roots {
            if let Some(header) = find_stdcxx_bits_in_root(&root, preferred_ver) {
                return Some(clean_canonical_path(&header));
            }
        }
    }
    find_bundled_compat_stdcxx_header()
}

pub fn build_pch_cache_identity(
    toolchain: &ResolvedToolchain,
    source_header_path: &Path,
    compiler_flags: &[String],
) -> Result<PchCacheIdentity, String> {
    if toolchain.kind != "cpp" || !toolchain.executable_path.is_file() {
        return Err("C++ toolchain executable is not available for PCH".to_string());
    }
    let canon_exe = clean_canonical_path(&toolchain.executable_path);
    let exe_meta = fs::metadata(&canon_exe).map_err(|e| {
        format!(
            "Failed to stat C++ compiler executable {}: {e}",
            canon_exe.display()
        )
    })?;
    let mtime_ms = exe_meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let version = if !toolchain.version.is_empty() && toolchain.version != "unknown" {
        toolchain.version.clone()
    } else {
        query_executable_version(&canon_exe, "cpp")
    };
    let header_sha256 = compute_binary_sha256_hex(source_header_path)?;
    let toolchain_digest = toolchain.package_digest.clone().unwrap_or_default();

    Ok(PchCacheIdentity {
        compiler_path: canon_exe.to_string_lossy().into_owned(),
        compiler_size: exe_meta.len(),
        compiler_mtime_ms: mtime_ms,
        compiler_version: version,
        target_platform: host_target_platform().to_string(),
        target_arch: host_target_arch().to_string(),
        compiler_flags: compiler_flags.to_vec(),
        header_sha256,
        toolchain_digest,
    })
}

fn compute_pch_sample_fingerprint(gch_path: &Path) -> Option<(u64, String)> {
    let meta = fs::symlink_metadata(gch_path).ok()?;
    if !meta.is_file() || is_symlink_or_reparse_point(&meta) {
        return None;
    }
    let len = meta.len();
    if !(1025..=512 * 1024 * 1024).contains(&len) {
        return None;
    }

    let mut file = fs::File::open(gch_path).ok()?;
    let mut head = [0u8; 4096];
    let head_n = file.read(&mut head).ok()?;
    if head_n < 4 {
        return None;
    }
    // GCC PCH starts with "gpch", Clang PCH starts with "CPCH"
    let magic = &head[..4];
    if magic != b"gpch" && magic != b"CPCH" {
        return None;
    }

    let mut sample = Vec::with_capacity(12 * 1024 + 16);
    sample.extend_from_slice(&len.to_le_bytes());
    sample.extend_from_slice(&head[..head_n]);

    if len > 4096 {
        let mid_off = len / 2;
        if file.seek(SeekFrom::Start(mid_off)).is_ok() {
            let mut mid = [0u8; 4096];
            if let Ok(mid_n) = file.read(&mut mid) {
                sample.extend_from_slice(&mid[..mid_n]);
            }
        }
        let tail_off = len.saturating_sub(4096);
        if file.seek(SeekFrom::Start(tail_off)).is_ok() {
            let mut tail = [0u8; 4096];
            if let Ok(tail_n) = file.read(&mut tail) {
                sample.extend_from_slice(&tail[..tail_n]);
            }
        }
    }

    Some((len, sha256_bytes_hex(&sample)))
}

pub fn is_valid_pch_cache_dir(pch_dir: &Path, expected_identity: &PchCacheIdentity) -> bool {
    let bits_dir = pch_dir.join("bits");
    for dir in [pch_dir, bits_dir.as_path()] {
        let Ok(meta) = fs::symlink_metadata(dir) else {
            return false;
        };
        if !meta.is_dir() || is_symlink_or_reparse_point(&meta) {
            return false;
        }
    }

    let header_path = bits_dir.join("stdc++.h");
    let gch_path = bits_dir.join("stdc++.h.gch");
    let metadata_path = pch_dir.join("metadata.json");

    for file in [&header_path, &gch_path, &metadata_path] {
        let Ok(meta) = fs::symlink_metadata(file) else {
            return false;
        };
        if !meta.is_file() || is_symlink_or_reparse_point(&meta) || meta.len() == 0 {
            return false;
        }
    }

    let Ok(meta_raw) = fs::read_to_string(&metadata_path) else {
        return false;
    };
    let Ok(metadata) = serde_json::from_str::<PchMetadata>(&meta_raw) else {
        return false;
    };
    if metadata.schema_version != 2 || &metadata.identity != expected_identity {
        return false;
    }

    let Ok(actual_header_sha) = compute_binary_sha256_hex(&header_path) else {
        return false;
    };
    if actual_header_sha != expected_identity.header_sha256 {
        return false;
    }

    let Some((actual_size, actual_sample_fp)) = compute_pch_sample_fingerprint(&gch_path) else {
        return false;
    };
    if actual_size != metadata.pch_size_bytes || actual_sample_fp != metadata.pch_sample_fingerprint
    {
        return false;
    }

    true
}

pub fn invalidate_pch_cache_dir(pch_dir: &Path) {
    if let Ok(meta) = fs::symlink_metadata(pch_dir) {
        if meta.is_dir() && !is_symlink_or_reparse_point(&meta) {
            let _ = fs::remove_dir_all(pch_dir);
        }
    }
}

pub fn get_pch_directory_for_toolchain(
    toolchain: &ResolvedToolchain,
    compiler_flags: &[String],
) -> Option<PathBuf> {
    get_pch_directory_for_toolchain_in(None, toolchain, compiler_flags)
}

pub fn get_pch_directory_for_toolchain_in(
    app_data_dir: Option<&Path>,
    toolchain: &ResolvedToolchain,
    compiler_flags: &[String],
) -> Option<PathBuf> {
    if std::env::var_os("JUDGEDESK_DISABLE_PCH").is_some() {
        return None;
    }
    let source_header = find_stdcxx_header_for_toolchain(toolchain)?;
    let identity = build_pch_cache_identity(toolchain, &source_header, compiler_flags).ok()?;
    let cache_key = compute_pch_cache_key(&identity);
    let base_app_data = app_data_dir
        .map(Path::to_path_buf)
        .unwrap_or_else(get_app_data_dir);
    let pch_dir = base_app_data.join("pch-cache").join(&cache_key);
    if is_valid_pch_cache_dir(&pch_dir, &identity) {
        Some(pch_dir)
    } else {
        if pch_dir.exists() {
            let key_lock = single_flight_lock_for(&cache_key);
            let _guard = key_lock
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if !is_valid_pch_cache_dir(&pch_dir, &identity) && pch_dir.exists() {
                invalidate_pch_cache_dir(&pch_dir);
            }
        }
        None
    }
}

pub fn stage_cpp_pch_into_workspace(
    workspace: &OwnedWorkspace,
    toolchain: &ResolvedToolchain,
    compiler_flags: &[String],
) -> Option<PathBuf> {
    stage_cpp_pch_into_workspace_in(None, workspace, toolchain, compiler_flags)
}

pub fn stage_cpp_pch_into_workspace_in(
    app_data_dir: Option<&Path>,
    workspace: &OwnedWorkspace,
    toolchain: &ResolvedToolchain,
    compiler_flags: &[String],
) -> Option<PathBuf> {
    let pch_dir = get_pch_directory_for_toolchain_in(app_data_dir, toolchain, compiler_flags)?;
    let src_header = pch_dir.join("bits").join("stdc++.h");
    let src_gch = pch_dir.join("bits").join("stdc++.h.gch");

    let header_bytes = fs::read(&src_header).ok()?;
    workspace
        .write_file(Path::new("compiler-pch/bits/stdc++.h"), &header_bytes)
        .ok()?;

    let dst_gch = workspace
        .resolve_contained_path(Path::new("compiler-pch/bits/stdc++.h.gch"))
        .ok()?;
    if let Some(parent) = dst_gch.parent() {
        fs::create_dir_all(parent).ok()?;
    }
    if fs::hard_link(&src_gch, &dst_gch)
        .or_else(|_| fs::copy(&src_gch, &dst_gch).map(|_| ()))
        .is_err()
    {
        return None;
    }
    Some(pch_dir)
}

pub fn ensure_universal_cpp_pch(
    platform: &ExecutorClient,
    toolchain: &ResolvedToolchain,
    compiler_flags: &[String],
) -> Result<PchEnsureOutcome, String> {
    ensure_universal_cpp_pch_in(None, platform, toolchain, compiler_flags)
}

pub fn ensure_universal_cpp_pch_in(
    app_data_dir: Option<&Path>,
    platform: &ExecutorClient,
    toolchain: &ResolvedToolchain,
    compiler_flags: &[String],
) -> Result<PchEnsureOutcome, String> {
    let source_header = find_stdcxx_header_for_toolchain(toolchain)
        .ok_or_else(|| "No stdc++.h header found for C++ toolchain".to_string())?;
    let identity = build_pch_cache_identity(toolchain, &source_header, compiler_flags)?;
    let cache_key = compute_pch_cache_key(&identity);
    let base_app_data = app_data_dir
        .map(Path::to_path_buf)
        .unwrap_or_else(get_app_data_dir);
    let pch_cache_root = base_app_data.join("pch-cache");
    let pch_dir = pch_cache_root.join(&cache_key);

    let key_lock = single_flight_lock_for(&cache_key);
    let _guard = key_lock
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    if is_valid_pch_cache_dir(&pch_dir, &identity) {
        return Ok(PchEnsureOutcome {
            pch_dir,
            cache_key,
            identity,
            generated: false,
        });
    }

    let nonce = PCH_TMP_NONCE.fetch_add(1, Ordering::Relaxed);
    let tmp_dir =
        pch_cache_root
            .join(".tmp")
            .join(format!("{}_{}_{}", cache_key, std::process::id(), nonce));
    let tmp_bits_dir = tmp_dir.join("bits");
    fs::create_dir_all(&tmp_bits_dir)
        .map_err(|e| format!("Failed to create PCH temp directory: {e}"))?;

    let staged_header = tmp_bits_dir.join("stdc++.h");
    let staged_gch = tmp_bits_dir.join("stdc++.h.gch");

    if let Err(e) = fs::copy(&source_header, &staged_header) {
        let _ = fs::remove_dir_all(&tmp_dir);
        return Err(format!("Failed to copy stdc++.h into PCH staging: {e}"));
    }

    let started = Instant::now();
    if let Err(err) = compile_cpp_pch_in_sandbox(
        platform,
        toolchain,
        &source_header,
        &staged_gch,
        compiler_flags,
    ) {
        let _ = fs::remove_dir_all(&tmp_dir);
        return Err(err);
    }

    let Some((pch_size_bytes, pch_sample_fingerprint)) =
        compute_pch_sample_fingerprint(&staged_gch)
    else {
        let _ = fs::remove_dir_all(&tmp_dir);
        return Err("PCH generation produced an invalid or truncated .gch artifact".to_string());
    };

    let metadata = PchMetadata {
        schema_version: 2,
        cache_key: cache_key.clone(),
        identity: identity.clone(),
        pch_size_bytes,
        pch_sample_fingerprint,
        compile_duration_ms: started.elapsed().as_millis() as u64,
    };

    let metadata_json = serde_json::to_string_pretty(&metadata)
        .map_err(|e| format!("Failed to serialize PCH metadata: {e}"))?;
    if let Err(e) = fs::write(tmp_dir.join("metadata.json"), metadata_json) {
        let _ = fs::remove_dir_all(&tmp_dir);
        return Err(format!("Failed to write PCH metadata.json: {e}"));
    }

    if pch_dir.exists() {
        invalidate_pch_cache_dir(&pch_dir);
    }
    if let Some(parent) = pch_dir.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Err(e) = fs::rename(&tmp_dir, &pch_dir) {
        let _ = fs::remove_dir_all(&tmp_dir);
        return Err(format!(
            "Failed to atomically promote PCH cache directory: {e}"
        ));
    }

    Ok(PchEnsureOutcome {
        pch_dir,
        cache_key,
        identity,
        generated: true,
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParitySnapshot {
    pub status: u16,
    pub headers: BTreeMap<String, String>,
    pub body: serde_json::Value,
    pub stream_events: Vec<serde_json::Value>,
    pub workspace_artifacts: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParityComparisonOutcome {
    pub passed: bool,
    pub mismatch_dimensions: Vec<String>,
}

pub fn compare_parity_snapshots(
    expected: &ParitySnapshot,
    actual: &ParitySnapshot,
) -> ParityComparisonOutcome {
    let mut mismatch_dimensions = Vec::new();
    if expected.status != actual.status {
        mismatch_dimensions.push("status".to_string());
    }
    if expected.headers != actual.headers {
        mismatch_dimensions.push("headers".to_string());
    }
    if expected.body != actual.body {
        mismatch_dimensions.push("body".to_string());
    }
    if expected.stream_events != actual.stream_events {
        mismatch_dimensions.push("stream_events".to_string());
    }
    if expected.workspace_artifacts != actual.workspace_artifacts {
        mismatch_dimensions.push("workspace_artifacts".to_string());
    }
    ParityComparisonOutcome {
        passed: mismatch_dimensions.is_empty(),
        mismatch_dimensions,
    }
}
