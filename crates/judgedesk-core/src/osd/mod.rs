use std::collections::{HashMap, VecDeque};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

use crate::discovery::testcase::{
    discover_test_cases, read_stored_problem_config, resolve_problem_directory_path,
};
use crate::engine::{run_judge_session, JudgeSessionConfig, JudgeStreamEvent};
use crate::rational::{
    format_rational_decimal, parse_rational_f64, parse_rational_value, Rational,
};
use crate::scoring::{ProblemSummary, TestCaseRun};
use crate::server::state::{JobAdmissionResult, ServerLifecyclePhase};
use crate::storage::{
    ensure_no_reparse_or_symlink_chain, is_symlink_or_reparse_point,
    validate_existing_directory_path, validate_path_syntax, OwnedWorkspace,
};
use crate::toolchains::discovery::compute_binary_sha256_hex;

const MAX_OSD_SOURCE_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum OsdInvalidReason {
    InvalidFormat,
    UnsupportedExtension,
    UnknownProblem,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum OsdParseResult {
    Valid {
        prefix: String,
        contestant: String,
        problem: String,
        language: String,
        ext: String,
    },
    Invalid {
        reason: OsdInvalidReason,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OsdJob {
    pub id: String,
    #[serde(rename = "originalFileName")]
    pub original_file_name: String,
    pub contestant: String,
    pub problem: String,
    pub language: String,
    pub ext: String,
    #[serde(rename = "receivedAt")]
    pub received_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProblemResultForLog {
    #[serde(rename = "problemName")]
    pub problem_name: String,
    #[serde(rename = "compileStatus")]
    pub compile_status: String,
    #[serde(rename = "compileError")]
    pub compile_error: Option<String>,
    #[serde(rename = "testCases")]
    pub test_cases: Vec<TestCaseRun>,
    pub summary: ProblemSummary,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OsdStatus {
    pub active: bool,
    #[serde(rename = "contestantsPath")]
    pub contestants_path: Option<String>,
    #[serde(rename = "currentJob")]
    pub current_job: Option<OsdJob>,
    #[serde(rename = "enableLog")]
    pub enable_log: bool,
    #[serde(rename = "lastProcessedJob")]
    pub last_processed_job: Option<OsdJob>,
    #[serde(rename = "osdPath")]
    pub osd_path: Option<String>,
    pub paused: bool,
    #[serde(rename = "queueLength")]
    pub queue_length: usize,
    #[serde(rename = "testPath")]
    pub test_path: Option<String>,
    #[serde(rename = "totalProcessed")]
    pub total_processed: u64,
}

impl Default for OsdStatus {
    fn default() -> Self {
        Self {
            active: false,
            contestants_path: None,
            current_job: None,
            enable_log: true,
            last_processed_job: None,
            osd_path: None,
            paused: false,
            queue_length: 0,
            test_path: None,
            total_processed: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OsdEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    pub data: serde_json::Value,
}

#[derive(Debug, Clone)]
pub struct ClaimedOsdSource {
    pub owned_dir: PathBuf,
    pub incoming_path: PathBuf,
    pub staged_name: String,
}

#[derive(Debug, Clone)]
pub struct StableOsdSource {
    pub size: u64,
    pub modified_ns: u128,
}

#[derive(Debug, Clone)]
pub struct StagedOsdSource {
    pub owned_dir: PathBuf,
    pub staged_path: PathBuf,
    pub size: u64,
    pub sha256: String,
}

pub fn is_safe_osd_component(value: &str) -> bool {
    if value.is_empty() || value.len() > 255 {
        return false;
    }
    if value.trim() != value || value.ends_with('.') || value.ends_with(' ') {
        return false;
    }
    if value == "." || value == ".." {
        return false;
    }
    for ch in value.chars() {
        let code = ch as u32;
        if code <= 0x1F
            || code == 0x7F
            || matches!(
                ch,
                '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\u{2023}'
            )
        {
            return false;
        }
    }
    let stem = value.split('.').next().unwrap_or(value);
    !matches!(
        stem.to_ascii_lowercase().as_str(),
        "con"
            | "prn"
            | "aux"
            | "nul"
            | "com1"
            | "com2"
            | "com3"
            | "com4"
            | "com5"
            | "com6"
            | "com7"
            | "com8"
            | "com9"
            | "lpt1"
            | "lpt2"
            | "lpt3"
            | "lpt4"
            | "lpt5"
            | "lpt6"
            | "lpt7"
            | "lpt8"
            | "lpt9"
    )
}

fn map_osd_extension(raw_ext: &str) -> Option<(&'static str, &'static str)> {
    match raw_ext.to_ascii_lowercase().as_str() {
        "cpp" | "cc" | "cxx" | "c++" => Some(("cpp", ".cpp")),
        "c" => Some(("c", ".c")),
        "py" => Some(("python", ".py")),
        "pas" | "pp" | "dpr" => Some(("pascal", ".pas")),
        "java" => Some(("java", ".java")),
        "sb3" => Some(("scratch", ".sb3")),
        _ => None,
    }
}

/// Parses both dotted (`prefix[Contestant][Problem].ext`) and dotless Themis Web
/// (`0[Contestant][Problem]ext`) filenames without external regex crates.
pub fn parse_osd_filename(file_name: &str, valid_problems: &[String]) -> OsdParseResult {
    let invalid_format = || OsdParseResult::Invalid {
        reason: OsdInvalidReason::InvalidFormat,
    };

    if file_name.is_empty()
        || file_name.len() > 240
        || file_name.trim() != file_name
        || file_name
            .chars()
            .any(|ch| (ch as u32) <= 0x1F || ch == '\x7F')
    {
        return invalid_format();
    }

    let Some(b1) = file_name.find('[') else {
        return invalid_format();
    };
    let prefix = &file_name[..b1];
    if prefix.chars().any(|ch| {
        matches!(
            ch,
            '[' | ']' | '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
        )
    }) {
        return invalid_format();
    }

    let rest1 = &file_name[b1 + 1..];
    let Some(rel_b2) = rest1.find(']') else {
        return invalid_format();
    };
    let contestant = &rest1[..rel_b2];
    if contestant.is_empty() || contestant.contains('[') || contestant.contains(']') {
        return invalid_format();
    }

    let after_c = &rest1[rel_b2 + 1..];
    let Some(after_second_open) = after_c.strip_prefix('[') else {
        return invalid_format();
    };
    let Some(rel_b3) = after_second_open.find(']') else {
        return invalid_format();
    };
    let raw_problem = &after_second_open[..rel_b3];
    if raw_problem.is_empty() || raw_problem.contains('[') || raw_problem.contains(']') {
        return invalid_format();
    }

    let suffix = &after_second_open[rel_b3 + 1..];
    let raw_ext = suffix.strip_prefix('.').unwrap_or(suffix);
    if raw_ext.is_empty()
        || !raw_ext
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'+')
    {
        return invalid_format();
    }

    if !is_safe_osd_component(contestant) || !is_safe_osd_component(raw_problem) {
        return invalid_format();
    }

    let Some((language, canonical_ext)) = map_osd_extension(raw_ext) else {
        return OsdParseResult::Invalid {
            reason: OsdInvalidReason::UnsupportedExtension,
        };
    };

    let resolved_problem = if valid_problems.is_empty() {
        raw_problem.to_string()
    } else {
        let Some(matched) = valid_problems
            .iter()
            .find(|p| is_safe_osd_component(p) && p.eq_ignore_ascii_case(raw_problem))
        else {
            return OsdParseResult::Invalid {
                reason: OsdInvalidReason::UnknownProblem,
            };
        };
        matched.clone()
    };

    OsdParseResult::Valid {
        prefix: prefix.to_string(),
        contestant: contestant.to_string(),
        problem: resolved_problem,
        language: language.to_string(),
        ext: canonical_ext.to_string(),
    }
}

pub fn ensure_osd_directory(root: &Path, components: &[&str]) -> Result<PathBuf, String> {
    let mut dir = validate_existing_directory_path(root)?;
    for comp in components {
        if !is_safe_osd_component(comp) {
            return Err(format!("OSD_UNSAFE_COMPONENT: '{comp}'"));
        }
        dir.push(comp);
        match fs::symlink_metadata(&dir) {
            Ok(meta) => {
                if is_symlink_or_reparse_point(&meta) || !meta.is_dir() {
                    return Err(format!(
                        "OSD_DIRECTORY_LINKED_OR_NOT_DIR: {}",
                        dir.display()
                    ));
                }
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&dir)
                    .map_err(|e| format!("OSD_DIRECTORY_CREATE_FAILED ({}): {e}", dir.display()))?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
                }
            }
            Err(err) => {
                return Err(format!(
                    "OSD_DIRECTORY_STAT_FAILED ({}): {err}",
                    dir.display()
                ));
            }
        }
    }
    Ok(dir)
}

fn verify_regular_unlinked_file(path: &Path) -> Result<fs::Metadata, String> {
    let meta = fs::symlink_metadata(path)
        .map_err(|e| format!("OSD_SOURCE_STAT_FAILED ({}): {e}", path.display()))?;
    if is_symlink_or_reparse_point(&meta) || !meta.is_file() {
        return Err(format!(
            "OSD_SOURCE_LINKED_OR_NOT_REGULAR: {}",
            path.display()
        ));
    }
    if meta.len() > MAX_OSD_SOURCE_BYTES {
        return Err(format!(
            "OSD_SOURCE_TOO_LARGE ({} bytes > {} bytes): {}",
            meta.len(),
            MAX_OSD_SOURCE_BYTES,
            path.display()
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if meta.nlink() != 1 {
            return Err(format!("OSD_SOURCE_HARDLINKED: {}", path.display()));
        }
    }
    Ok(meta)
}

fn modified_nanos(meta: &fs::Metadata) -> u128 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

pub fn claim_osd_source_file(
    osd_dir: &Path,
    source_path: &Path,
    staged_name: &str,
) -> Result<ClaimedOsdSource, String> {
    if !is_safe_osd_component(staged_name) {
        return Err(format!("OSD_UNSAFE_STAGED_NAME: {staged_name}"));
    }
    let root = ensure_osd_directory(osd_dir, &[])?;
    let _ = verify_regular_unlinked_file(source_path)?;

    let owned_dir_name = format!(".judgedesk-osd-{}", uuid::Uuid::new_v4());
    let owned_dir = root.join(owned_dir_name);
    fs::create_dir(&owned_dir)
        .map_err(|e| format!("OSD_CLAIM_DIR_CREATE_FAILED ({}): {e}", owned_dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&owned_dir, fs::Permissions::from_mode(0o700));
    }

    let incoming_path = owned_dir.join(".incoming");
    if let Err(err) = fs::rename(source_path, &incoming_path) {
        let _ = fs::remove_dir(&owned_dir);
        return Err(format!(
            "OSD_CLAIM_RENAME_FAILED ({} -> {}): {err}",
            source_path.display(),
            incoming_path.display()
        ));
    }

    if let Err(err) = verify_regular_unlinked_file(&incoming_path) {
        let _ = fs::remove_file(&incoming_path);
        let _ = fs::remove_dir(&owned_dir);
        return Err(err);
    }

    Ok(ClaimedOsdSource {
        owned_dir,
        incoming_path,
        staged_name: staged_name.to_string(),
    })
}

pub async fn wait_for_claimed_source_stability(
    claimed: &ClaimedOsdSource,
    debounce_ms: u64,
    max_retries: usize,
) -> Result<StableOsdSource, String> {
    let attempts = max_retries.max(1);
    for _ in 0..attempts {
        let before = verify_regular_unlinked_file(&claimed.incoming_path)?;
        let size1 = before.len();
        let mtime1 = modified_nanos(&before);

        tokio::time::sleep(Duration::from_millis(debounce_ms)).await;

        let after = verify_regular_unlinked_file(&claimed.incoming_path)?;
        let size2 = after.len();
        let mtime2 = modified_nanos(&after);

        if size1 == size2 && mtime1 == mtime2 {
            return Ok(StableOsdSource {
                size: size2,
                modified_ns: mtime2,
            });
        }
    }
    Err("OSD_SOURCE_NOT_STABLE".to_string())
}

pub fn stage_claimed_source(
    claimed: &ClaimedOsdSource,
    stable: &StableOsdSource,
) -> Result<StagedOsdSource, String> {
    let dir_meta = fs::symlink_metadata(&claimed.owned_dir)
        .map_err(|e| format!("OSD_OWNED_DIR_MISSING: {e}"))?;
    if is_symlink_or_reparse_point(&dir_meta) || !dir_meta.is_dir() {
        return Err("OSD_SOURCE_OWNERSHIP_LOST".to_string());
    }

    let before_copy = verify_regular_unlinked_file(&claimed.incoming_path)?;
    if before_copy.len() != stable.size || modified_nanos(&before_copy) != stable.modified_ns {
        return Err("OSD_SOURCE_CHANGED_BEFORE_STAGE".to_string());
    }

    let snapshot_path = claimed.owned_dir.join(".snapshot");
    let bytes =
        fs::read(&claimed.incoming_path).map_err(|e| format!("OSD_STAGE_READ_FAILED: {e}"))?;
    {
        let mut out = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&snapshot_path)
            .map_err(|e| format!("OSD_STAGE_CREATE_FAILED: {e}"))?;
        out.write_all(&bytes)
            .map_err(|e| format!("OSD_STAGE_WRITE_FAILED: {e}"))?;
        out.sync_all()
            .map_err(|e| format!("OSD_STAGE_SYNC_FAILED: {e}"))?;
    }

    let after_copy = verify_regular_unlinked_file(&claimed.incoming_path)?;
    if after_copy.len() != stable.size || modified_nanos(&after_copy) != stable.modified_ns {
        let _ = fs::remove_file(&snapshot_path);
        return Err("OSD_SOURCE_CHANGED_DURING_STAGE".to_string());
    }

    let sha256 = compute_binary_sha256_hex(&snapshot_path)?;
    let staged_path = claimed.owned_dir.join(&claimed.staged_name);
    fs::rename(&snapshot_path, &staged_path)
        .map_err(|e| format!("OSD_STAGE_RENAME_FAILED: {e}"))?;
    let _ = fs::remove_file(&claimed.incoming_path);

    Ok(StagedOsdSource {
        owned_dir: claimed.owned_dir.clone(),
        staged_path,
        size: stable.size,
        sha256,
    })
}

pub fn verify_claimed_source_integrity(staged: &StagedOsdSource) -> Result<(), String> {
    let dir_meta = fs::symlink_metadata(&staged.owned_dir)
        .map_err(|e| format!("OSD_OWNED_DIR_MISSING: {e}"))?;
    if is_symlink_or_reparse_point(&dir_meta) || !dir_meta.is_dir() {
        return Err("OSD_SOURCE_OWNERSHIP_LOST".to_string());
    }

    let file_meta = verify_regular_unlinked_file(&staged.staged_path)?;
    if file_meta.len() != staged.size {
        return Err("OSD_SOURCE_INTEGRITY_MISMATCH: size changed".to_string());
    }
    let current_sha = compute_binary_sha256_hex(&staged.staged_path)?;
    if current_sha != staged.sha256 {
        return Err("OSD_SOURCE_INTEGRITY_MISMATCH: sha256 changed".to_string());
    }
    Ok(())
}

pub fn dispose_claimed_source(claimed: &ClaimedOsdSource) -> Result<(), String> {
    let dir_meta = match fs::symlink_metadata(&claimed.owned_dir) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("OSD_DISPOSE_STAT_FAILED: {e}")),
    };
    if is_symlink_or_reparse_point(&dir_meta) || !dir_meta.is_dir() {
        return Err("OSD_SOURCE_OWNERSHIP_LOST".to_string());
    }

    for child_name in [&claimed.staged_name, ".incoming", ".snapshot"] {
        let child_path = claimed.owned_dir.join(child_name);
        if let Ok(meta) = fs::symlink_metadata(&child_path) {
            if is_symlink_or_reparse_point(&meta) || !meta.is_file() {
                return Err("OSD_SOURCE_OWNERSHIP_LOST".to_string());
            }
            fs::remove_file(&child_path).map_err(|e| {
                format!("OSD_DISPOSE_UNLINK_FAILED ({}): {e}", child_path.display())
            })?;
        }
    }

    fs::remove_dir(&claimed.owned_dir).map_err(|e| {
        format!(
            "OSD_DISPOSE_RMDIR_FAILED ({}): {e}",
            claimed.owned_dir.display()
        )
    })
}

pub fn write_osd_atomic_file(
    root: &Path,
    subdirs: &[&str],
    file_name: &str,
    contents: &[u8],
) -> Result<PathBuf, String> {
    if !is_safe_osd_component(file_name) {
        return Err(format!("OSD_UNSAFE_FILENAME: {file_name}"));
    }
    let dir = ensure_osd_directory(root, subdirs)?;
    let target = dir.join(file_name);
    if let Ok(existing) = fs::symlink_metadata(&target) {
        if is_symlink_or_reparse_point(&existing) || !existing.is_file() {
            return Err(format!(
                "OSD_TARGET_LINKED_OR_NOT_FILE: {}",
                target.display()
            ));
        }
    }
    let tmp_path = dir.join(format!(".osd-{}.tmp", uuid::Uuid::new_v4()));
    let write_res = (|| -> Result<(), String> {
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp_path)
            .map_err(|e| format!("OSD_TMP_OPEN_FAILED: {e}"))?;
        f.write_all(contents)
            .map_err(|e| format!("OSD_TMP_WRITE_FAILED: {e}"))?;
        f.sync_all()
            .map_err(|e| format!("OSD_TMP_SYNC_FAILED: {e}"))?;
        drop(f);
        fs::rename(&tmp_path, &target).map_err(|e| format!("OSD_TMP_RENAME_FAILED: {e}"))?;
        Ok(())
    })();
    if write_res.is_err() {
        let _ = fs::remove_file(&tmp_path);
    }
    write_res.map(|()| target)
}

fn one_line(value: &str) -> String {
    value
        .chars()
        .map(|c| {
            if (c as u32) <= 0x1F || c == '\x7F' {
                ' '
            } else {
                c
            }
        })
        .collect::<String>()
        .trim()
        .to_string()
}

pub fn write_osd_error_log(
    osd_path: &Path,
    original_file_name: &str,
    contestant: &str,
    problem: &str,
    ext: &str,
    headline: &str,
    detail: &str,
) -> Result<PathBuf, String> {
    let safe_contestant = if is_safe_osd_component(contestant) {
        contestant
    } else {
        "Không xác định"
    };
    let safe_problem = if is_safe_osd_component(problem) {
        problem
    } else {
        "Không xác định"
    };
    let norm_ext = if ext.is_empty() {
        String::new()
    } else if ext.starts_with('.') {
        ext.to_string()
    } else {
        format!(".{ext}")
    };
    let source_name = if is_safe_osd_component(problem) && !norm_ext.is_empty() {
        format!("{problem}{norm_ext}")
    } else {
        original_file_name.to_string()
    };

    let mut lines = vec![
        format!("{safe_contestant}‣{safe_problem}: ℱ {headline}"),
        one_line(&source_name),
        "Err".to_string(),
    ];
    let normalized_detail = detail.replace("\r\n", "\n").replace('\r', "\n");
    for line in normalized_detail.split('\n') {
        lines.push(line.to_string());
    }
    lines.push(String::new());
    let payload = lines.join("\r\n");
    let log_name = format!("{original_file_name}.log");
    write_osd_atomic_file(osd_path, &["logs"], &log_name, payload.as_bytes())
}

pub fn write_osd_log(
    osd_path: &Path,
    job: &OsdJob,
    result: &ProblemResultForLog,
) -> Result<PathBuf, String> {
    if !is_safe_osd_component(&job.contestant) || !is_safe_osd_component(&job.problem) {
        return Err("OSD_INVALID_LOG_IDENTIFIER".to_string());
    }
    let norm_ext = if job.ext.starts_with('.') {
        job.ext.clone()
    } else {
        format!(".{}", job.ext)
    };
    let source_name = format!("{}{norm_ext}", job.problem);
    let prefix = format!("{}‣{}", job.contestant, job.problem);

    let judge_errors: Vec<&TestCaseRun> = result
        .test_cases
        .iter()
        .filter(|tc| tc.status == "JE" || tc.status == "FAIL")
        .collect();
    if result.summary.status == "JE" || result.summary.status == "FAIL" || !judge_errors.is_empty()
    {
        let details = if judge_errors.is_empty() {
            "Judge infrastructure error".to_string()
        } else {
            judge_errors
                .iter()
                .map(|tc| {
                    tc.error_detail
                        .as_deref()
                        .or(tc.checker_message.as_deref())
                        .unwrap_or(tc.status.as_str())
                })
                .collect::<Vec<_>>()
                .join("\n")
        };
        return write_osd_error_log(
            osd_path,
            &job.original_file_name,
            &job.contestant,
            &job.problem,
            &norm_ext,
            "Lỗi hệ thống chấm",
            &details,
        );
    }

    if result.compile_status == "CE" {
        let detail = result
            .compile_error
            .as_deref()
            .unwrap_or("Compilation error");
        return write_osd_error_log(
            osd_path,
            &job.original_file_name,
            &job.contestant,
            &job.problem,
            &norm_ext,
            "Dịch lỗi",
            detail,
        );
    }

    let total_rat: Rational = result
        .summary
        .score_exact
        .clone()
        .unwrap_or_else(|| parse_rational_f64(result.summary.score));
    let total_score_str = format_rational_decimal(&total_rat, 6);

    let mut lines = vec![
        format!("{prefix}: {total_score_str}"),
        one_line(&source_name),
        "Dịch thành công".to_string(),
        String::new(),
    ];

    for tc in &result.test_cases {
        if !is_safe_osd_component(&tc.name) {
            return Err(format!("OSD_INVALID_TESTCASE_IDENTIFIER: {}", tc.name));
        }
        let tc_rat = tc
            .score_exact
            .clone()
            .unwrap_or_else(|| parse_rational_value(&tc.score));
        let tc_score_str = format_rational_decimal(&tc_rat, 6);
        lines.push(format!("{prefix}‣{}: {tc_score_str}", tc.name));

        if tc.status == "TLE" {
            lines.push("Chạy quá thời gian".to_string());
        } else if tc.status == "RE" {
            lines.push("Chạy sinh lỗi".to_string());
            let detail = tc
                .error_detail
                .as_deref()
                .or(tc.checker_message.as_deref())
                .unwrap_or("Runtime error");
            lines.push(one_line(detail));
        } else {
            let exec_ms = tc.execution_time.unwrap_or(0);
            let secs_str = format!("{}.{:03}000", exec_ms / 1000, exec_ms % 1000);
            lines.push(format!("Thời gian ≈ {secs_str} giây"));
            let label = match tc.status.as_str() {
                "AC" => "Kết quả khớp",
                "WA" => "Sai kết quả",
                "PE" => "Sai định dạng",
                "MLE" => "Vượt quá bộ nhớ",
                "OLE" => "Vượt quá giới hạn đầu ra",
                other => other,
            };
            let detail = tc
                .checker_message
                .as_deref()
                .or(tc.error_detail.as_deref())
                .unwrap_or("")
                .trim();
            if detail.is_empty() {
                lines.push(label.to_string());
            } else {
                lines.push(format!("{label}: {}", one_line(detail)));
            }
        }
    }

    lines.push(String::new());
    let payload = lines.join("\r\n");
    let log_name = format!("{}.log", job.original_file_name);
    write_osd_atomic_file(osd_path, &["logs"], &log_name, payload.as_bytes())
}

struct QueuedOsdSubmission {
    job: OsdJob,
    claimed: ClaimedOsdSource,
    staged: StagedOsdSource,
    osd_dir: PathBuf,
    test_dir: PathBuf,
    enable_log: bool,
    problem_configs: HashMap<String, serde_json::Value>,
}

struct OsdRuntimeInner {
    status: OsdStatus,
    queue: VecDeque<QueuedOsdSubmission>,
    latest_jobs: HashMap<(String, String), String>,
    watcher_stop: Option<Arc<AtomicBool>>,
    generation: u64,
    in_flight_claims: usize,
    worker_running: bool,
    problem_configs: HashMap<String, serde_json::Value>,
}

pub struct OsdService {
    inner: Mutex<OsdRuntimeInner>,
    events_tx: broadcast::Sender<OsdEvent>,
}

static OSD_JOB_COUNTER: AtomicU64 = AtomicU64::new(1);

impl Default for OsdService {
    fn default() -> Self {
        Self::new()
    }
}

impl OsdService {
    pub fn new() -> Self {
        let (events_tx, _) = broadcast::channel(256);
        Self {
            inner: Mutex::new(OsdRuntimeInner {
                status: OsdStatus::default(),
                queue: VecDeque::new(),
                latest_jobs: HashMap::new(),
                watcher_stop: None,
                generation: 0,
                in_flight_claims: 0,
                worker_running: false,
                problem_configs: HashMap::new(),
            }),
            events_tx,
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<OsdEvent> {
        self.events_tx.subscribe()
    }

    pub fn emit_event(&self, event_type: &str, data: serde_json::Value) {
        let _ = self.events_tx.send(OsdEvent {
            event_type: event_type.to_string(),
            data,
        });
    }

    pub fn get_status(&self) -> OsdStatus {
        let guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let mut st = guard.status.clone();
        st.queue_length = guard.queue.len();
        st
    }

    pub fn stop(&self) -> OsdStatus {
        let status = {
            let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(stop_flag) = guard.watcher_stop.take() {
                stop_flag.store(true, Ordering::SeqCst);
            }
            guard.status.active = false;
            guard.status.paused = false;
            guard.status.queue_length = guard.queue.len();
            guard.status.clone()
        };
        if let Ok(val) = serde_json::to_value(&status) {
            self.emit_event("osd_status", val);
        }
        status
    }

    pub fn start(
        &self,
        state: crate::server::state::AppState,
        osd_path: String,
        contestants_path: String,
        test_path: String,
        enable_log: bool,
        problem_configs: HashMap<String, serde_json::Value>,
    ) -> Result<OsdStatus, String> {
        let osd_p = PathBuf::from(&osd_path);
        let contestants_p = PathBuf::from(&contestants_path);
        let test_p = PathBuf::from(&test_path);

        if !contestants_p.exists() || !contestants_p.is_dir() {
            return Err(format!(
                "Thư mục thí sinh không tồn tại: {}",
                contestants_p.display()
            ));
        }
        if !test_p.exists() || !test_p.is_dir() {
            return Err(format!(
                "Thư mục đề thi không tồn tại: {}",
                test_p.display()
            ));
        }
        validate_path_syntax(&osd_p)?;
        ensure_no_reparse_or_symlink_chain(&osd_p, None)?;
        if !osd_p.exists() {
            fs::create_dir_all(&osd_p).map_err(|e| format!("Không thể tạo thư mục OSD: {e}"))?;
        }

        let canonical_osd = ensure_osd_directory(&osd_p, &[])?;
        let canonical_contestants = ensure_osd_directory(&contestants_p, &[])?;
        let canonical_test = ensure_osd_directory(&test_p, &[])?;

        let stop_flag = Arc::new(AtomicBool::new(false));
        let (status, generation) = {
            let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            if guard.status.current_job.is_some()
                || !guard.queue.is_empty()
                || guard.in_flight_claims > 0
            {
                return Err(
                    "Đang nhận/chấm bài hoặc còn bài trong hàng đợi; hãy đợi xử lí xong trước khi đổi phiên OSD."
                        .to_string(),
                );
            }
            if let Some(prev_stop) = guard.watcher_stop.take() {
                prev_stop.store(true, Ordering::SeqCst);
            }
            guard.generation = guard.generation.saturating_add(1);
            let gen_id = guard.generation;
            guard.latest_jobs.clear();
            guard.problem_configs = problem_configs;
            guard.watcher_stop = Some(Arc::clone(&stop_flag));
            guard.status.active = true;
            guard.status.paused = false;
            guard.status.osd_path = Some(osd_path);
            guard.status.contestants_path = Some(contestants_path);
            guard.status.test_path = Some(test_path);
            guard.status.enable_log = enable_log;
            guard.status.queue_length = guard.queue.len();
            (guard.status.clone(), gen_id)
        };

        if let Ok(val) = serde_json::to_value(&status) {
            self.emit_event("osd_status", val);
        }

        spawn_osd_watcher_loop(
            state,
            canonical_osd,
            canonical_contestants,
            canonical_test,
            enable_log,
            stop_flag,
            generation,
        );

        Ok(status)
    }
}

struct InFlightClaimGuard {
    state: crate::server::state::AppState,
}

impl InFlightClaimGuard {
    fn acquire(state: &crate::server::state::AppState, generation: u64) -> Option<Self> {
        let mut guard = state.osd.inner.lock().unwrap_or_else(|e| e.into_inner());
        if guard.generation != generation || !guard.status.active {
            return None;
        }
        guard.in_flight_claims = guard.in_flight_claims.saturating_add(1);
        Some(Self {
            state: state.clone(),
        })
    }
}

impl Drop for InFlightClaimGuard {
    fn drop(&mut self) {
        let mut guard = self
            .state
            .osd
            .inner
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        guard.in_flight_claims = guard.in_flight_claims.saturating_sub(1);
    }
}

fn is_ignored_osd_entry(file_name: &str) -> bool {
    let lower = file_name.to_ascii_lowercase();
    if file_name.starts_with('.')
        || lower == "logs"
        || lower == "rejected"
        || lower == "$history"
        || lower == ".ds_store"
        || lower == "thumbs.db"
        || lower.ends_with(".tmp")
        || lower.ends_with(".part")
    {
        return true;
    }
    false
}

fn list_valid_problems(test_dir: &Path) -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(entries) = fs::read_dir(test_dir) {
        for entry in entries.flatten() {
            if let Ok(meta) = fs::symlink_metadata(entry.path()) {
                if !is_symlink_or_reparse_point(&meta) && meta.is_dir() {
                    out.push(entry.file_name().to_string_lossy().to_string());
                }
            }
        }
    }
    out
}

fn has_case_insensitive_alias_collision(contestants_dir: &Path, contestant: &str) -> bool {
    let Ok(entries) = fs::read_dir(contestants_dir) else {
        return false;
    };
    let mut exact_found = false;
    let mut ci_found = false;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name == contestant {
            exact_found = true;
        } else if name.eq_ignore_ascii_case(contestant) {
            ci_found = true;
        }
    }
    ci_found && !exact_found
}

fn ensure_osd_queue_worker_spawned(state: crate::server::state::AppState) {
    let should_spawn = {
        let mut guard = state.osd.inner.lock().unwrap_or_else(|e| e.into_inner());
        if guard.worker_running || guard.queue.is_empty() {
            false
        } else {
            guard.worker_running = true;
            true
        }
    };
    if should_spawn {
        tokio::spawn(async move {
            process_osd_queue(&state).await;
        });
    }
}

fn spawn_osd_watcher_loop(
    state: crate::server::state::AppState,
    osd_dir: PathBuf,
    contestants_dir: PathBuf,
    test_dir: PathBuf,
    enable_log: bool,
    stop_flag: Arc<AtomicBool>,
    generation: u64,
) {
    tokio::spawn(async move {
        while !stop_flag.load(Ordering::SeqCst)
            && state.lifecycle_phase() == ServerLifecyclePhase::Running
        {
            scan_osd_inbox_once(
                &state,
                &osd_dir,
                &contestants_dir,
                &test_dir,
                enable_log,
                &stop_flag,
                generation,
            )
            .await;
            ensure_osd_queue_worker_spawned(state.clone());
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        ensure_osd_queue_worker_spawned(state);
    });
}

fn preserve_rejected_bytes(osd_dir: &Path, file_name: &str, bytes: &[u8]) {
    let rej_name = if is_safe_osd_component(file_name) {
        file_name.to_string()
    } else {
        format!("{}.source", uuid::Uuid::new_v4())
    };
    let _ = write_osd_atomic_file(osd_dir, &["Rejected"], &rej_name, bytes);
}

fn preserve_rejected_incoming(osd_dir: &Path, file_name: &str, claimed: &ClaimedOsdSource) {
    if verify_regular_unlinked_file(&claimed.incoming_path).is_ok() {
        if let Ok(bytes) = fs::read(&claimed.incoming_path) {
            preserve_rejected_bytes(osd_dir, file_name, &bytes);
        }
    }
}

async fn scan_osd_inbox_once(
    state: &crate::server::state::AppState,
    osd_dir: &Path,
    contestants_dir: &Path,
    test_dir: &Path,
    enable_log: bool,
    stop_flag: &Arc<AtomicBool>,
    generation: u64,
) {
    let entries = match fs::read_dir(osd_dir) {
        Ok(rd) => rd,
        Err(_) => return,
    };

    let valid_problems = list_valid_problems(test_dir);
    let mut candidate_names: Vec<String> = Vec::new();
    for entry in entries.flatten() {
        let file_name = entry.file_name().to_string_lossy().to_string();
        if is_ignored_osd_entry(&file_name) {
            continue;
        }
        if let Ok(meta) = fs::symlink_metadata(entry.path()) {
            if !meta.is_dir() {
                candidate_names.push(file_name);
            }
        }
    }
    candidate_names.sort();

    for file_name in candidate_names {
        if stop_flag.load(Ordering::SeqCst)
            || state.lifecycle_phase() != ServerLifecyclePhase::Running
        {
            break;
        }
        let Some(_claim_guard) = InFlightClaimGuard::acquire(state, generation) else {
            break;
        };

        let source_path = osd_dir.join(&file_name);
        if !source_path.exists() {
            continue;
        }
        let parsed = parse_osd_filename(&file_name, &valid_problems);
        let staged_name = match &parsed {
            OsdParseResult::Valid { problem, ext, .. } => format!("{problem}{ext}"),
            OsdParseResult::Invalid { .. } => "rejected.source".to_string(),
        };

        let claimed = match claim_osd_source_file(osd_dir, &source_path, &staged_name) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let stable = match wait_for_claimed_source_stability(&claimed, 25, 5).await {
            Ok(s) => s,
            Err(err) => {
                preserve_rejected_incoming(osd_dir, &file_name, &claimed);
                if enable_log {
                    let _ = write_osd_error_log(
                        osd_dir,
                        &file_name,
                        "Không xác định",
                        "Không xác định",
                        "",
                        "Lỗi nhận bài nộp",
                        &err,
                    );
                }
                state.osd.emit_event(
                    "osd_error",
                    serde_json::json!({ "fileName": file_name, "message": err }),
                );
                let _ = dispose_claimed_source(&claimed);
                continue;
            }
        };
        let staged = match stage_claimed_source(&claimed, &stable) {
            Ok(st) => st,
            Err(err) => {
                preserve_rejected_incoming(osd_dir, &file_name, &claimed);
                if enable_log {
                    let _ = write_osd_error_log(
                        osd_dir,
                        &file_name,
                        "Không xác định",
                        "Không xác định",
                        "",
                        "Lỗi nhận bài nộp",
                        &err,
                    );
                }
                state.osd.emit_event(
                    "osd_error",
                    serde_json::json!({ "fileName": file_name, "message": err }),
                );
                let _ = dispose_claimed_source(&claimed);
                continue;
            }
        };

        let (contestant, problem, language, ext) = match parsed {
            OsdParseResult::Valid {
                contestant,
                problem,
                language,
                ext,
                ..
            } => (contestant, problem, language, ext),
            OsdParseResult::Invalid { reason } => {
                if let Ok(bytes) = fs::read(&staged.staged_path) {
                    preserve_rejected_bytes(osd_dir, &file_name, &bytes);
                }
                let msg = format!("INVALID_SUBMISSION: {reason:?}");
                if enable_log {
                    let _ = write_osd_error_log(
                        osd_dir,
                        &file_name,
                        "Không xác định",
                        "Không xác định",
                        "",
                        "Từ chối bài nộp",
                        &msg,
                    );
                }
                state.osd.emit_event(
                    "osd_error",
                    serde_json::json!({ "fileName": file_name, "message": msg }),
                );
                let _ = dispose_claimed_source(&claimed);
                continue;
            }
        };

        if has_case_insensitive_alias_collision(contestants_dir, &contestant) {
            if let Ok(bytes) = fs::read(&staged.staged_path) {
                preserve_rejected_bytes(osd_dir, &file_name, &bytes);
            }
            let msg =
                "OSD_CONTESTANT_IDENTITY_ALIAS: tên thí sinh trùng thư mục với cách viết khác.";
            if enable_log {
                let _ = write_osd_error_log(
                    osd_dir,
                    &file_name,
                    &contestant,
                    &problem,
                    &ext,
                    "Từ chối bài nộp",
                    msg,
                );
            }
            state.osd.emit_event(
                "osd_error",
                serde_json::json!({ "fileName": file_name, "message": msg }),
            );
            let _ = dispose_claimed_source(&claimed);
            continue;
        }

        let is_new_contestant = !contestants_dir.join(&contestant).exists();
        let contestant_dir = match ensure_osd_directory(contestants_dir, &[&contestant]) {
            Ok(d) => d,
            Err(err) => {
                if let Ok(bytes) = fs::read(&staged.staged_path) {
                    preserve_rejected_bytes(osd_dir, &file_name, &bytes);
                }
                if enable_log {
                    let _ = write_osd_error_log(
                        osd_dir,
                        &file_name,
                        &contestant,
                        &problem,
                        &ext,
                        "Lỗi hệ thống chấm",
                        &err,
                    );
                }
                state.osd.emit_event(
                    "osd_error",
                    serde_json::json!({ "fileName": file_name, "message": err }),
                );
                let _ = dispose_claimed_source(&claimed);
                continue;
            }
        };
        if is_new_contestant {
            state.osd.emit_event(
                "osd_contestant_added",
                serde_json::json!({ "contestant": contestant }),
            );
        }

        // Archive any existing problem source file in Contestants/<contestant> into $History
        let mut history_archive_err: Option<String> = None;
        if let Ok(existing_entries) = fs::read_dir(&contestant_dir) {
            for existing in existing_entries.flatten() {
                let existing_name = existing.file_name().to_string_lossy().to_string();
                let existing_path = existing.path();
                let Some(stem) = existing_path.file_stem().and_then(|s| s.to_str()) else {
                    continue;
                };
                if !stem.eq_ignore_ascii_case(&problem) {
                    continue;
                }
                let archive_step = (|| -> Result<(), String> {
                    let _ = verify_regular_unlinked_file(&existing_path)?;
                    let prev_bytes = fs::read(&existing_path).map_err(|e| {
                        format!("OSD_HISTORY_READ_FAILED ({}): {e}", existing_path.display())
                    })?;
                    let hist_name = format!("{}_{existing_name}", uuid::Uuid::new_v4());
                    let _ = write_osd_atomic_file(
                        contestants_dir,
                        &[&contestant, "$History"],
                        &hist_name,
                        &prev_bytes,
                    )?;
                    fs::remove_file(&existing_path).map_err(|e| {
                        format!(
                            "OSD_HISTORY_UNLINK_FAILED ({}): {e}",
                            existing_path.display()
                        )
                    })?;
                    Ok(())
                })();
                if let Err(err) = archive_step {
                    history_archive_err = Some(err);
                    break;
                }
            }
        }
        if let Some(err) = history_archive_err {
            if let Ok(bytes) = fs::read(&staged.staged_path) {
                preserve_rejected_bytes(osd_dir, &file_name, &bytes);
            }
            if enable_log {
                let _ = write_osd_error_log(
                    osd_dir,
                    &file_name,
                    &contestant,
                    &problem,
                    &ext,
                    "Lỗi lưu lịch sử bài nộp",
                    &err,
                );
            }
            state.osd.emit_event(
                "osd_error",
                serde_json::json!({ "fileName": file_name, "message": err }),
            );
            let _ = dispose_claimed_source(&claimed);
            continue;
        }

        let staged_bytes = match fs::read(&staged.staged_path) {
            Ok(b) => b,
            Err(_) => {
                let _ = dispose_claimed_source(&claimed);
                continue;
            }
        };
        let target_source_name = format!("{problem}{ext}");
        if let Err(err) = write_osd_atomic_file(
            contestants_dir,
            &[&contestant],
            &target_source_name,
            &staged_bytes,
        ) {
            preserve_rejected_bytes(osd_dir, &file_name, &staged_bytes);
            if enable_log {
                let _ = write_osd_error_log(
                    osd_dir,
                    &file_name,
                    &contestant,
                    &problem,
                    &ext,
                    "Lỗi hệ thống chấm",
                    &err,
                );
            }
            state.osd.emit_event(
                "osd_error",
                serde_json::json!({ "fileName": file_name, "message": err }),
            );
            let _ = dispose_claimed_source(&claimed);
            continue;
        }

        let seq = OSD_JOB_COUNTER.fetch_add(1, Ordering::Relaxed);
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let job = OsdJob {
            id: format!("osd_{}_{seq}", uuid::Uuid::new_v4()),
            original_file_name: file_name,
            contestant: contestant.clone(),
            problem: problem.clone(),
            language,
            ext,
            received_at: now_ms,
        };

        let status_snapshot = {
            let mut guard = state.osd.inner.lock().unwrap_or_else(|e| e.into_inner());
            let problem_configs = guard.problem_configs.clone();
            guard
                .latest_jobs
                .insert((contestant, problem), job.id.clone());
            guard.queue.push_back(QueuedOsdSubmission {
                job: job.clone(),
                claimed,
                staged,
                osd_dir: osd_dir.to_path_buf(),
                test_dir: test_dir.to_path_buf(),
                enable_log,
                problem_configs,
            });
            guard.status.queue_length = guard.queue.len();
            guard.status.clone()
        };

        state.osd.emit_event(
            "osd_job_queued",
            serde_json::json!({
                "job": job,
                "queueLength": status_snapshot.queue_length,
            }),
        );
        if let Ok(val) = serde_json::to_value(&status_snapshot) {
            state.osd.emit_event("osd_status", val);
        }
        ensure_osd_queue_worker_spawned(state.clone());
    }
}

fn merge_problem_config(
    stored: Option<serde_json::Value>,
    override_cfg: Option<&serde_json::Value>,
) -> Option<serde_json::Value> {
    match (stored, override_cfg) {
        (Some(mut base), Some(over)) => {
            if let (Some(base_obj), Some(over_obj)) = (base.as_object_mut(), over.as_object()) {
                for (k, v) in over_obj {
                    base_obj.insert(k.clone(), v.clone());
                }
                Some(base)
            } else {
                Some(over.clone())
            }
        }
        (Some(base), None) => Some(base),
        (None, Some(over)) => Some(over.clone()),
        (None, None) => None,
    }
}

fn is_latest_job_for_pair(state: &crate::server::state::AppState, job: &OsdJob) -> bool {
    let guard = state.osd.inner.lock().unwrap_or_else(|e| e.into_inner());
    guard
        .latest_jobs
        .get(&(job.contestant.clone(), job.problem.clone()))
        .is_some_and(|id| id == &job.id)
}

async fn process_osd_queue(state: &crate::server::state::AppState) {
    loop {
        if state.lifecycle_phase() != ServerLifecyclePhase::Running {
            let drained: Vec<QueuedOsdSubmission> = {
                let mut guard = state.osd.inner.lock().unwrap_or_else(|e| e.into_inner());
                let items = guard.queue.drain(..).collect();
                guard.status.queue_length = 0;
                guard.worker_running = false;
                items
            };
            for item in drained {
                let _ = dispose_claimed_source(&item.claimed);
            }
            break;
        }

        let next_item = {
            let mut guard = state.osd.inner.lock().unwrap_or_else(|e| e.into_inner());
            if guard.status.paused || guard.status.current_job.is_some() {
                guard.worker_running = false;
                None
            } else if let Some(item) = guard.queue.pop_front() {
                guard.status.current_job = Some(item.job.clone());
                guard.status.queue_length = guard.queue.len();
                Some((item, guard.status.clone()))
            } else {
                guard.worker_running = false;
                None
            }
        };

        let Some((item, started_status)) = next_item else {
            break;
        };

        state.osd.emit_event(
            "osd_job_started",
            serde_json::json!({ "job": item.job.clone() }),
        );
        if let Ok(val) = serde_json::to_value(&started_status) {
            state.osd.emit_event("osd_status", val);
        }

        let job_outcome: Result<crate::engine::session::ProblemResultData, String> = async {
            verify_claimed_source_integrity(&item.staged)?;
            let staged_bytes = fs::read(&item.staged.staged_path)
                .map_err(|e| format!("OSD_STAGED_READ_FAILED: {e}"))?;

            let prob_dir = resolve_problem_directory_path(item.test_dir.join(&item.job.problem));
            let merged_cfg = merge_problem_config(
                read_stored_problem_config(&prob_dir),
                item.problem_configs.get(&item.job.problem),
            );
            let is_interactive = merged_cfg
                .as_ref()
                .and_then(|c| c.get("isInteractive"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            if is_interactive {
                return Err(format!(
                    "OSD_INTERACTIVE_UNSUPPORTED: bài '{}' là bài tương tác, chưa hỗ trợ chấm tự động qua OSD.",
                    item.job.problem
                ));
            }
            let discovered = discover_test_cases(&prob_dir, false);
            if discovered.is_empty() {
                return Err(format!(
                    "OSD_NO_TESTCASES: không tìm thấy bộ test cho bài '{}'.",
                    item.job.problem
                ));
            }

            let lease = match state.admit_judge_job(Some(&item.job.id)) {
                JobAdmissionResult::Admitted(l) => l,
                JobAdmissionResult::Rejected { message, .. } => return Err(message),
            };

            let job_workspace = OwnedWorkspace::create_in_temp("osd_job")?;
            let rel_source = PathBuf::from(&item.job.contestant)
                .join(format!("{}{}", item.job.problem, item.job.ext));
            job_workspace.write_file(&rel_source, &staged_bytes)?;

            let mut problem_configs = HashMap::new();
            if let Some(cfg) = merged_cfg {
                problem_configs.insert(item.job.problem.clone(), cfg);
            }

            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
            let app_data_dir = state
                .toolchains
                .read()
                .ok()
                .and_then(|g| g.app_data_dir.clone());
            let toolchain_selections = state
                .toolchains
                .read()
                .ok()
                .map(|g| g.selections.clone())
                .unwrap_or_default();

            let session_config = JudgeSessionConfig {
                thisinh_path: job_workspace.root().to_path_buf(),
                test_path: item.test_dir.clone(),
                job_id: item.job.id.clone(),
                target_contestants: vec![item.job.contestant.clone()],
                target_problems: vec![item.job.problem.clone()],
                problem_configs,
                app_data_dir,
                toolchain_selections,
                cancel_flag: lease.cancel_flag(),
                platform: Arc::clone(&state.platform),
            };

            let rt_handle = tokio::runtime::Handle::current();
            let join_res = tokio::task::spawn_blocking(move || {
                rt_handle.block_on(run_judge_session(session_config, tx));
            })
            .await;
            drop(lease);
            drop(job_workspace);

            if let Err(e) = join_res {
                return Err(format!("OSD_JUDGE_TASK_FAILED: {e}"));
            }

            let mut completed_opt: Option<crate::engine::session::ProblemResultData> = None;
            let mut stream_err: Option<String> = None;
            while let Some(ev) = rx.recv().await {
                match ev {
                    JudgeStreamEvent::ProblemCompleted(completed) => {
                        completed_opt = Some(completed.problem_result);
                    }
                    JudgeStreamEvent::Error { message } => {
                        stream_err = Some(message);
                    }
                    _ => {}
                }
            }

            if let Some(err_msg) = stream_err {
                return Err(err_msg);
            }
            completed_opt.ok_or_else(|| "OSD_JUDGE_NO_RESULT".to_string())
        }
        .await;

        let is_latest = is_latest_job_for_pair(state, &item.job);
        match job_outcome {
            Ok(problem_result) => {
                let for_log = ProblemResultForLog {
                    problem_name: problem_result.problem_name.clone(),
                    compile_status: problem_result.compile_status.clone(),
                    compile_error: problem_result.compile_error.clone(),
                    test_cases: problem_result.test_cases.clone(),
                    summary: problem_result.summary.clone(),
                };
                let has_je_or_fail = for_log.summary.status == "JE"
                    || for_log.summary.status == "FAIL"
                    || for_log
                        .test_cases
                        .iter()
                        .any(|tc| tc.status == "JE" || tc.status == "FAIL");
                if is_latest && item.enable_log {
                    let _ = write_osd_log(&item.osd_dir, &item.job, &for_log);
                }
                if has_je_or_fail {
                    state.osd.emit_event(
                        "osd_job_failed",
                        serde_json::json!({
                            "job": item.job.clone(),
                            "message": "Judge infrastructure error (JE/FAIL)",
                        }),
                    );
                } else if is_latest {
                    state.osd.emit_event(
                        "osd_problem_completed",
                        serde_json::json!({
                            "contestant": item.job.contestant.clone(),
                            "problemResult": problem_result,
                            "originalFileName": item.job.original_file_name.clone(),
                        }),
                    );
                }
            }
            Err(err_msg) => {
                if is_latest && item.enable_log {
                    let _ = write_osd_error_log(
                        &item.osd_dir,
                        &item.job.original_file_name,
                        &item.job.contestant,
                        &item.job.problem,
                        &item.job.ext,
                        "Lỗi hệ thống chấm",
                        &err_msg,
                    );
                }
                state.osd.emit_event(
                    "osd_job_failed",
                    serde_json::json!({
                        "job": item.job.clone(),
                        "message": err_msg,
                    }),
                );
            }
        }

        let _ = dispose_claimed_source(&item.claimed);

        let finished_status = {
            let mut guard = state.osd.inner.lock().unwrap_or_else(|e| e.into_inner());
            guard.status.current_job = None;
            guard.status.last_processed_job = Some(item.job);
            guard.status.total_processed = guard.status.total_processed.saturating_add(1);
            guard.status.queue_length = guard.queue.len();
            if guard.queue.is_empty() {
                guard.worker_running = false;
            }
            guard.status.clone()
        };
        if let Ok(val) = serde_json::to_value(&finished_status) {
            state.osd.emit_event("osd_status", val);
        }
    }
}
