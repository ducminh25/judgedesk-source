use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;

use serde::Serialize;

use crate::build_metadata::{BuildMetadata, BUILD_METADATA};

pub const MAX_LOG_MESSAGE_BYTES: usize = 4096;

/// Redacts sensitive tokens, session credentials, environment secrets, and caller-supplied canaries
/// from diagnostic or log strings, and bounds the result on a valid UTF-8 character boundary.
pub fn redact_sensitive_text(raw: &str, extra_secrets: &[&str]) -> String {
    let mut sanitized = raw.to_string();

    for secret in extra_secrets {
        let trimmed = secret.trim();
        if !trimmed.is_empty() {
            sanitized = sanitized.replace(trimmed, "[REDACTED]");
        }
    }

    sanitized = redact_64_hex_tokens(&sanitized);

    for prefix in [
        "X-JudgeDesk-Session:",
        "x-judgedesk-session:",
        "JUDGEDESK_API_TOKEN=",
        "JUDGEDESK_BOOTSTRAP_TOKEN=",
        "JUDGEDESK_TOOLCHAIN_SIGNING_PRIVATE_KEY=",
    ] {
        sanitized = redact_prefixed_token(&sanitized, prefix);
    }

    truncate_utf8_bounded(&sanitized, MAX_LOG_MESSAGE_BYTES)
}

fn is_64_hex(bytes: &[u8]) -> bool {
    bytes.len() == 64 && bytes.iter().all(|b| b.is_ascii_hexdigit())
}

fn is_hex_boundary_byte(b: u8) -> bool {
    !b.is_ascii_alphanumeric() && b != b'_'
}

fn redact_64_hex_tokens(input: &str) -> String {
    let bytes = input.as_bytes();
    if bytes.len() < 64 {
        return input.to_string();
    }
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < bytes.len() {
        if i + 64 <= bytes.len()
            && is_64_hex(&bytes[i..i + 64])
            && (i == 0 || is_hex_boundary_byte(bytes[i - 1]))
            && (i + 64 == bytes.len() || is_hex_boundary_byte(bytes[i + 64]))
        {
            out.push_str("[REDACTED_TOKEN]");
            i += 64;
        } else if let Some(ch) = input[i..].chars().next() {
            out.push(ch);
            i += ch.len_utf8();
        } else {
            break;
        }
    }
    out
}

fn redact_prefixed_token(input: &str, prefix: &str) -> String {
    let mut result = String::with_capacity(input.len());
    let mut remaining = input;
    while let Some(pos) = remaining.find(prefix) {
        result.push_str(&remaining[..pos]);
        result.push_str(prefix);
        let after = &remaining[pos + prefix.len()..];
        let leading_ws_len = after.len() - after.trim_start_matches(' ').len();
        if leading_ws_len > 0 {
            result.push(' ');
        }
        let value_start = &after[leading_ws_len..];
        if let Some(quote) = value_start
            .chars()
            .next()
            .filter(|&c| c == '"' || c == '\'')
        {
            let inner = &value_start[quote.len_utf8()..];
            let end_rel = inner
                .find(quote)
                .map(|p| p + quote.len_utf8())
                .unwrap_or(inner.len());
            result.push_str("[REDACTED]");
            remaining = &inner[end_rel..];
        } else {
            let token_len = value_start
                .find(|c: char| c.is_whitespace() || matches!(c, ',' | ';' | '"' | '\''))
                .unwrap_or(value_start.len());
            result.push_str("[REDACTED]");
            remaining = &value_start[token_len..];
        }
    }
    result.push_str(remaining);
    result
}

fn truncate_utf8_bounded(s: &str, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        return s.to_string();
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}...[TRUNCATED]", &s[..end])
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuredLogEvent {
    pub timestamp: String,
    pub level: &'static str,
    pub code: &'static str,
    pub phase: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub job_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub executor_mode: Option<String>,
    pub build: &'static BuildMetadata,
    pub message: String,
}

impl StructuredLogEvent {
    pub fn new(
        level: &'static str,
        code: &'static str,
        phase: &'static str,
        raw_message: &str,
        extra_secrets: &[&str],
    ) -> Self {
        Self {
            timestamp: chrono::Utc::now().to_rfc3339(),
            level,
            code,
            phase,
            request_id: None,
            job_id: None,
            run_id: None,
            executor_mode: None,
            build: &BUILD_METADATA,
            message: redact_sensitive_text(raw_message, extra_secrets),
        }
    }

    pub fn with_correlation(
        mut self,
        request_id: Option<&str>,
        job_id: Option<&str>,
        run_id: Option<&str>,
        executor_mode: Option<&str>,
    ) -> Self {
        self.request_id = request_id.map(str::to_string);
        self.job_id = job_id.map(str::to_string);
        self.run_id = run_id.map(str::to_string);
        self.executor_mode = executor_mode.map(str::to_string);
        self
    }

    pub fn to_json_line(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| {
            "{\"level\":\"ERROR\",\"code\":\"LOG_SERIALIZATION_ERROR\",\"message\":\"[REDACTED]\"}"
                .to_string()
        })
    }
}

#[derive(Clone, Debug)]
pub struct BoundedRotatingLog {
    path: PathBuf,
    max_bytes: u64,
}

impl BoundedRotatingLog {
    pub fn new(path: PathBuf, max_bytes: u64) -> Self {
        Self {
            path,
            max_bytes: max_bytes.max(256),
        }
    }

    pub fn rotated_backup_path(&self) -> PathBuf {
        let mut p = self.path.as_os_str().to_os_string();
        p.push(".1");
        PathBuf::from(p)
    }

    pub fn append(&self, event: &StructuredLogEvent) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create log directory {}: {e}", parent.display()))?;
        }

        let line = format!("{}\n", event.to_json_line());
        let current_len = fs::metadata(&self.path).map(|m| m.len()).unwrap_or(0);
        if current_len > 0 && current_len.saturating_add(line.len() as u64) > self.max_bytes {
            let backup = self.rotated_backup_path();
            let _ = fs::remove_file(&backup);
            fs::rename(&self.path, &backup)
                .map_err(|e| format!("Failed to rotate log file {}: {e}", self.path.display()))?;
        }

        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .map_err(|e| format!("Failed to open log file {}: {e}", self.path.display()))?;
        file.write_all(line.as_bytes())
            .map_err(|e| format!("Failed to write log file {}: {e}", self.path.display()))?;
        Ok(())
    }
}
