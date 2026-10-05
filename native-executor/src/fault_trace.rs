use crate::guardian_protocol::ProcessIdentity;
#[cfg(any(target_os = "macos", test))]
use crate::guardian_protocol::{validate_supervisor_anchor, validate_target_identity};
#[cfg(any(target_os = "macos", test))]
use serde::Serialize;

pub const FAULT_GATE_ENV: &str = "JUDGEDESK_RUN_GUARDIAN_FAULT_GATE";
pub const FAULT_EVENT_LOG_ENV: &str = "JUDGEDESK_RUN_GUARDIAN_EVENT_LOG";
pub const FAULT_TRACE_SCHEMA: &str = "JUDGEDESK_RUN_GUARDIAN_FAULT_GATE/2";
#[cfg(any(target_os = "macos", test))]
pub(crate) const INTERACTIVE_FAULT_PAUSE_ENV: &str = "JUDGEDESK_INTERACTIVE_FAULT_PAUSE";

#[cfg(any(target_os = "macos", test))]
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum InteractiveFaultPause {
    SecondConfigure,
    PairCommit,
    FirstSpool,
}

#[cfg(any(target_os = "macos", test))]
impl InteractiveFaultPause {
    #[cfg(target_os = "macos")]
    pub(crate) fn from_environment(traced: bool) -> Result<Option<Self>, String> {
        Self::parse(
            std::env::var_os(INTERACTIVE_FAULT_PAUSE_ENV).as_deref(),
            traced,
        )
    }

    fn parse(value: Option<&std::ffi::OsStr>, traced: bool) -> Result<Option<Self>, String> {
        let Some(value) = value else {
            return Ok(None);
        };
        if !traced {
            return Err("INTERACTIVE_FAULT_PAUSE_REQUIRES_VALIDATED_TRACE".into());
        }
        match value.to_str() {
            Some("second-configure") => Ok(Some(Self::SecondConfigure)),
            Some("pair-commit") => Ok(Some(Self::PairCommit)),
            Some("first-spool") => Ok(Some(Self::FirstSpool)),
            _ => Err("INTERACTIVE_FAULT_PAUSE_INVALID_STAGE".into()),
        }
    }
}

#[cfg(any(target_os = "macos", test))]
const MAX_RUN_ID_BYTES: usize = 96;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FaultTraceEvent {
    FaultGateReady,
    InteractiveSpoolCreated,
    InteractiveSecondConfigurePaused,
    InteractiveParticipantEnrolled,
    InteractivePairEnrolled,
    GuardianReady,
    SupervisorRegistered,
    SupervisorReady,
    GuardianStarted,
    ExecutorActiveCommitted,
    GuardianGo,
    TargetStarted,
    CleanupRequested,
    ExecutorFallbackDrainStarted,
    SupervisorPrepared,
    GroupDrained,
    GuardianCleaned,
}

impl FaultTraceEvent {
    /// A stable protocol milestone, not a record index. The physical JSONL append
    /// order is the only temporal ordering of trace records.
    pub const fn phase(self) -> u8 {
        match self {
            Self::FaultGateReady => 1,
            Self::InteractiveSpoolCreated => 5,
            Self::InteractiveSecondConfigurePaused => 23,
            Self::InteractiveParticipantEnrolled => 34,
            Self::InteractivePairEnrolled => 35,
            Self::GuardianReady => 10,
            Self::SupervisorRegistered => 20,
            Self::SupervisorReady => 25,
            Self::GuardianStarted => 30,
            Self::ExecutorActiveCommitted => 40,
            Self::GuardianGo => 50,
            Self::TargetStarted => 60,
            Self::CleanupRequested => 70,
            Self::ExecutorFallbackDrainStarted => 75,
            Self::SupervisorPrepared => 80,
            Self::GroupDrained => 90,
            Self::GuardianCleaned => 100,
        }
    }

    pub const fn name(self) -> &'static str {
        match self {
            Self::FaultGateReady => "fault_gate_ready",
            Self::InteractiveSpoolCreated => "interactive_spool_created",
            Self::InteractiveSecondConfigurePaused => "interactive_second_configure_paused",
            Self::InteractiveParticipantEnrolled => "interactive_participant_enrolled",
            Self::InteractivePairEnrolled => "interactive_pair_enrolled",
            Self::GuardianReady => "guardian_ready",
            Self::SupervisorRegistered => "supervisor_registered",
            Self::SupervisorReady => "supervisor_ready",
            Self::GuardianStarted => "guardian_started",
            Self::ExecutorActiveCommitted => "executor_active_committed",
            Self::GuardianGo => "guardian_go",
            Self::TargetStarted => "target_started",
            Self::CleanupRequested => "cleanup_requested",
            Self::ExecutorFallbackDrainStarted => "executor_fallback_drain_started",
            Self::SupervisorPrepared => "supervisor_prepared",
            Self::GroupDrained => "group_drained",
            Self::GuardianCleaned => "guardian_cleaned",
        }
    }

    #[cfg(any(target_os = "macos", test))]
    const fn identity_requirements(self) -> IdentityRequirements {
        match self {
            Self::FaultGateReady | Self::InteractiveSpoolCreated => IdentityRequirements::NONE,
            Self::InteractiveSecondConfigurePaused => IdentityRequirements::GUARDIAN_AND_ANCHOR,
            Self::InteractivePairEnrolled => IdentityRequirements::ANCHOR,
            Self::InteractiveParticipantEnrolled => IdentityRequirements::ANCHOR,
            Self::GuardianReady => IdentityRequirements::GUARDIAN,
            Self::SupervisorRegistered | Self::SupervisorReady => IdentityRequirements::ANCHOR,
            Self::GuardianStarted
            | Self::ExecutorActiveCommitted
            | Self::GuardianGo
            | Self::GuardianCleaned => IdentityRequirements::GUARDIAN_AND_ANCHOR,
            Self::TargetStarted => IdentityRequirements::ANCHOR_AND_TARGET,
            Self::CleanupRequested
            | Self::ExecutorFallbackDrainStarted
            | Self::SupervisorPrepared
            | Self::GroupDrained => IdentityRequirements::ANCHOR,
        }
    }
}

#[cfg(any(target_os = "macos", test))]
#[derive(Debug, Clone, Copy)]
struct IdentityRequirements {
    guardian: bool,
    anchor: bool,
    target: bool,
}

#[cfg(any(target_os = "macos", test))]
impl IdentityRequirements {
    const NONE: Self = Self {
        guardian: false,
        anchor: false,
        target: false,
    };
    const GUARDIAN: Self = Self {
        guardian: true,
        ..Self::NONE
    };
    const ANCHOR: Self = Self {
        anchor: true,
        ..Self::NONE
    };
    const GUARDIAN_AND_ANCHOR: Self = Self {
        guardian: true,
        anchor: true,
        target: false,
    };
    const ANCHOR_AND_TARGET: Self = Self {
        guardian: false,
        anchor: true,
        target: true,
    };
}

#[derive(Debug)]
pub struct FaultTrace {
    #[cfg(target_os = "macos")]
    generation: String,
    #[cfg(target_os = "macos")]
    file: std::sync::Mutex<std::fs::File>,
}

impl FaultTrace {
    #[cfg(target_os = "macos")]
    pub fn from_environment(expected_generation: &str) -> Result<Option<Self>, String> {
        use std::ffi::OsStr;
        use std::path::PathBuf;

        let enabled = std::env::var_os(FAULT_GATE_ENV);
        let path = std::env::var_os(FAULT_EVENT_LOG_ENV);
        if enabled.is_none() && path.is_none() {
            InteractiveFaultPause::from_environment(false)?;
            return Ok(None);
        }
        if enabled.as_deref() != Some(OsStr::new("1")) {
            return Err(if enabled.is_none() {
                "RUN_GUARDIAN_FAULT_TRACE_PARTIAL_ENVIRONMENT".into()
            } else {
                "RUN_GUARDIAN_FAULT_TRACE_INVALID_FLAG".into()
            });
        }
        let path = PathBuf::from(path.ok_or("RUN_GUARDIAN_FAULT_TRACE_EVENT_LOG_MISSING")?);
        if !path.is_absolute() {
            return Err("RUN_GUARDIAN_FAULT_TRACE_EVENT_LOG_NOT_ABSOLUTE".into());
        }
        validate_generation(expected_generation)?;
        let file = macos::open_existing_trace_file(&path)?;
        InteractiveFaultPause::from_environment(true)?;
        Ok(Some(Self {
            generation: expected_generation.into(),
            file: std::sync::Mutex::new(file),
        }))
    }

    #[cfg(not(target_os = "macos"))]
    pub fn from_environment(_expected_generation: &str) -> Result<Option<Self>, String> {
        Ok(None)
    }

    #[cfg(target_os = "macos")]
    pub fn emit(
        &self,
        event: FaultTraceEvent,
        run_id: &str,
        guardian: Option<ProcessIdentity>,
        anchor: Option<ProcessIdentity>,
        target: Option<ProcessIdentity>,
    ) -> Result<(), String> {
        use std::os::fd::AsRawFd;

        let mut payload =
            serialize_event(&self.generation, event, run_id, guardian, anchor, target)?;
        payload.push(b'\n');

        let mut file = self
            .file
            .lock()
            .map_err(|_| "RUN_GUARDIAN_FAULT_TRACE_MUTEX_POISONED".to_string())?;
        macos::flock(file.as_raw_fd(), libc::LOCK_EX)
            .map_err(|error| format!("RUN_GUARDIAN_FAULT_TRACE_LOCK_FAILED: {error}"))?;
        let write_result = write_all_retry(&mut *file, &payload)
            .and_then(|_| flush_retry(&mut *file))
            .map_err(|error| format!("RUN_GUARDIAN_FAULT_TRACE_WRITE_FAILED: {error}"));
        let unlock_result = macos::flock(file.as_raw_fd(), libc::LOCK_UN)
            .map_err(|error| format!("RUN_GUARDIAN_FAULT_TRACE_UNLOCK_FAILED: {error}"));
        write_result?;
        unlock_result
    }

    #[cfg(not(target_os = "macos"))]
    pub fn emit(
        &self,
        _event: FaultTraceEvent,
        _run_id: &str,
        _guardian: Option<ProcessIdentity>,
        _anchor: Option<ProcessIdentity>,
        _target: Option<ProcessIdentity>,
    ) -> Result<(), String> {
        Ok(())
    }
}

#[cfg(any(target_os = "macos", test))]
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TraceRecord<'a> {
    schema: &'static str,
    phase: u8,
    event: &'static str,
    run_id: &'a str,
    generation: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    guardian: Option<SerializableProcessIdentity>,
    #[serde(skip_serializing_if = "Option::is_none")]
    anchor: Option<SerializableProcessIdentity>,
    #[serde(skip_serializing_if = "Option::is_none")]
    target: Option<SerializableProcessIdentity>,
}

#[cfg(any(target_os = "macos", test))]
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SerializableProcessIdentity {
    pid: i32,
    pgid: i32,
    start_abstime: String,
}

#[cfg(any(target_os = "macos", test))]
impl From<ProcessIdentity> for SerializableProcessIdentity {
    fn from(identity: ProcessIdentity) -> Self {
        Self {
            pid: identity.pid,
            pgid: identity.pgid,
            start_abstime: identity.start_abstime.to_string(),
        }
    }
}

#[cfg(any(target_os = "macos", test))]
fn serialize_event(
    generation: &str,
    event: FaultTraceEvent,
    run_id: &str,
    guardian: Option<ProcessIdentity>,
    anchor: Option<ProcessIdentity>,
    target: Option<ProcessIdentity>,
) -> Result<Vec<u8>, String> {
    validate_generation(generation)?;
    validate_run_id(run_id)?;
    validate_identities(event, guardian, anchor, target)?;
    serde_json::to_vec(&TraceRecord {
        schema: FAULT_TRACE_SCHEMA,
        phase: event.phase(),
        event: event.name(),
        run_id,
        generation,
        guardian: guardian.map(Into::into),
        anchor: anchor.map(Into::into),
        target: target.map(Into::into),
    })
    .map_err(|error| format!("RUN_GUARDIAN_FAULT_TRACE_SERIALIZE_FAILED: {error}"))
}

#[cfg(any(target_os = "macos", test))]
fn validate_identities(
    event: FaultTraceEvent,
    guardian: Option<ProcessIdentity>,
    anchor: Option<ProcessIdentity>,
    target: Option<ProcessIdentity>,
) -> Result<(), String> {
    let required = event.identity_requirements();
    if required.guardian && guardian.is_none() {
        return Err("RUN_GUARDIAN_FAULT_TRACE_GUARDIAN_MISSING".into());
    }
    if required.anchor && anchor.is_none() {
        return Err("RUN_GUARDIAN_FAULT_TRACE_ANCHOR_MISSING".into());
    }
    if required.target && target.is_none() {
        return Err("RUN_GUARDIAN_FAULT_TRACE_TARGET_MISSING".into());
    }

    if let Some(identity) = guardian {
        identity
            .validate()
            .map_err(|error| format!("RUN_GUARDIAN_FAULT_TRACE_GUARDIAN_INVALID: {error}"))?;
    }
    if let Some(identity) = anchor {
        validate_supervisor_anchor(&identity)
            .map_err(|error| format!("RUN_GUARDIAN_FAULT_TRACE_ANCHOR_INVALID: {error}"))?;
    }
    if let Some(identity) = target {
        let anchor = anchor.ok_or("RUN_GUARDIAN_FAULT_TRACE_TARGET_WITHOUT_ANCHOR")?;
        validate_target_identity(&identity, &anchor)
            .map_err(|error| format!("RUN_GUARDIAN_FAULT_TRACE_TARGET_INVALID: {error}"))?;
    }
    Ok(())
}

#[cfg(any(target_os = "macos", test))]
fn validate_generation(generation: &str) -> Result<(), String> {
    if generation.len() == 64
        && generation
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(())
    } else {
        Err("RUN_GUARDIAN_FAULT_TRACE_GENERATION_INVALID".into())
    }
}

#[cfg(any(target_os = "macos", test))]
fn validate_run_id(run_id: &str) -> Result<(), String> {
    if !run_id.is_empty()
        && run_id.len() <= MAX_RUN_ID_BYTES
        && run_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        Ok(())
    } else {
        Err("RUN_GUARDIAN_FAULT_TRACE_RUN_ID_INVALID".into())
    }
}

#[cfg(target_os = "macos")]
fn write_all_retry(writer: &mut impl std::io::Write, buffer: &[u8]) -> std::io::Result<()> {
    use std::io;

    let mut offset = 0;
    while offset < buffer.len() {
        match writer.write(&buffer[offset..]) {
            Ok(0) => {
                return Err(io::Error::new(
                    io::ErrorKind::WriteZero,
                    "failed to append guardian fault trace",
                ))
            }
            Ok(amount) => offset += amount,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn flush_retry(writer: &mut impl std::io::Write) -> std::io::Result<()> {
    loop {
        match writer.flush() {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use std::fs::{File, OpenOptions};
    use std::io;
    use std::os::fd::{AsRawFd, RawFd};
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
    use std::path::Path;

    pub(super) fn open_existing_trace_file(path: &Path) -> Result<File, String> {
        let file = OpenOptions::new()
            .append(true)
            .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
            .open(path)
            .map_err(|error| format!("RUN_GUARDIAN_FAULT_TRACE_OPEN_FAILED: {error}"))?;
        let metadata = file
            .metadata()
            .map_err(|error| format!("RUN_GUARDIAN_FAULT_TRACE_METADATA_FAILED: {error}"))?;
        if !metadata.file_type().is_file()
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.permissions().mode() & 0o777 != 0o600
            || metadata.nlink() != 1
        {
            return Err("RUN_GUARDIAN_FAULT_TRACE_UNTRUSTED_FILE".into());
        }
        verify_descriptor_flags(&file)?;
        Ok(file)
    }

    fn verify_descriptor_flags(file: &File) -> Result<(), String> {
        let descriptor = file.as_raw_fd();
        let status_flags = unsafe { libc::fcntl(descriptor, libc::F_GETFL) };
        if status_flags < 0 {
            return Err(format!(
                "RUN_GUARDIAN_FAULT_TRACE_STATUS_FLAGS_FAILED: {}",
                io::Error::last_os_error()
            ));
        }
        let descriptor_flags = unsafe { libc::fcntl(descriptor, libc::F_GETFD) };
        if descriptor_flags < 0 {
            return Err(format!(
                "RUN_GUARDIAN_FAULT_TRACE_DESCRIPTOR_FLAGS_FAILED: {}",
                io::Error::last_os_error()
            ));
        }
        if status_flags & libc::O_APPEND == 0 || descriptor_flags & libc::FD_CLOEXEC == 0 {
            return Err("RUN_GUARDIAN_FAULT_TRACE_UNSAFE_DESCRIPTOR".into());
        }
        Ok(())
    }

    pub(super) fn flock(descriptor: RawFd, operation: libc::c_int) -> io::Result<()> {
        loop {
            if unsafe { libc::flock(descriptor, operation) } == 0 {
                return Ok(());
            }
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn interactive_pause_requires_trace_and_only_the_three_named_stages() {
        use super::InteractiveFaultPause;
        use std::ffi::OsStr;
        assert!(InteractiveFaultPause::parse(None, false).is_ok());
        for stage in ["second-configure", "pair-commit", "first-spool"] {
            assert!(InteractiveFaultPause::parse(Some(OsStr::new(stage)), false).is_err());
            assert!(InteractiveFaultPause::parse(Some(OsStr::new(stage)), true).is_ok());
        }
        for stage in ["", "unknown", "pair-commit/../command", "3"] {
            assert!(InteractiveFaultPause::parse(Some(OsStr::new(stage)), true).is_err());
        }
    }
    #[cfg(not(target_os = "macos"))]
    use super::FaultTrace;
    use super::{serialize_event, FaultTraceEvent, FAULT_TRACE_SCHEMA};
    use crate::guardian_protocol::ProcessIdentity;

    const GENERATION: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[test]
    fn phases_are_milestones_and_not_record_sequences() {
        let events = [
            (FaultTraceEvent::FaultGateReady, 1, "fault_gate_ready"),
            (FaultTraceEvent::GuardianReady, 10, "guardian_ready"),
            (
                FaultTraceEvent::SupervisorRegistered,
                20,
                "supervisor_registered",
            ),
            (FaultTraceEvent::SupervisorReady, 25, "supervisor_ready"),
            (FaultTraceEvent::GuardianStarted, 30, "guardian_started"),
            (
                FaultTraceEvent::ExecutorActiveCommitted,
                40,
                "executor_active_committed",
            ),
            (FaultTraceEvent::GuardianGo, 50, "guardian_go"),
            (FaultTraceEvent::TargetStarted, 60, "target_started"),
            (FaultTraceEvent::CleanupRequested, 70, "cleanup_requested"),
            (
                FaultTraceEvent::ExecutorFallbackDrainStarted,
                75,
                "executor_fallback_drain_started",
            ),
            (
                FaultTraceEvent::SupervisorPrepared,
                80,
                "supervisor_prepared",
            ),
            (FaultTraceEvent::GroupDrained, 90, "group_drained"),
            (FaultTraceEvent::GuardianCleaned, 100, "guardian_cleaned"),
        ];
        for (event, phase, name) in events {
            assert_eq!(event.phase(), phase);
            assert_eq!(event.name(), name);
        }
    }

    #[test]
    fn schema_v2_serializes_guardian_anchor_and_target_without_token_or_sequence() {
        let bytes = serialize_event(
            GENERATION,
            FaultTraceEvent::TargetStarted,
            "run_42",
            Some(guardian()),
            Some(anchor()),
            Some(target()),
        )
        .expect("serialize trace event");
        let text = String::from_utf8(bytes.clone()).expect("trace is UTF-8");
        let value: serde_json::Value = serde_json::from_slice(&bytes).expect("parse trace JSON");
        assert_eq!(value["schema"], FAULT_TRACE_SCHEMA);
        assert_eq!(value["phase"], 60);
        assert_eq!(value["event"], "target_started");
        assert_eq!(value["runId"], "run_42");
        assert_eq!(value["generation"], GENERATION);
        assert_eq!(value["guardian"]["pid"], guardian().pid);
        assert_eq!(value["anchor"]["pid"], anchor().pid);
        assert_eq!(value["anchor"]["pgid"], anchor().pgid);
        assert_eq!(value["target"]["pid"], target().pid);
        assert_eq!(value["target"]["pgid"], anchor().pgid);
        assert_eq!(value["target"]["startAbstime"], "345678");
        assert!(!text.contains("token"));
        assert!(!value
            .as_object()
            .expect("record object")
            .contains_key("sequence"));
    }

    #[test]
    fn physical_record_order_is_the_only_temporal_order() {
        let requested = serialize_event(
            GENERATION,
            FaultTraceEvent::CleanupRequested,
            "run_42",
            None,
            Some(anchor()),
            None,
        )
        .expect("cleanup record");
        let fallback = serialize_event(
            GENERATION,
            FaultTraceEvent::ExecutorFallbackDrainStarted,
            "run_42",
            None,
            Some(anchor()),
            None,
        )
        .expect("fallback record");
        let physical_jsonl = [requested, fallback]
            .into_iter()
            .map(|record| String::from_utf8(record).expect("UTF-8"))
            .collect::<Vec<_>>()
            .join("\n");
        let lines = physical_jsonl.lines().collect::<Vec<_>>();
        assert!(lines[0].contains("\"event\":\"cleanup_requested\""));
        assert!(lines[1].contains("\"event\":\"executor_fallback_drain_started\""));
    }

    #[test]
    fn event_identity_requirements_fail_closed() {
        assert!(serialize_event(
            GENERATION,
            FaultTraceEvent::GuardianReady,
            "run_42",
            None,
            None,
            None,
        )
        .expect_err("guardian is required")
        .contains("GUARDIAN_MISSING"));
        assert!(serialize_event(
            GENERATION,
            FaultTraceEvent::SupervisorRegistered,
            "run_42",
            None,
            None,
            None,
        )
        .expect_err("anchor is required")
        .contains("ANCHOR_MISSING"));
        assert!(serialize_event(
            GENERATION,
            FaultTraceEvent::TargetStarted,
            "run_42",
            None,
            Some(anchor()),
            None,
        )
        .expect_err("target is required")
        .contains("TARGET_MISSING"));
        assert!(serialize_event(
            GENERATION,
            FaultTraceEvent::TargetStarted,
            "run_42",
            None,
            Some(anchor()),
            Some(ProcessIdentity {
                pgid: 99,
                ..target()
            }),
        )
        .expect_err("target must share anchor PGID")
        .contains("TARGET_INVALID"));
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn non_macos_fault_trace_is_disabled() {
        assert!(FaultTrace::from_environment(GENERATION)
            .expect("non-macOS trace must be a no-op")
            .is_none());
    }

    fn guardian() -> ProcessIdentity {
        ProcessIdentity {
            pid: 41,
            pgid: 40,
            start_abstime: 123_456,
        }
    }

    fn anchor() -> ProcessIdentity {
        ProcessIdentity {
            pid: 42,
            pgid: 42,
            start_abstime: 234_567,
        }
    }

    fn target() -> ProcessIdentity {
        ProcessIdentity {
            pid: 43,
            pgid: 42,
            start_abstime: 345_678,
        }
    }

    #[cfg(target_os = "macos")]
    mod macos {
        use super::super::macos::open_existing_trace_file;
        use std::fs::{self, OpenOptions};
        use std::os::unix::fs::{symlink, OpenOptionsExt, PermissionsExt};
        use std::path::PathBuf;
        use std::sync::atomic::{AtomicU64, Ordering};

        static NEXT_DIRECTORY: AtomicU64 = AtomicU64::new(0);

        struct TestDirectory(PathBuf);

        impl TestDirectory {
            fn new() -> Self {
                let suffix = NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed);
                let path = std::env::temp_dir().join(format!(
                    "judgedesk-fault-trace-test-{}-{suffix}",
                    std::process::id()
                ));
                fs::create_dir(&path).expect("create fault trace test directory");
                fs::set_permissions(&path, fs::Permissions::from_mode(0o700))
                    .expect("protect fault trace test directory");
                Self(path)
            }
        }

        impl Drop for TestDirectory {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }

        fn create_trace_file(directory: &TestDirectory, mode: u32) -> PathBuf {
            let path = directory.0.join(format!("trace-{mode:o}.jsonl"));
            OpenOptions::new()
                .create_new(true)
                .write(true)
                .mode(mode)
                .open(&path)
                .expect("create trace file");
            fs::set_permissions(&path, fs::Permissions::from_mode(mode))
                .expect("set trace permissions");
            path
        }

        #[test]
        fn accepts_only_exact_owner_private_permissions() {
            let directory = TestDirectory::new();
            let trusted = create_trace_file(&directory, 0o600);
            open_existing_trace_file(&trusted).expect("open trusted trace");

            let permissive = create_trace_file(&directory, 0o644);
            assert!(open_existing_trace_file(&permissive)
                .expect_err("group/world-readable trace must fail")
                .contains("UNTRUSTED_FILE"));
        }

        #[test]
        fn refuses_a_symbolic_link() {
            let directory = TestDirectory::new();
            let target = create_trace_file(&directory, 0o600);
            let link = directory.0.join("trace-link.jsonl");
            symlink(target, &link).expect("create trace symlink");
            assert!(open_existing_trace_file(&link)
                .expect_err("O_NOFOLLOW must reject trace symlink")
                .contains("OPEN_FAILED"));
        }
    }
}
