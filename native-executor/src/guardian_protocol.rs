use crate::protocol::{RunResult, RunSpec};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fmt;
use std::io::{self, Read, Write};
use std::path::PathBuf;

pub const MACOS_RUN_GUARDIAN_ARGUMENT: &str = "--judgedesk-macos-run-guardian";
pub const MACOS_RUN_SUPERVISOR_ARGUMENT: &str = "--judgedesk-macos-run-supervisor";
pub const GUARDIAN_PROTOCOL_MAGIC: &str = "JUDGEDESK_RUN_GUARDIAN/2";

pub const GUARDIAN_TOKEN_ENV: &str = "JUDGEDESK_RUN_GUARDIAN_TOKEN";
pub const GUARDIAN_GENERATION_ENV: &str = "JUDGEDESK_RUN_GUARDIAN_GENERATION";
pub const GUARDIAN_RUN_ID_ENV: &str = "JUDGEDESK_RUN_GUARDIAN_RUN_ID";
pub const GUARDIAN_PARENT_PID_ENV: &str = "JUDGEDESK_RUN_GUARDIAN_PARENT_PID";
pub const GUARDIAN_ROOT_ENV: &str = "JUDGEDESK_RUN_GUARDIAN_ROOT";
pub const GUARDIAN_REGISTRATION_FD_ENV: &str = "JUDGEDESK_RUN_GUARDIAN_REGISTRATION_FD";

pub const SUPERVISOR_TOKEN_ENV: &str = "JUDGEDESK_RUN_SUPERVISOR_TOKEN";
pub const SUPERVISOR_GENERATION_ENV: &str = "JUDGEDESK_RUN_SUPERVISOR_GENERATION";
pub const SUPERVISOR_RUN_ID_ENV: &str = "JUDGEDESK_RUN_SUPERVISOR_RUN_ID";
pub const SUPERVISOR_GUARDIAN_PID_ENV: &str = "JUDGEDESK_RUN_SUPERVISOR_GUARDIAN_PID";
pub const SUPERVISOR_GUARDIAN_FD_ENV: &str = "JUDGEDESK_RUN_SUPERVISOR_GUARDIAN_FD";
pub const SUPERVISOR_DIRECT_FD_ENV: &str = "JUDGEDESK_RUN_SUPERVISOR_DIRECT_FD";

pub const MAX_GUARDIAN_FRAME_BYTES: usize = 1024 * 1024;
pub const NONCE_BYTES: usize = 32;
pub const NONCE_HEX_BYTES: usize = NONCE_BYTES * 2;
pub const MAX_RUN_ID_BYTES: usize = 96;
const MAX_FATAL_CODE_BYTES: usize = 96;
const MAX_FATAL_MESSAGE_BYTES: usize = 16 * 1024;

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FrameIdentity {
    pub protocol: String,
    pub token: String,
    pub generation: String,
    pub run_id: String,
}

impl FrameIdentity {
    pub fn new(token: String, generation: String, run_id: String) -> io::Result<Self> {
        let identity = Self {
            protocol: GUARDIAN_PROTOCOL_MAGIC.into(),
            token,
            generation,
            run_id,
        };
        identity.validate()?;
        Ok(identity)
    }

    pub fn validate(&self) -> io::Result<()> {
        if self.protocol != GUARDIAN_PROTOCOL_MAGIC {
            return Err(invalid_input("guardian protocol version is invalid"));
        }
        validate_nonce(&self.token)?;
        validate_nonce(&self.generation)?;
        validate_run_id(&self.run_id)
    }
}

impl fmt::Debug for FrameIdentity {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("FrameIdentity")
            .field("protocol", &self.protocol)
            .field("token", &"<redacted>")
            .field("generation", &self.generation)
            .field("run_id", &self.run_id)
            .finish()
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessIdentity {
    pub pid: i32,
    pub pgid: i32,
    pub start_abstime: u64,
}

impl ProcessIdentity {
    pub fn validate(&self) -> io::Result<()> {
        // Both 0 and 1 have special signalling semantics on POSIX. They are never
        // accepted as part of a trusted signalling identity.
        if self.pid > 1 && self.pgid > 1 && self.start_abstime > 0 {
            Ok(())
        } else {
            Err(invalid_input("guardian process identity is invalid"))
        }
    }
}

pub fn validate_supervisor_anchor(anchor: &ProcessIdentity) -> io::Result<()> {
    anchor.validate()?;
    if anchor.pid == anchor.pgid {
        Ok(())
    } else {
        Err(invalid_input(
            "run supervisor identity is not its process-group anchor",
        ))
    }
}

pub fn validate_target_identity(
    target: &ProcessIdentity,
    anchor: &ProcessIdentity,
) -> io::Result<()> {
    validate_supervisor_anchor(anchor)?;
    target.validate()?;
    if target.pid != anchor.pid && target.pgid == anchor.pgid {
        Ok(())
    } else {
        Err(invalid_input(
            "target identity is not a child in the supervisor process group",
        ))
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CleanupCause {
    Cancelled,
    Shutdown,
    ExecutorDisconnected,
    GuardianDisconnected,
    WallTimeLimit,
    MemoryLimit,
    ProcessLimit,
    ThreadLimit,
    OutputLimit,
    WriteLimit,
    SandboxDenied,
    TargetExited,
    LaunchFailed,
    ProtocolViolation,
    InternalError,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum GuardianCommand {
    #[serde(rename = "guardian_start")]
    Start {
        protocol: String,
        token: String,
        generation: String,
        #[serde(rename = "runId")]
        run_id: String,
        spec: Box<RunSpec>,
    },
    #[serde(rename = "guardian_commit")]
    Commit {
        protocol: String,
        token: String,
        generation: String,
        #[serde(rename = "runId")]
        run_id: String,
        anchor: ProcessIdentity,
    },
    #[serde(rename = "guardian_cancel")]
    Cancel {
        protocol: String,
        token: String,
        generation: String,
        #[serde(rename = "runId")]
        run_id: String,
        cause: CleanupCause,
    },
}

impl GuardianCommand {
    pub fn start(identity: &FrameIdentity, spec: RunSpec) -> Self {
        let identity = identity.clone();
        Self::Start {
            protocol: identity.protocol,
            token: identity.token,
            generation: identity.generation,
            run_id: identity.run_id,
            spec: Box::new(spec),
        }
    }

    pub fn commit(identity: &FrameIdentity, anchor: ProcessIdentity) -> Self {
        let identity = identity.clone();
        Self::Commit {
            protocol: identity.protocol,
            token: identity.token,
            generation: identity.generation,
            run_id: identity.run_id,
            anchor,
        }
    }

    pub fn cancel(identity: &FrameIdentity, cause: CleanupCause) -> Self {
        let identity = identity.clone();
        Self::Cancel {
            protocol: identity.protocol,
            token: identity.token,
            generation: identity.generation,
            run_id: identity.run_id,
            cause,
        }
    }

    pub const fn kind(&self) -> &'static str {
        match self {
            Self::Start { .. } => "guardian_start",
            Self::Commit { .. } => "guardian_commit",
            Self::Cancel { .. } => "guardian_cancel",
        }
    }
}

impl fmt::Debug for GuardianCommand {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        redacted_frame_debug(formatter, "GuardianCommand", self.kind(), self)
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum GuardianEvent {
    #[serde(rename = "guardian_ready")]
    Ready {
        protocol: String,
        token: String,
        generation: String,
        #[serde(rename = "runId")]
        run_id: String,
        guardian: ProcessIdentity,
    },
    #[serde(rename = "guardian_started")]
    Started {
        protocol: String,
        token: String,
        generation: String,
        #[serde(rename = "runId")]
        run_id: String,
        anchor: ProcessIdentity,
    },
    #[serde(rename = "guardian_target_started")]
    TargetStarted {
        protocol: String,
        token: String,
        generation: String,
        #[serde(rename = "runId")]
        run_id: String,
        anchor: ProcessIdentity,
        target: ProcessIdentity,
    },
    #[serde(rename = "guardian_cleanup_requested")]
    CleanupRequested {
        protocol: String,
        token: String,
        generation: String,
        #[serde(rename = "runId")]
        run_id: String,
        anchor: ProcessIdentity,
        cause: CleanupCause,
    },
    #[serde(rename = "guardian_prepared")]
    Prepared {
        protocol: String,
        token: String,
        generation: String,
        #[serde(rename = "runId")]
        run_id: String,
        anchor: ProcessIdentity,
        result: Box<RunResult>,
    },
    #[serde(rename = "guardian_fatal")]
    Fatal {
        protocol: String,
        token: String,
        generation: String,
        #[serde(rename = "runId")]
        run_id: String,
        code: String,
        message: String,
    },
}

impl GuardianEvent {
    pub fn ready(identity: &FrameIdentity, guardian: ProcessIdentity) -> Self {
        let identity = identity.clone();
        Self::Ready {
            protocol: identity.protocol,
            token: identity.token,
            generation: identity.generation,
            run_id: identity.run_id,
            guardian,
        }
    }

    pub fn started(identity: &FrameIdentity, anchor: ProcessIdentity) -> Self {
        let identity = identity.clone();
        Self::Started {
            protocol: identity.protocol,
            token: identity.token,
            generation: identity.generation,
            run_id: identity.run_id,
            anchor,
        }
    }

    pub fn target_started(
        identity: &FrameIdentity,
        anchor: ProcessIdentity,
        target: ProcessIdentity,
    ) -> Self {
        let identity = identity.clone();
        Self::TargetStarted {
            protocol: identity.protocol,
            token: identity.token,
            generation: identity.generation,
            run_id: identity.run_id,
            anchor,
            target,
        }
    }

    pub fn cleanup_requested(
        identity: &FrameIdentity,
        anchor: ProcessIdentity,
        cause: CleanupCause,
    ) -> Self {
        let identity = identity.clone();
        Self::CleanupRequested {
            protocol: identity.protocol,
            token: identity.token,
            generation: identity.generation,
            run_id: identity.run_id,
            anchor,
            cause,
        }
    }

    pub fn prepared(identity: &FrameIdentity, anchor: ProcessIdentity, result: RunResult) -> Self {
        let identity = identity.clone();
        Self::Prepared {
            protocol: identity.protocol,
            token: identity.token,
            generation: identity.generation,
            run_id: identity.run_id,
            anchor,
            result: Box::new(result),
        }
    }

    pub fn fatal(
        identity: &FrameIdentity,
        code: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        let identity = identity.clone();
        Self::Fatal {
            protocol: identity.protocol,
            token: identity.token,
            generation: identity.generation,
            run_id: identity.run_id,
            code: code.into(),
            message: message.into(),
        }
    }

    pub const fn kind(&self) -> &'static str {
        match self {
            Self::Ready { .. } => "guardian_ready",
            Self::Started { .. } => "guardian_started",
            Self::TargetStarted { .. } => "guardian_target_started",
            Self::CleanupRequested { .. } => "guardian_cleanup_requested",
            Self::Prepared { .. } => "guardian_prepared",
            Self::Fatal { .. } => "guardian_fatal",
        }
    }
}

impl fmt::Debug for GuardianEvent {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        redacted_frame_debug(formatter, "GuardianEvent", self.kind(), self)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LauncherSpec {
    pub sandbox_executable: PathBuf,
    pub sandbox_profile: PathBuf,
    pub target_executable: PathBuf,
    #[serde(default)]
    pub arguments: Vec<String>,
    pub cwd: PathBuf,
    pub stdin: PathBuf,
    pub stdout: PathBuf,
    pub stderr: PathBuf,
    #[serde(default)]
    pub environment: BTreeMap<String, String>,
    pub monitor_limits: LauncherMonitorLimits,
    pub limits: LauncherRlimits,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LauncherMonitorLimits {
    pub wall_time_ms: u64,
    pub memory_bytes: u64,
    pub process_count: u32,
    pub thread_count: u32,
    pub output_bytes: u64,
    pub total_write_bytes: u64,
    pub created_files: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LauncherRlimits {
    pub core_bytes: u64,
    pub file_size_bytes: u64,
    pub open_files: u64,
    pub nproc_ceiling: u64,
    pub address_space_bytes: Option<u64>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum SupervisorGuardianCommand {
    #[serde(rename = "supervisor_configure")]
    Configure {
        protocol: String,
        token: String,
        generation: String,
        #[serde(rename = "runId")]
        run_id: String,
        spec: Box<LauncherSpec>,
    },
    #[serde(rename = "supervisor_go")]
    Go {
        protocol: String,
        token: String,
        generation: String,
        #[serde(rename = "runId")]
        run_id: String,
        anchor: ProcessIdentity,
    },
    #[serde(rename = "supervisor_guardian_cleanup")]
    Cleanup {
        protocol: String,
        token: String,
        generation: String,
        #[serde(rename = "runId")]
        run_id: String,
        anchor: ProcessIdentity,
        cause: CleanupCause,
    },
}

impl SupervisorGuardianCommand {
    pub fn configure(identity: &FrameIdentity, spec: LauncherSpec) -> Self {
        let identity = identity.clone();
        Self::Configure {
            protocol: identity.protocol,
            token: identity.token,
            generation: identity.generation,
            run_id: identity.run_id,
            spec: Box::new(spec),
        }
    }

    pub fn go(identity: &FrameIdentity, anchor: ProcessIdentity) -> Self {
        let identity = identity.clone();
        Self::Go {
            protocol: identity.protocol,
            token: identity.token,
            generation: identity.generation,
            run_id: identity.run_id,
            anchor,
        }
    }

    pub fn cleanup(identity: &FrameIdentity, anchor: ProcessIdentity, cause: CleanupCause) -> Self {
        let identity = identity.clone();
        Self::Cleanup {
            protocol: identity.protocol,
            token: identity.token,
            generation: identity.generation,
            run_id: identity.run_id,
            anchor,
            cause,
        }
    }

    pub const fn kind(&self) -> &'static str {
        match self {
            Self::Configure { .. } => "supervisor_configure",
            Self::Go { .. } => "supervisor_go",
            Self::Cleanup { .. } => "supervisor_guardian_cleanup",
        }
    }
}

impl fmt::Debug for SupervisorGuardianCommand {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        redacted_frame_debug(formatter, "SupervisorGuardianCommand", self.kind(), self)
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum SupervisorDirectCommand {
    #[serde(rename = "supervisor_direct_commit")]
    Commit {
        protocol: String,
        token: String,
        generation: String,
        #[serde(rename = "runId")]
        run_id: String,
        anchor: ProcessIdentity,
    },
    #[serde(rename = "supervisor_direct_cleanup")]
    Cleanup {
        protocol: String,
        token: String,
        generation: String,
        #[serde(rename = "runId")]
        run_id: String,
        anchor: ProcessIdentity,
        cause: CleanupCause,
    },
}

impl SupervisorDirectCommand {
    pub fn commit(identity: &FrameIdentity, anchor: ProcessIdentity) -> Self {
        let identity = identity.clone();
        Self::Commit {
            protocol: identity.protocol,
            token: identity.token,
            generation: identity.generation,
            run_id: identity.run_id,
            anchor,
        }
    }

    pub fn cleanup(identity: &FrameIdentity, anchor: ProcessIdentity, cause: CleanupCause) -> Self {
        let identity = identity.clone();
        Self::Cleanup {
            protocol: identity.protocol,
            token: identity.token,
            generation: identity.generation,
            run_id: identity.run_id,
            anchor,
            cause,
        }
    }

    pub const fn kind(&self) -> &'static str {
        match self {
            Self::Commit { .. } => "supervisor_direct_commit",
            Self::Cleanup { .. } => "supervisor_direct_cleanup",
        }
    }
}

impl fmt::Debug for SupervisorDirectCommand {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        redacted_frame_debug(formatter, "SupervisorDirectCommand", self.kind(), self)
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum SupervisorEvent {
    #[serde(rename = "supervisor_registered")]
    Registered {
        protocol: String,
        token: String,
        generation: String,
        #[serde(rename = "runId")]
        run_id: String,
        anchor: ProcessIdentity,
    },
    #[serde(rename = "supervisor_ready")]
    Ready {
        protocol: String,
        token: String,
        generation: String,
        #[serde(rename = "runId")]
        run_id: String,
        anchor: ProcessIdentity,
    },
    #[serde(rename = "supervisor_target_started")]
    TargetStarted {
        protocol: String,
        token: String,
        generation: String,
        #[serde(rename = "runId")]
        run_id: String,
        anchor: ProcessIdentity,
        target: ProcessIdentity,
    },
    #[serde(rename = "supervisor_cleanup_requested")]
    CleanupRequested {
        protocol: String,
        token: String,
        generation: String,
        #[serde(rename = "runId")]
        run_id: String,
        anchor: ProcessIdentity,
        cause: CleanupCause,
    },
    #[serde(rename = "supervisor_prepared")]
    Prepared {
        protocol: String,
        token: String,
        generation: String,
        #[serde(rename = "runId")]
        run_id: String,
        anchor: ProcessIdentity,
        result: Box<RunResult>,
    },
    #[serde(rename = "supervisor_fatal")]
    Fatal {
        protocol: String,
        token: String,
        generation: String,
        #[serde(rename = "runId")]
        run_id: String,
        anchor: Option<ProcessIdentity>,
        code: String,
        message: String,
    },
}

impl SupervisorEvent {
    pub fn registered(identity: &FrameIdentity, anchor: ProcessIdentity) -> Self {
        let identity = identity.clone();
        Self::Registered {
            protocol: identity.protocol,
            token: identity.token,
            generation: identity.generation,
            run_id: identity.run_id,
            anchor,
        }
    }

    pub fn ready(identity: &FrameIdentity, anchor: ProcessIdentity) -> Self {
        let identity = identity.clone();
        Self::Ready {
            protocol: identity.protocol,
            token: identity.token,
            generation: identity.generation,
            run_id: identity.run_id,
            anchor,
        }
    }

    pub fn target_started(
        identity: &FrameIdentity,
        anchor: ProcessIdentity,
        target: ProcessIdentity,
    ) -> Self {
        let identity = identity.clone();
        Self::TargetStarted {
            protocol: identity.protocol,
            token: identity.token,
            generation: identity.generation,
            run_id: identity.run_id,
            anchor,
            target,
        }
    }

    pub fn cleanup_requested(
        identity: &FrameIdentity,
        anchor: ProcessIdentity,
        cause: CleanupCause,
    ) -> Self {
        let identity = identity.clone();
        Self::CleanupRequested {
            protocol: identity.protocol,
            token: identity.token,
            generation: identity.generation,
            run_id: identity.run_id,
            anchor,
            cause,
        }
    }

    pub fn prepared(identity: &FrameIdentity, anchor: ProcessIdentity, result: RunResult) -> Self {
        let identity = identity.clone();
        Self::Prepared {
            protocol: identity.protocol,
            token: identity.token,
            generation: identity.generation,
            run_id: identity.run_id,
            anchor,
            result: Box::new(result),
        }
    }

    pub fn fatal(
        identity: &FrameIdentity,
        anchor: Option<ProcessIdentity>,
        code: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        let identity = identity.clone();
        Self::Fatal {
            protocol: identity.protocol,
            token: identity.token,
            generation: identity.generation,
            run_id: identity.run_id,
            anchor,
            code: code.into(),
            message: message.into(),
        }
    }

    pub const fn kind(&self) -> &'static str {
        match self {
            Self::Registered { .. } => "supervisor_registered",
            Self::Ready { .. } => "supervisor_ready",
            Self::TargetStarted { .. } => "supervisor_target_started",
            Self::CleanupRequested { .. } => "supervisor_cleanup_requested",
            Self::Prepared { .. } => "supervisor_prepared",
            Self::Fatal { .. } => "supervisor_fatal",
        }
    }
}

impl fmt::Debug for SupervisorEvent {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        redacted_frame_debug(formatter, "SupervisorEvent", self.kind(), self)
    }
}

pub trait AuthenticatedFrame {
    fn protocol(&self) -> &str;
    fn token(&self) -> &str;
    fn generation(&self) -> &str;
    fn run_id(&self) -> &str;
    fn validate_payload(&self) -> io::Result<()>;
}

macro_rules! authenticated_accessors {
    ($type:ty, [$($variant:ident),+ $(,)?]) => {
        impl AuthenticatedFrame for $type {
            fn protocol(&self) -> &str {
                match self {
                    $(Self::$variant { protocol, .. } => protocol),+
                }
            }

            fn token(&self) -> &str {
                match self {
                    $(Self::$variant { token, .. } => token),+
                }
            }

            fn generation(&self) -> &str {
                match self {
                    $(Self::$variant { generation, .. } => generation),+
                }
            }

            fn run_id(&self) -> &str {
                match self {
                    $(Self::$variant { run_id, .. } => run_id),+
                }
            }

            fn validate_payload(&self) -> io::Result<()> {
                validate_payload(self)
            }
        }
    };
}

authenticated_accessors!(GuardianCommand, [Start, Commit, Cancel]);
authenticated_accessors!(
    GuardianEvent,
    [
        Ready,
        Started,
        TargetStarted,
        CleanupRequested,
        Prepared,
        Fatal
    ]
);
authenticated_accessors!(SupervisorGuardianCommand, [Configure, Go, Cleanup]);
authenticated_accessors!(SupervisorDirectCommand, [Commit, Cleanup]);
authenticated_accessors!(
    SupervisorEvent,
    [
        Registered,
        Ready,
        TargetStarted,
        CleanupRequested,
        Prepared,
        Fatal
    ]
);

trait PayloadValidation {
    fn validate_payload_inner(&self) -> io::Result<()>;
}

fn validate_payload(frame: &impl PayloadValidation) -> io::Result<()> {
    frame.validate_payload_inner()
}

impl PayloadValidation for GuardianCommand {
    fn validate_payload_inner(&self) -> io::Result<()> {
        match self {
            Self::Start { run_id, spec, .. } => validate_result_run_id(&spec.run_id, run_id),
            Self::Commit { anchor, .. } => validate_supervisor_anchor(anchor),
            Self::Cancel { .. } => Ok(()),
        }
    }
}

impl PayloadValidation for GuardianEvent {
    fn validate_payload_inner(&self) -> io::Result<()> {
        match self {
            Self::Ready { guardian, .. } => guardian.validate(),
            Self::Started { anchor, .. } | Self::CleanupRequested { anchor, .. } => {
                validate_supervisor_anchor(anchor)
            }
            Self::TargetStarted { anchor, target, .. } => validate_target_identity(target, anchor),
            Self::Prepared {
                run_id,
                anchor,
                result,
                ..
            } => {
                validate_supervisor_anchor(anchor)?;
                validate_result_run_id(&result.run_id, run_id)
            }
            Self::Fatal { code, message, .. } => validate_fatal(code, message),
        }
    }
}

impl PayloadValidation for SupervisorGuardianCommand {
    fn validate_payload_inner(&self) -> io::Result<()> {
        match self {
            Self::Configure { .. } => Ok(()),
            Self::Go { anchor, .. } | Self::Cleanup { anchor, .. } => {
                validate_supervisor_anchor(anchor)
            }
        }
    }
}

impl PayloadValidation for SupervisorDirectCommand {
    fn validate_payload_inner(&self) -> io::Result<()> {
        match self {
            Self::Commit { anchor, .. } | Self::Cleanup { anchor, .. } => {
                validate_supervisor_anchor(anchor)
            }
        }
    }
}

impl PayloadValidation for SupervisorEvent {
    fn validate_payload_inner(&self) -> io::Result<()> {
        match self {
            Self::Registered { anchor, .. }
            | Self::Ready { anchor, .. }
            | Self::CleanupRequested { anchor, .. } => validate_supervisor_anchor(anchor),
            Self::TargetStarted { anchor, target, .. } => validate_target_identity(target, anchor),
            Self::Prepared {
                run_id,
                anchor,
                result,
                ..
            } => {
                validate_supervisor_anchor(anchor)?;
                validate_result_run_id(&result.run_id, run_id)
            }
            Self::Fatal {
                anchor,
                code,
                message,
                ..
            } => {
                if let Some(anchor) = anchor {
                    validate_supervisor_anchor(anchor)?;
                }
                validate_fatal(code, message)
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CleanupDisposition {
    Recorded,
    AlreadyRequested,
}

#[derive(Debug, Default, Clone)]
pub struct CleanupLatch {
    cause: Option<CleanupCause>,
}

impl CleanupLatch {
    pub fn request(&mut self, cause: CleanupCause) -> CleanupDisposition {
        if self.cause.is_some() {
            CleanupDisposition::AlreadyRequested
        } else {
            self.cause = Some(cause);
            CleanupDisposition::Recorded
        }
    }

    pub const fn cause(&self) -> Option<CleanupCause> {
        self.cause
    }

    pub const fn is_requested(&self) -> bool {
        self.cause.is_some()
    }
}

#[derive(Debug, Default)]
pub struct SupervisorLaunchState {
    anchor: Option<ProcessIdentity>,
    registered: bool,
    ready: bool,
    direct_commit: bool,
    guardian_go: bool,
    target: Option<ProcessIdentity>,
    cleanup: CleanupLatch,
    prepared: bool,
}

impl SupervisorLaunchState {
    pub fn record_registered(&mut self, anchor: ProcessIdentity) -> io::Result<()> {
        validate_supervisor_anchor(&anchor)?;
        if self.registered {
            return Err(invalid_data("duplicate supervisor registration"));
        }
        self.anchor = Some(anchor);
        self.registered = true;
        Ok(())
    }

    pub fn record_ready(&mut self, anchor: ProcessIdentity) -> io::Result<()> {
        self.require_anchor(&anchor)?;
        if !self.registered {
            return Err(invalid_data("supervisor became ready before registration"));
        }
        if self.ready {
            return Err(invalid_data("duplicate supervisor ready transition"));
        }
        self.ready = true;
        Ok(())
    }

    pub fn record_direct_commit(&mut self, anchor: ProcessIdentity) -> io::Result<()> {
        self.require_ready_anchor(&anchor)?;
        if self.direct_commit {
            return Err(invalid_data("duplicate direct supervisor commit"));
        }
        self.direct_commit = true;
        Ok(())
    }

    pub fn record_guardian_go(&mut self, anchor: ProcessIdentity) -> io::Result<()> {
        self.require_ready_anchor(&anchor)?;
        if self.guardian_go {
            return Err(invalid_data("duplicate guardian GO"));
        }
        self.guardian_go = true;
        Ok(())
    }

    pub fn request_cleanup(&mut self, cause: CleanupCause) -> CleanupDisposition {
        self.cleanup.request(cause)
    }

    pub fn record_target_started(&mut self, target: ProcessIdentity) -> io::Result<()> {
        if !self.may_fork_target() {
            return Err(invalid_data(
                "target started before both ownership commits or after cleanup",
            ));
        }
        let anchor = self
            .anchor
            .ok_or_else(|| invalid_data("supervisor anchor is missing"))?;
        validate_target_identity(&target, &anchor)?;
        self.target = Some(target);
        Ok(())
    }

    pub fn record_prepared(&mut self) -> io::Result<()> {
        if !self.cleanup.is_requested() {
            return Err(invalid_data(
                "supervisor prepared a result before cleanup was requested",
            ));
        }
        if self.prepared {
            return Err(invalid_data("duplicate supervisor prepared transition"));
        }
        self.prepared = true;
        Ok(())
    }

    pub const fn may_fork_target(&self) -> bool {
        self.registered
            && self.ready
            && self.direct_commit
            && self.guardian_go
            && self.target.is_none()
            && !self.cleanup.is_requested()
            && !self.prepared
    }

    pub const fn anchor(&self) -> Option<ProcessIdentity> {
        self.anchor
    }

    pub const fn target(&self) -> Option<ProcessIdentity> {
        self.target
    }

    pub const fn cleanup_cause(&self) -> Option<CleanupCause> {
        self.cleanup.cause()
    }

    fn require_anchor(&self, actual: &ProcessIdentity) -> io::Result<()> {
        validate_supervisor_anchor(actual)?;
        let expected = self
            .anchor
            .as_ref()
            .ok_or_else(|| invalid_data("supervisor is not registered"))?;
        authenticate_process_identity(actual, expected)
    }

    fn require_ready_anchor(&self, actual: &ProcessIdentity) -> io::Result<()> {
        self.require_anchor(actual)?;
        if self.ready {
            Ok(())
        } else {
            Err(invalid_data(
                "supervisor ownership commit arrived before ready",
            ))
        }
    }
}

pub fn read_frame<R: Read, T: DeserializeOwned>(reader: &mut R) -> io::Result<Option<T>> {
    let mut header = [0_u8; 4];
    if !read_frame_header(reader, &mut header)? {
        return Ok(None);
    }

    let length = u32::from_le_bytes(header) as usize;
    if length == 0 || length > MAX_GUARDIAN_FRAME_BYTES {
        return Err(invalid_data("invalid guardian frame length"));
    }

    let mut payload = vec![0_u8; length];
    read_exact_retry(reader, &mut payload, "truncated guardian frame payload")?;
    serde_json::from_slice(&payload)
        .map(Some)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

pub fn read_authenticated_frame<R, T>(
    reader: &mut R,
    expected_identity: &FrameIdentity,
) -> io::Result<Option<T>>
where
    R: Read,
    T: DeserializeOwned + AuthenticatedFrame,
{
    match read_frame(reader)? {
        Some(frame) => {
            authenticate_frame(&frame, expected_identity)?;
            Ok(Some(frame))
        }
        None => Ok(None),
    }
}

pub fn write_frame<W: Write, T: Serialize>(writer: &mut W, frame: &T) -> io::Result<()> {
    let payload = serde_json::to_vec(frame)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    if payload.is_empty() || payload.len() > MAX_GUARDIAN_FRAME_BYTES {
        return Err(invalid_data("guardian frame exceeds its size limit"));
    }
    write_all_retry(writer, &(payload.len() as u32).to_le_bytes())?;
    write_all_retry(writer, &payload)?;
    flush_retry(writer)
}

pub fn write_authenticated_frame<W, T>(
    writer: &mut W,
    frame: &T,
    expected_identity: &FrameIdentity,
) -> io::Result<()>
where
    W: Write,
    T: Serialize + AuthenticatedFrame,
{
    authenticate_frame(frame, expected_identity)?;
    write_frame(writer, frame)
}

pub fn validate_nonce(value: &str) -> io::Result<()> {
    if value.len() == NONCE_HEX_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(())
    } else {
        Err(invalid_input("guardian nonce is invalid"))
    }
}

pub fn authenticate_token(actual: &str, expected: &str) -> io::Result<()> {
    let valid = validate_nonce(actual).is_ok()
        && validate_nonce(expected).is_ok()
        && constant_time_eq(actual.as_bytes(), expected.as_bytes());
    if valid {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "guardian frame authentication failed",
        ))
    }
}

pub fn validate_run_id(value: &str) -> io::Result<()> {
    if !value.is_empty()
        && value.len() <= MAX_RUN_ID_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        Ok(())
    } else {
        Err(invalid_input("guardian run ID is invalid"))
    }
}

pub fn authenticate_frame(
    frame: &impl AuthenticatedFrame,
    expected: &FrameIdentity,
) -> io::Result<()> {
    expected.validate()?;
    let valid = frame.protocol() == expected.protocol
        && frame.protocol() == GUARDIAN_PROTOCOL_MAGIC
        && validate_nonce(frame.token()).is_ok()
        && validate_nonce(frame.generation()).is_ok()
        && validate_run_id(frame.run_id()).is_ok()
        && constant_time_eq(frame.token().as_bytes(), expected.token.as_bytes())
        && constant_time_eq(
            frame.generation().as_bytes(),
            expected.generation.as_bytes(),
        )
        && constant_time_eq(frame.run_id().as_bytes(), expected.run_id.as_bytes());
    if !valid {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "guardian frame identity does not match",
        ));
    }
    frame.validate_payload()
}

pub fn authenticate_process_identity(
    actual: &ProcessIdentity,
    expected: &ProcessIdentity,
) -> io::Result<()> {
    actual.validate()?;
    expected.validate()?;
    if actual == expected {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "guardian process identity does not match",
        ))
    }
}

#[cfg(target_os = "macos")]
pub fn generate_nonce() -> io::Result<String> {
    let mut random = std::fs::File::open("/dev/urandom")?;
    let mut bytes = [0_u8; NONCE_BYTES];
    read_exact_retry(&mut random, &mut bytes, "truncated guardian random source")?;
    let mut nonce = String::with_capacity(NONCE_HEX_BYTES);
    use std::fmt::Write as _;
    for byte in bytes {
        write!(&mut nonce, "{byte:02x}")
            .map_err(|_| io::Error::other("cannot encode guardian nonce"))?;
    }
    Ok(nonce)
}

#[cfg(not(target_os = "macos"))]
pub fn generate_nonce() -> io::Result<String> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "guardian nonces are generated only by the macOS executor",
    ))
}

fn read_frame_header(reader: &mut impl Read, header: &mut [u8; 4]) -> io::Result<bool> {
    let mut offset = 0;
    while offset < header.len() {
        match reader.read(&mut header[offset..]) {
            Ok(0) if offset == 0 => return Ok(false),
            Ok(0) => return Err(unexpected_eof("truncated guardian frame header")),
            Ok(amount) => offset += amount,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
    Ok(true)
}

fn read_exact_retry(
    reader: &mut impl Read,
    buffer: &mut [u8],
    eof_message: &'static str,
) -> io::Result<()> {
    let mut offset = 0;
    while offset < buffer.len() {
        match reader.read(&mut buffer[offset..]) {
            Ok(0) => return Err(unexpected_eof(eof_message)),
            Ok(amount) => offset += amount,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

fn write_all_retry(writer: &mut impl Write, buffer: &[u8]) -> io::Result<()> {
    let mut offset = 0;
    while offset < buffer.len() {
        match writer.write(&buffer[offset..]) {
            Ok(0) => {
                return Err(io::Error::new(
                    io::ErrorKind::WriteZero,
                    "failed to write guardian frame",
                ))
            }
            Ok(amount) => offset += amount,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

fn flush_retry(writer: &mut impl Write) -> io::Result<()> {
    loop {
        match writer.flush() {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

fn validate_result_run_id(actual: &str, expected: &str) -> io::Result<()> {
    if actual == expected {
        Ok(())
    } else {
        Err(invalid_data(
            "guardian payload run ID does not match its frame identity",
        ))
    }
}

fn validate_fatal(code: &str, message: &str) -> io::Result<()> {
    let valid_code = !code.is_empty()
        && code.len() <= MAX_FATAL_CODE_BYTES
        && code
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_');
    if !valid_code {
        return Err(invalid_data("guardian fatal code is invalid"));
    }
    if message.is_empty() || message.len() > MAX_FATAL_MESSAGE_BYTES || message.contains('\0') {
        return Err(invalid_data("guardian fatal message is invalid"));
    }
    Ok(())
}

fn redacted_frame_debug(
    formatter: &mut fmt::Formatter<'_>,
    frame_type: &str,
    kind: &str,
    frame: &impl AuthenticatedFrame,
) -> fmt::Result {
    formatter
        .debug_struct(frame_type)
        .field("kind", &kind)
        .field("protocol", &frame.protocol())
        .field("token", &"<redacted>")
        .field("generation", &frame.generation())
        .field("run_id", &frame.run_id())
        .finish_non_exhaustive()
}

fn invalid_input(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

fn invalid_data(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

fn unexpected_eof(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::UnexpectedEof, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{RunLimits, RunReason, RunRole};
    use serde::Serialize;
    use std::io::Cursor;

    const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const GENERATION: &str = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
    const RUN_ID: &str = "run_42";

    fn encoded<T: Serialize>(frame: &T) -> Vec<u8> {
        let mut bytes = Vec::new();
        write_frame(&mut bytes, frame).expect("encode frame");
        bytes
    }

    fn authenticated_round_trip<T>(frame: &T)
    where
        T: Serialize + DeserializeOwned + AuthenticatedFrame,
    {
        let mut bytes = Cursor::new(encoded(frame));
        let decoded: T = read_authenticated_frame(&mut bytes, &identity())
            .expect("decode authenticated frame")
            .expect("one frame");
        authenticate_frame(&decoded, &identity()).expect("authenticate decoded frame");
    }

    #[test]
    fn process_identity_rejects_posix_special_values() {
        let valid = anchor();
        valid.validate().expect("valid process identity");
        for unsafe_identity in [
            ProcessIdentity { pid: -1, ..valid },
            ProcessIdentity { pid: 0, ..valid },
            ProcessIdentity { pid: 1, ..valid },
            ProcessIdentity { pgid: -1, ..valid },
            ProcessIdentity { pgid: 0, ..valid },
            ProcessIdentity { pgid: 1, ..valid },
            ProcessIdentity {
                start_abstime: 0,
                ..valid
            },
        ] {
            assert!(
                unsafe_identity.validate().is_err(),
                "accepted unsafe process identity {unsafe_identity:?}"
            );
        }
    }

    #[test]
    fn supervisor_anchor_and_target_relationship_is_exact() {
        validate_supervisor_anchor(&anchor()).expect("PID equals PGID");
        assert!(validate_supervisor_anchor(&ProcessIdentity {
            pgid: 12,
            ..anchor()
        })
        .is_err());
        validate_target_identity(&target(), &anchor()).expect("target shares anchor PGID");
        for invalid_target in [
            ProcessIdentity {
                pid: anchor().pid,
                ..target()
            },
            ProcessIdentity {
                pgid: 99,
                ..target()
            },
        ] {
            assert!(validate_target_identity(&invalid_target, &anchor()).is_err());
        }
    }

    #[test]
    fn every_channel_variant_round_trips_with_authenticated_payloads() {
        let expected = identity();
        for frame in [
            GuardianCommand::start(&expected, sample_run_spec()),
            GuardianCommand::commit(&expected, anchor()),
            GuardianCommand::cancel(&expected, CleanupCause::Cancelled),
        ] {
            authenticated_round_trip(&frame);
        }
        for frame in [
            GuardianEvent::ready(&expected, guardian()),
            GuardianEvent::started(&expected, anchor()),
            GuardianEvent::target_started(&expected, anchor(), target()),
            GuardianEvent::cleanup_requested(&expected, anchor(), CleanupCause::TargetExited),
            GuardianEvent::prepared(&expected, anchor(), sample_run_result()),
            GuardianEvent::fatal(&expected, "TEST_FAILURE", "test failure"),
        ] {
            authenticated_round_trip(&frame);
        }
        for frame in [
            SupervisorGuardianCommand::configure(&expected, sample_launcher_spec()),
            SupervisorGuardianCommand::go(&expected, anchor()),
            SupervisorGuardianCommand::cleanup(&expected, anchor(), CleanupCause::TargetExited),
        ] {
            authenticated_round_trip(&frame);
        }
        for frame in [
            SupervisorDirectCommand::commit(&expected, anchor()),
            SupervisorDirectCommand::cleanup(&expected, anchor(), CleanupCause::Cancelled),
        ] {
            authenticated_round_trip(&frame);
        }
        for frame in [
            SupervisorEvent::registered(&expected, anchor()),
            SupervisorEvent::ready(&expected, anchor()),
            SupervisorEvent::target_started(&expected, anchor(), target()),
            SupervisorEvent::cleanup_requested(&expected, anchor(), CleanupCause::TargetExited),
            SupervisorEvent::prepared(&expected, anchor(), sample_run_result()),
            SupervisorEvent::fatal(&expected, Some(anchor()), "TEST_FAILURE", "test failure"),
        ] {
            authenticated_round_trip(&frame);
        }
    }

    #[test]
    fn launcher_monitor_limits_are_strict_and_round_trip_without_policy_validation() {
        let spec = sample_launcher_spec();
        let value = serde_json::to_value(&spec).expect("serialize launcher spec");
        let monitor = &value["monitorLimits"];
        assert_eq!(monitor["wallTimeMs"], 1000);
        assert_eq!(monitor["memoryBytes"], 64 * 1024 * 1024);
        assert_eq!(monitor["processCount"], 1);
        assert_eq!(monitor["threadCount"], 16);
        assert_eq!(monitor["outputBytes"], 1024);
        assert_eq!(monitor["totalWriteBytes"], 2048);
        assert_eq!(monitor["createdFiles"], 16);
        let decoded: LauncherSpec =
            serde_json::from_value(value.clone()).expect("round-trip launcher monitor limits");
        assert_eq!(decoded, spec);

        let mut unknown = value;
        unknown["monitorLimits"]
            .as_object_mut()
            .expect("monitor limits object")
            .insert("futureLimit".into(), serde_json::json!(1));
        assert!(serde_json::from_value::<LauncherSpec>(unknown).is_err());

        let zero_limits = LauncherMonitorLimits {
            wall_time_ms: 0,
            memory_bytes: 0,
            process_count: 0,
            thread_count: 0,
            output_bytes: 0,
            total_write_bytes: 0,
            created_files: 0,
        };
        let decoded_zero: LauncherMonitorLimits = serde_json::from_value(
            serde_json::to_value(&zero_limits).expect("serialize zero monitor limits"),
        )
        .expect("protocol leaves zero validation to the supervisor");
        assert_eq!(decoded_zero, zero_limits);
    }

    #[test]
    fn valid_frames_are_rejected_on_every_wrong_command_channel() {
        let expected = identity();
        let guardian = encoded(&GuardianCommand::commit(&expected, anchor()));
        assert!(read_authenticated_frame::<_, SupervisorGuardianCommand>(
            &mut Cursor::new(&guardian),
            &expected,
        )
        .is_err());
        assert!(read_authenticated_frame::<_, SupervisorDirectCommand>(
            &mut Cursor::new(&guardian),
            &expected,
        )
        .is_err());

        let guardian_supervisor = encoded(&SupervisorGuardianCommand::go(&expected, anchor()));
        assert!(read_authenticated_frame::<_, GuardianCommand>(
            &mut Cursor::new(&guardian_supervisor),
            &expected,
        )
        .is_err());
        assert!(read_authenticated_frame::<_, SupervisorDirectCommand>(
            &mut Cursor::new(&guardian_supervisor),
            &expected,
        )
        .is_err());

        let direct = encoded(&SupervisorDirectCommand::commit(&expected, anchor()));
        assert!(read_authenticated_frame::<_, GuardianCommand>(
            &mut Cursor::new(&direct),
            &expected,
        )
        .is_err());
        assert!(read_authenticated_frame::<_, SupervisorGuardianCommand>(
            &mut Cursor::new(&direct),
            &expected,
        )
        .is_err());

        let event = encoded(&SupervisorEvent::registered(&expected, anchor()));
        assert!(
            read_authenticated_frame::<_, GuardianEvent>(&mut Cursor::new(&event), &expected,)
                .is_err()
        );
    }

    #[test]
    fn debug_output_never_exposes_authentication_tokens() {
        let expected = identity();
        let frames = [
            format!("{expected:?}"),
            format!("{:?}", GuardianCommand::start(&expected, sample_run_spec())),
            format!("{:?}", GuardianEvent::ready(&expected, guardian())),
            format!(
                "{:?}",
                SupervisorGuardianCommand::configure(&expected, sample_launcher_spec())
            ),
            format!("{:?}", SupervisorDirectCommand::commit(&expected, anchor())),
            format!("{:?}", SupervisorEvent::registered(&expected, anchor())),
        ];
        for debug in frames {
            assert!(
                !debug.contains(TOKEN),
                "secret leaked through Debug: {debug}"
            );
            assert!(debug.contains("<redacted>"));
        }
    }

    #[test]
    fn supervisor_requires_both_commits_before_target_fork() {
        let mut state = SupervisorLaunchState::default();
        state
            .record_registered(anchor())
            .expect("register supervisor");
        state.record_ready(anchor()).expect("ready supervisor");
        state
            .record_guardian_go(anchor())
            .expect("GO may arrive before the direct pipe is scheduled");
        assert!(!state.may_fork_target());
        state
            .record_direct_commit(anchor())
            .expect("direct ownership commit");
        assert!(state.may_fork_target());
        state
            .record_target_started(target())
            .expect("start target in supervisor group");
        assert!(!state.may_fork_target());
        assert_eq!(state.target(), Some(target()));
    }

    #[test]
    fn supervisor_state_rejects_early_stale_and_duplicate_transitions() {
        let mut state = SupervisorLaunchState::default();
        assert!(state.record_ready(anchor()).is_err());
        assert!(state.record_direct_commit(anchor()).is_err());
        assert!(state.record_guardian_go(anchor()).is_err());
        state
            .record_registered(anchor())
            .expect("register supervisor");
        assert!(state.record_registered(anchor()).is_err());
        assert!(state
            .record_ready(ProcessIdentity {
                start_abstime: anchor().start_abstime + 1,
                ..anchor()
            })
            .is_err());
        state.record_ready(anchor()).expect("ready supervisor");
        assert!(state.record_ready(anchor()).is_err());
        state.record_direct_commit(anchor()).expect("first commit");
        assert!(state.record_direct_commit(anchor()).is_err());
        state.record_guardian_go(anchor()).expect("first GO");
        assert!(state.record_guardian_go(anchor()).is_err());
    }

    #[test]
    fn cancel_and_cleanup_are_idempotent_and_first_cause_wins() {
        let mut latch = CleanupLatch::default();
        assert_eq!(
            latch.request(CleanupCause::Cancelled),
            CleanupDisposition::Recorded
        );
        assert_eq!(
            latch.request(CleanupCause::Cancelled),
            CleanupDisposition::AlreadyRequested
        );
        assert_eq!(
            latch.request(CleanupCause::GuardianDisconnected),
            CleanupDisposition::AlreadyRequested
        );
        assert_eq!(latch.cause(), Some(CleanupCause::Cancelled));

        let mut state = ready_state();
        assert!(state.may_fork_target());
        assert_eq!(
            state.request_cleanup(CleanupCause::Shutdown),
            CleanupDisposition::Recorded
        );
        assert!(!state.may_fork_target());
        assert_eq!(
            state.request_cleanup(CleanupCause::ExecutorDisconnected),
            CleanupDisposition::AlreadyRequested
        );
        assert_eq!(state.cleanup_cause(), Some(CleanupCause::Shutdown));
        state.record_prepared().expect("first prepared result");
        assert!(state.record_prepared().is_err());
    }

    #[test]
    fn semantic_validation_rejects_mismatched_payload_identities() {
        let expected = identity();
        let mismatched_run = GuardianCommand::start(
            &expected,
            RunSpec {
                run_id: "another_run".into(),
                ..sample_run_spec()
            },
        );
        assert!(authenticate_frame(&mismatched_run, &expected).is_err());

        let non_anchor = SupervisorEvent::registered(
            &expected,
            ProcessIdentity {
                pgid: 99,
                ..anchor()
            },
        );
        assert!(authenticate_frame(&non_anchor, &expected).is_err());

        let wrong_group = SupervisorEvent::target_started(
            &expected,
            anchor(),
            ProcessIdentity {
                pgid: 99,
                ..target()
            },
        );
        assert!(authenticate_frame(&wrong_group, &expected).is_err());
    }

    #[test]
    fn identity_authentication_rejects_every_stale_envelope_field() {
        let expected = identity();
        let stale_identities = [
            FrameIdentity {
                protocol: "JUDGEDESK_RUN_GUARDIAN/1".into(),
                ..expected.clone()
            },
            FrameIdentity {
                token: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff".into(),
                ..expected.clone()
            },
            FrameIdentity {
                generation: "1111111111111111111111111111111111111111111111111111111111111111"
                    .into(),
                ..expected.clone()
            },
            FrameIdentity {
                run_id: "stale_run".into(),
                ..expected.clone()
            },
        ];
        for stale in stale_identities {
            let frame = GuardianCommand::commit(&stale, anchor());
            assert_eq!(
                authenticate_frame(&frame, &expected)
                    .expect_err("stale envelope must fail")
                    .kind(),
                io::ErrorKind::PermissionDenied
            );
        }
    }

    #[test]
    fn parser_rejects_zero_oversized_truncated_and_unknown_frames() {
        assert!(read_frame::<_, serde_json::Value>(&mut Cursor::new(0_u32.to_le_bytes())).is_err());
        assert!(read_frame::<_, serde_json::Value>(&mut Cursor::new(
            ((MAX_GUARDIAN_FRAME_BYTES + 1) as u32).to_le_bytes()
        ))
        .is_err());

        let mut truncated_header = Cursor::new(vec![1, 0]);
        assert_eq!(
            read_frame::<_, serde_json::Value>(&mut truncated_header)
                .expect_err("partial header")
                .kind(),
            io::ErrorKind::UnexpectedEof
        );

        let mut truncated_payload = Vec::from(8_u32.to_le_bytes());
        truncated_payload.extend_from_slice(b"{}");
        assert_eq!(
            read_frame::<_, serde_json::Value>(&mut Cursor::new(truncated_payload))
                .expect_err("partial payload")
                .kind(),
            io::ErrorKind::UnexpectedEof
        );

        let mut unknown = serde_json::to_value(GuardianCommand::commit(&identity(), anchor()))
            .expect("frame JSON");
        unknown
            .as_object_mut()
            .expect("frame object")
            .insert("unexpected".into(), serde_json::json!(true));
        assert!(read_frame::<_, GuardianCommand>(&mut Cursor::new(encoded(&unknown))).is_err());

        let unknown_type = serde_json::json!({
            "type": "guardian_future",
            "protocol": GUARDIAN_PROTOCOL_MAGIC,
            "token": TOKEN,
            "generation": GENERATION,
            "runId": RUN_ID
        });
        assert!(
            read_frame::<_, GuardianCommand>(&mut Cursor::new(encoded(&unknown_type))).is_err()
        );
    }

    #[test]
    fn framing_retries_interrupted_header_payload_write_and_flush() {
        let frame = GuardianCommand::commit(&identity(), anchor());
        let expected = encoded(&frame);
        let mut interrupted_reader = InterruptingReader::new(expected.clone());
        let decoded: GuardianCommand =
            read_authenticated_frame(&mut interrupted_reader, &identity())
                .expect("interrupted reads are retried")
                .expect("one frame");
        assert_eq!(decoded.kind(), frame.kind());
        assert!(interrupted_reader.interruptions >= 2);

        let mut interrupted_writer = InterruptingWriter::default();
        write_frame(&mut interrupted_writer, &frame).expect("interrupted writes are retried");
        assert_eq!(interrupted_writer.bytes, expected);
        assert!(interrupted_writer.interruptions >= 2);
        assert!(interrupted_writer.flush_interruptions >= 1);
    }

    #[test]
    fn nonce_and_run_id_validation_are_canonical_and_bounded() {
        validate_nonce(TOKEN).expect("canonical lowercase nonce");
        for invalid in [
            "",
            "abc",
            "0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF",
            "g123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        ] {
            assert!(validate_nonce(invalid).is_err());
        }
        for valid in ["r", "run_42", "run-42"] {
            validate_run_id(valid).expect("canonical run ID");
        }
        for invalid in ["", "run 42", "run/42", &"r".repeat(MAX_RUN_ID_BYTES + 1)] {
            assert!(validate_run_id(invalid).is_err());
        }
    }

    fn identity() -> FrameIdentity {
        FrameIdentity::new(TOKEN.into(), GENERATION.into(), RUN_ID.into())
            .expect("valid frame identity")
    }

    fn guardian() -> ProcessIdentity {
        ProcessIdentity {
            pid: 10,
            pgid: 9,
            start_abstime: 100,
        }
    }

    fn anchor() -> ProcessIdentity {
        ProcessIdentity {
            pid: 11,
            pgid: 11,
            start_abstime: 123,
        }
    }

    fn target() -> ProcessIdentity {
        ProcessIdentity {
            pid: 12,
            pgid: 11,
            start_abstime: 456,
        }
    }

    fn ready_state() -> SupervisorLaunchState {
        let mut state = SupervisorLaunchState::default();
        state.record_registered(anchor()).expect("registered");
        state.record_ready(anchor()).expect("ready");
        state.record_direct_commit(anchor()).expect("direct commit");
        state.record_guardian_go(anchor()).expect("guardian GO");
        state
    }

    fn sample_run_spec() -> RunSpec {
        RunSpec {
            run_id: RUN_ID.into(),
            role: RunRole::Submission,
            workspace_id: "workspace".into(),
            executable_id: "workspaces/workspace/program".into(),
            args: Vec::new(),
            stdin_file: None,
            stdout_file: "stdout.txt".into(),
            stderr_file: "stderr.txt".into(),
            environment: BTreeMap::new(),
            toolchain: None,
            limits: RunLimits {
                wall_time_ms: 1000,
                memory_bytes: 64 * 1024 * 1024,
                process_count: 1,
                thread_count: 16,
                output_bytes: 1024,
                total_write_bytes: 2048,
                open_files: 32,
                created_files: 16,
            },
        }
    }

    fn sample_launcher_spec() -> LauncherSpec {
        LauncherSpec {
            sandbox_executable: "/usr/bin/sandbox-exec".into(),
            sandbox_profile: "/tmp/profile.sb".into(),
            target_executable: "/tmp/program".into(),
            arguments: Vec::new(),
            cwd: "/tmp".into(),
            stdin: "/dev/null".into(),
            stdout: "/tmp/stdout".into(),
            stderr: "/tmp/stderr".into(),
            environment: BTreeMap::new(),
            monitor_limits: LauncherMonitorLimits {
                wall_time_ms: 1000,
                memory_bytes: 64 * 1024 * 1024,
                process_count: 1,
                thread_count: 16,
                output_bytes: 1024,
                total_write_bytes: 2048,
                created_files: 16,
            },
            limits: LauncherRlimits {
                core_bytes: 0,
                file_size_bytes: 1024,
                open_files: 32,
                nproc_ceiling: 4,
                address_space_bytes: None,
            },
        }
    }

    fn sample_run_result() -> RunResult {
        RunResult {
            run_id: RUN_ID.into(),
            reason: RunReason::Exited,
            exit_code: Some(0),
            signal_or_status: None,
            security_setup_time_us: 0,
            wall_time_us: 1,
            result_collection_time_us: 0,
            user_cpu_time_us: None,
            kernel_cpu_time_us: None,
            peak_memory_bytes: None,
            stdout_bytes: 0,
            stderr_bytes: 0,
            created_files: Some(0),
            diagnostic: None,
        }
    }

    struct InterruptingReader {
        bytes: Cursor<Vec<u8>>,
        calls: usize,
        interruptions: usize,
    }

    impl InterruptingReader {
        fn new(bytes: Vec<u8>) -> Self {
            Self {
                bytes: Cursor::new(bytes),
                calls: 0,
                interruptions: 0,
            }
        }
    }

    impl Read for InterruptingReader {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            self.calls += 1;
            if self.calls % 2 == 1 {
                self.interruptions += 1;
                return Err(io::Error::new(io::ErrorKind::Interrupted, "test interrupt"));
            }
            let limit = buffer.len().min(3);
            self.bytes.read(&mut buffer[..limit])
        }
    }

    #[derive(Default)]
    struct InterruptingWriter {
        bytes: Vec<u8>,
        calls: usize,
        interruptions: usize,
        flush_calls: usize,
        flush_interruptions: usize,
    }

    impl Write for InterruptingWriter {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            self.calls += 1;
            if self.calls % 2 == 1 {
                self.interruptions += 1;
                return Err(io::Error::new(io::ErrorKind::Interrupted, "test interrupt"));
            }
            let amount = buffer.len().min(5);
            self.bytes.extend_from_slice(&buffer[..amount]);
            Ok(amount)
        }

        fn flush(&mut self) -> io::Result<()> {
            self.flush_calls += 1;
            if self.flush_calls == 1 {
                self.flush_interruptions += 1;
                Err(io::Error::new(
                    io::ErrorKind::Interrupted,
                    "test flush interrupt",
                ))
            } else {
                Ok(())
            }
        }
    }
}
