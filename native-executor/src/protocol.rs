use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::{self, Read, Write};

pub const MAX_FRAME_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ExecutorRequest {
    Health {
        id: String,
    },
    Run {
        id: String,
        spec: Box<RunSpec>,
    },
    Cancel {
        id: String,
        #[serde(rename = "runId")]
        run_id: String,
    },
    Shutdown {
        id: String,
    },
}

impl ExecutorRequest {
    pub fn id(&self) -> &str {
        match self {
            Self::Health { id }
            | Self::Run { id, .. }
            | Self::Cancel { id, .. }
            | Self::Shutdown { id } => id,
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RunRole {
    Submission,
    Compiler,
    Checker,
    CheckerRuntime,
    SecurityProbe,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ToolchainGrantRole {
    Compiler,
    SubmissionRuntime,
    CheckerRuntime,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ToolchainGrant {
    pub package_id: String,
    pub package_digest: String,
    pub component_id: String,
    pub role: ToolchainGrantRole,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum LocalToolchainIsolation {
    Strict,
    ResourceOnly,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalToolchainGrant {
    pub root_path: String,
    pub executable_relative_path: String,
    pub isolation: LocalToolchainIsolation,
    pub role: ToolchainGrantRole,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSpec {
    pub run_id: String,
    pub role: RunRole,
    pub workspace_id: String,
    pub executable_id: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub stdin_file: Option<String>,
    pub stdout_file: String,
    pub stderr_file: String,
    #[serde(default)]
    pub environment: BTreeMap<String, String>,
    #[serde(default)]
    pub toolchain: Option<ToolchainGrant>,
    #[serde(default)]
    pub local_toolchain: Option<LocalToolchainGrant>,
    pub limits: RunLimits,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunLimits {
    pub wall_time_ms: u64,
    pub memory_bytes: u64,
    pub process_count: u32,
    pub thread_count: u32,
    pub output_bytes: u64,
    pub total_write_bytes: u64,
    pub open_files: u32,
    pub created_files: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunReason {
    Exited,
    WallTimeLimit,
    MemoryLimit,
    ProcessLimit,
    ThreadLimit,
    OutputLimit,
    WriteLimit,
    Cancelled,
    SandboxDenied,
    LaunchError,
    InternalError,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunResult {
    pub run_id: String,
    pub reason: RunReason,
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signal_or_status: Option<String>,
    pub security_setup_time_us: u64,
    pub wall_time_us: u64,
    pub result_collection_time_us: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_cpu_time_us: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kernel_cpu_time_us: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub peak_memory_bytes: Option<u64>,
    pub stdout_bytes: u64,
    pub stderr_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_files: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostic: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutorStartupTimings {
    pub total_time_us: u64,
    pub phases: BTreeMap<String, u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutorHealth {
    pub ready: bool,
    pub mode: String,
    pub executor_version: String,
    pub executor_root: String,
    pub diagnostics: Vec<String>,
    pub network_blocked: bool,
    pub filesystem_isolated: bool,
    pub process_tree_controlled: bool,
    pub memory_limit_supported: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub startup_timings: Option<ExecutorStartupTimings>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ExecutorResponse {
    Health {
        id: String,
        health: ExecutorHealth,
    },
    RunResult {
        id: String,
        result: RunResult,
    },
    CancelResult {
        id: String,
        #[serde(rename = "runId")]
        run_id: String,
        cancelled: bool,
    },
    ShutdownResult {
        id: String,
    },
    Error {
        id: String,
        code: String,
        message: String,
    },
}

pub fn read_frame<R: Read>(reader: &mut R) -> io::Result<Option<Vec<u8>>> {
    let mut header = [0_u8; 4];
    let mut read = 0;
    while read < header.len() {
        match reader.read(&mut header[read..])? {
            0 if read == 0 => return Ok(None),
            0 => {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "truncated frame header",
                ))
            }
            amount => read += amount,
        }
    }
    let length = u32::from_le_bytes(header) as usize;
    if length == 0 || length > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid frame length",
        ));
    }
    let mut payload = vec![0_u8; length];
    reader.read_exact(&mut payload)?;
    Ok(Some(payload))
}

pub fn write_frame<W: Write>(writer: &mut W, response: &ExecutorResponse) -> io::Result<()> {
    let payload = serde_json::to_vec(response)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    if payload.len() > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "response frame is too large",
        ));
    }
    writer.write_all(&(payload.len() as u32).to_le_bytes())?;
    writer.write_all(&payload)?;
    writer.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn framed_protocol_round_trips_newlines_in_arguments() {
        let request = ExecutorRequest::Run {
            id: "request-1".into(),
            spec: Box::new(RunSpec {
                run_id: "run-1".into(),
                role: RunRole::Submission,
                workspace_id: "workspace-1".into(),
                executable_id: "workspaces/workspace-1/program".into(),
                args: vec!["line one\nline two".into()],
                stdin_file: None,
                stdout_file: "stdout.txt".into(),
                stderr_file: "stderr.txt".into(),
                environment: BTreeMap::new(),
                toolchain: None,
                local_toolchain: None,
                limits: RunLimits {
                    wall_time_ms: 1000,
                    memory_bytes: 64 * 1024 * 1024,
                    process_count: 1,
                    thread_count: 64,
                    output_bytes: 1024,
                    total_write_bytes: 2048,
                    open_files: 64,
                    created_files: 16,
                },
            }),
        };
        let payload = serde_json::to_vec(&request).unwrap();
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&payload);
        let decoded = read_frame(&mut bytes.as_slice()).unwrap().unwrap();
        let decoded: ExecutorRequest = serde_json::from_slice(&decoded).unwrap();
        match decoded {
            ExecutorRequest::Run { spec, .. } => assert_eq!(spec.args[0], "line one\nline two"),
            _ => panic!("wrong request variant"),
        }
    }

    #[test]
    fn framed_protocol_rejects_oversized_payloads() {
        let bytes = ((MAX_FRAME_BYTES + 1) as u32).to_le_bytes();
        assert_eq!(
            read_frame(&mut bytes.as_slice()).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
    }

    #[test]
    fn health_serializes_startup_timings_with_stable_camel_case_names() {
        let response = ExecutorResponse::Health {
            id: "health-1".into(),
            health: ExecutorHealth {
                ready: true,
                mode: "test".into(),
                executor_version: "1.0.0".into(),
                executor_root: "root".into(),
                diagnostics: Vec::new(),
                network_blocked: true,
                filesystem_isolated: true,
                process_tree_controlled: true,
                memory_limit_supported: true,
                startup_timings: Some(ExecutorStartupTimings {
                    total_time_us: 42,
                    phases: BTreeMap::from([("selfTest".into(), 7)]),
                }),
            },
        };

        let value = serde_json::to_value(response).unwrap();
        assert_eq!(value["health"]["startupTimings"]["totalTimeUs"], 42);
        assert_eq!(value["health"]["startupTimings"]["phases"]["selfTest"], 7);
    }
}
