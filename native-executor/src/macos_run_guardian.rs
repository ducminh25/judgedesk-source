//! Per-run macOS guardian and executor-side spawn primitives.
//!
//! The guardian is an independent containment authority. It owns the persistent supervisor as a
//! direct child, holds its own shared generation guard, and never signals a numeric process group
//! without either an authenticated live-anchor capability or an unreaped direct-child watcher.
//! The executor-to-supervisor channel bypasses the guardian so the executor remains the fallback
//! authority if this process dies. Simultaneous forced death of both authorities is deliberately
//! outside this module's claim.

#[cfg(not(target_os = "macos"))]
use crate::guardian_protocol::FrameIdentity;
#[cfg(any(target_os = "macos", test))]
use std::ffi::OsStr;
#[cfg(not(target_os = "macos"))]
use std::io;
#[cfg(not(target_os = "macos"))]
use std::path::Path;
use std::time::Duration;

/// Inherited by the guardian and passed through, without inspection, to the supervisor.
pub const GUARDIAN_SUPERVISOR_DIRECT_FD_ENV: &str = "JUDGEDESK_RUN_GUARDIAN_SUPERVISOR_DIRECT_FD";

#[cfg(target_os = "macos")]
const INTERNAL_CONTROL_FD: i32 = 3;
#[cfg(target_os = "macos")]
const INTERNAL_DIRECT_FD: i32 = 4;
#[cfg(target_os = "macos")]
const STARTUP_TIMEOUT: Duration = Duration::from_secs(10);
#[cfg(target_os = "macos")]
const CHILD_WAIT_POLL_INTERVAL: Duration = Duration::from_millis(2);

#[cfg(any(target_os = "macos", test))]
pub(crate) fn paired_launcher_nproc_ceiling(
    user_process_baseline: u64,
    inherited_nproc_max: u64,
    process_count: u32,
    peer_process_count: u32,
) -> Result<u64, String> {
    if !(1..=32).contains(&process_count) || peer_process_count > 32 {
        return Err("RLIMIT_NPROC process budgets are outside their validated bounds".into());
    }
    let supervisor_count = if peer_process_count == 0 { 1 } else { 4 };
    // One observable overflow and four processes of same-user daemon drift preserve the
    // existing single-run allowance. Paired launches reserve the peer's exact budget,
    // both supervisors and both executor-owned members. Group monitors exclude only
    // their exact enrolled trusted identities and retain independent target limits.
    let required = user_process_baseline
        .checked_add(supervisor_count)
        .and_then(|value| value.checked_add(u64::from(process_count)))
        .and_then(|value| value.checked_add(u64::from(peer_process_count)))
        .and_then(|value| value.checked_add(1))
        .and_then(|value| value.checked_add(4))
        .ok_or_else(|| "RLIMIT_NPROC launch headroom arithmetic overflow".to_string())?;
    if required > inherited_nproc_max {
        return Err(format!(
            "RLIMIT_NPROC cannot provide safe launch headroom: baseline={user_process_baseline}, required={required}, hardMax={inherited_nproc_max}"
        ));
    }
    Ok(required)
}

#[cfg(any(target_os = "macos", test))]
fn is_allowed_guardian_environment_key(key: &OsStr) -> bool {
    let Some(key) = key.to_str() else {
        return false;
    };
    matches!(
        key,
        crate::guardian_protocol::GUARDIAN_TOKEN_ENV
            | crate::guardian_protocol::GUARDIAN_GENERATION_ENV
            | crate::guardian_protocol::GUARDIAN_RUN_ID_ENV
            | crate::guardian_protocol::GUARDIAN_PARENT_PID_ENV
            | crate::guardian_protocol::GUARDIAN_ROOT_ENV
            | crate::guardian_protocol::GUARDIAN_REGISTRATION_FD_ENV
            | GUARDIAN_SUPERVISOR_DIRECT_FD_ENV
            | crate::tree_guard::REQUIRED_ENV
            | crate::tree_guard::PATH_ENV
            | crate::tree_guard::GENERATION_ENV
            | crate::tree_guard::PARENT_PID_ENV
            | crate::request_validation::BUILTIN_TOOLCHAINS_ENV
            | crate::fault_trace::FAULT_GATE_ENV
            | crate::fault_trace::FAULT_EVENT_LOG_ENV
            | crate::fault_trace::INTERACTIVE_FAULT_PAUSE_ENV
    )
}

#[cfg(target_os = "macos")]
mod imp {
    use super::{
        CHILD_WAIT_POLL_INTERVAL, GUARDIAN_SUPERVISOR_DIRECT_FD_ENV, INTERNAL_CONTROL_FD,
        INTERNAL_DIRECT_FD, STARTUP_TIMEOUT,
    };
    use crate::fault_trace::{FaultTrace, FaultTraceEvent, FAULT_EVENT_LOG_ENV, FAULT_GATE_ENV};
    use crate::guardian_io::{FrameRead, FrameReader};
    use crate::guardian_protocol::{
        authenticate_process_identity, read_authenticated_frame, write_authenticated_frame,
        CleanupCause, FrameIdentity, GuardianCommand, GuardianEvent, ProcessIdentity,
        SupervisorEvent, SupervisorGuardianCommand, GUARDIAN_GENERATION_ENV,
        GUARDIAN_PARENT_PID_ENV, GUARDIAN_REGISTRATION_FD_ENV, GUARDIAN_ROOT_ENV,
        GUARDIAN_RUN_ID_ENV, GUARDIAN_TOKEN_ENV, MACOS_RUN_GUARDIAN_ARGUMENT,
        MACOS_RUN_SUPERVISOR_ARGUMENT, SUPERVISOR_DIRECT_FD_ENV, SUPERVISOR_GENERATION_ENV,
        SUPERVISOR_GUARDIAN_FD_ENV, SUPERVISOR_GUARDIAN_PID_ENV, SUPERVISOR_RUN_ID_ENV,
        SUPERVISOR_TOKEN_ENV,
    };
    use crate::macos_process::{
        read_process_identity, signal_live_anchor_group, signal_live_anchor_process,
        stop_kill_anchor_group_and_reap, AnchorExitWatcher, GroupSignalOutcome,
        LiveAnchorProtocolLiveness,
    };
    use crate::protocol::RunResult;
    use crate::tree_guard;
    use std::collections::BTreeMap;
    use std::ffi::{CString, OsStr, OsString};
    use std::io::{self, Read};
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    use std::os::unix::net::UnixStream;
    use std::os::unix::process::ExitStatusExt;
    use std::path::{Path, PathBuf};
    use std::process::ExitStatus;
    use std::thread;
    use std::time::{Duration, Instant};

    const MIN_DUPLICATED_CHILD_FD: i32 = 64;
    const CONTROL_POLL_INTERVAL_MS: i32 = 2;
    const SESSION_READ_TIMEOUT: Duration = Duration::from_millis(2);
    const SESSION_WRITE_TIMEOUT: Duration = Duration::from_secs(2);

    #[derive(Debug)]
    pub struct GuardianChild {
        pid: i32,
        reaped: Option<ExitStatus>,
    }

    impl GuardianChild {
        #[cfg(test)]
        pub(crate) fn for_test_pid(pid: i32) -> Self {
            Self { pid, reaped: None }
        }

        pub fn pid(&self) -> i32 {
            self.pid
        }

        pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
            if let Some(status) = self.reaped {
                return Ok(Some(status));
            }
            let mut raw_status = 0_i32;
            loop {
                let waited = unsafe { libc::waitpid(self.pid, &mut raw_status, libc::WNOHANG) };
                if waited == self.pid {
                    let status = ExitStatus::from_raw(raw_status);
                    self.reaped = Some(status);
                    return Ok(Some(status));
                }
                if waited == 0 {
                    return Ok(None);
                }
                let error = io::Error::last_os_error();
                if error.kind() != io::ErrorKind::Interrupted {
                    return Err(error);
                }
            }
        }

        pub fn wait_timeout(&mut self, timeout: Duration) -> io::Result<Option<ExitStatus>> {
            let deadline = Instant::now()
                .checked_add(timeout)
                .ok_or_else(|| invalid("guardian wait timeout is too large"))?;
            loop {
                if let Some(status) = self.try_wait()? {
                    return Ok(Some(status));
                }
                if Instant::now() >= deadline {
                    return Ok(None);
                }
                thread::sleep(CHILD_WAIT_POLL_INTERVAL);
            }
        }

        pub fn wait(&mut self) -> io::Result<ExitStatus> {
            if let Some(status) = self.reaped {
                return Ok(status);
            }
            let mut raw_status = 0_i32;
            loop {
                let waited = unsafe { libc::waitpid(self.pid, &mut raw_status, 0) };
                if waited == self.pid {
                    let status = ExitStatus::from_raw(raw_status);
                    self.reaped = Some(status);
                    return Ok(status);
                }
                let error = io::Error::last_os_error();
                if error.kind() != io::ErrorKind::Interrupted {
                    return Err(error);
                }
            }
        }

        /// Terminates this exact unreaped direct child, then waits for it for at most `timeout`.
        ///
        /// The unreaped direct-child relationship pins the PID against reuse. This method is the
        /// explicit executor fallback after it has assumed the direct supervisor cleanup
        /// authority; `Drop` intentionally remains non-signalling.
        pub fn terminate_and_wait(&mut self, timeout: Duration) -> io::Result<Option<ExitStatus>> {
            if let Some(status) = self.try_wait()? {
                return Ok(Some(status));
            }
            loop {
                if unsafe { libc::kill(self.pid, libc::SIGKILL) } == 0 {
                    break;
                }
                let error = io::Error::last_os_error();
                if error.raw_os_error() == Some(libc::ESRCH) {
                    break;
                }
                if error.kind() != io::ErrorKind::Interrupted {
                    return Err(error);
                }
            }
            self.wait_timeout(timeout)
        }
    }

    /// `Drop` intentionally performs no signal and no ambiguous reap. The owner must use the
    /// explicit bounded wait/poll API and the authenticated containment protocol.
    impl Drop for GuardianChild {
        fn drop(&mut self) {}
    }

    #[derive(Debug)]
    pub struct SpawnedRunGuardian {
        pub identity: FrameIdentity,
        pub guardian: ProcessIdentity,
        pub child: GuardianChild,
        pub control: UnixStream,
        pub direct: UnixStream,
    }

    pub fn try_run_internal_mode() -> Option<i32> {
        if std::env::args_os().nth(1).as_deref()
            == Some(OsStr::new(
                crate::guardian_protocol::MACOS_PAIR_MEMBER_ARGUMENT,
            ))
        {
            if std::env::args_os().nth(2).is_some() {
                return Some(64);
            }
            return Some(match paired_member_main() {
                Ok(()) => 0,
                Err(_) => 70,
            });
        }
        if std::env::args_os().nth(1).as_deref() != Some(OsStr::new(MACOS_RUN_GUARDIAN_ARGUMENT)) {
            return None;
        }
        if std::env::args_os().nth(2).is_some() {
            return Some(64);
        }
        Some(match guardian_main() {
            Ok(()) => 0,
            Err(error) => {
                // Guardian stdio is /dev/null in production. This remains useful for an explicit
                // terminal invocation without risking the executor's framed stdout protocol.
                eprintln!("JudgeDesk macOS run guardian startup failed: {error}");
                70
            }
        })
    }

    pub fn spawn_run_guardian(
        root: &Path,
        identity: &FrameIdentity,
    ) -> io::Result<SpawnedRunGuardian> {
        spawn_run_guardian_with_failure(root, identity, || {})
    }

    pub(crate) struct SpawnedPairMember {
        pub identity: ProcessIdentity,
        pub child: GuardianChild,
        pub control: UnixStream,
    }

    pub(crate) fn spawn_pair_member(
        identity: &FrameIdentity,
        group: ProcessIdentity,
    ) -> io::Result<SpawnedPairMember> {
        identity.validate()?;
        crate::guardian_protocol::validate_supervisor_anchor(&group)?;
        let (control, inherited) = cloexec_stream_pair()?;
        control.set_read_timeout(Some(STARTUP_TIMEOUT))?;
        control.set_write_timeout(Some(SESSION_WRITE_TIMEOUT))?;
        let mut environment = inherited_tree_environment(&identity.generation)?;
        for (key, value) in [
            (GUARDIAN_TOKEN_ENV, identity.token.clone()),
            (GUARDIAN_GENERATION_ENV, identity.generation.clone()),
            (GUARDIAN_RUN_ID_ENV, identity.run_id.clone()),
            (GUARDIAN_PARENT_PID_ENV, std::process::id().to_string()),
            (
                GUARDIAN_REGISTRATION_FD_ENV,
                INTERNAL_CONTROL_FD.to_string(),
            ),
            (
                crate::guardian_protocol::PAIR_MEMBER_GROUP_ENV,
                serde_json::to_string(&group).map_err(io::Error::other)?,
            ),
        ] {
            insert_text_environment(&mut environment, key, &value)?;
        }
        let mut child = spawn_internal_child(
            &trusted_current_executable()?,
            crate::guardian_protocol::MACOS_PAIR_MEMBER_ARGUMENT,
            &environment,
            &[(inherited.as_raw_fd(), INTERNAL_CONTROL_FD)],
        )?;
        drop(inherited);
        let ready = (|| {
            let event = read_authenticated_frame::<_, GuardianEvent>(&mut &control, identity)?;
            let member = match event {
                Some(GuardianEvent::Ready { guardian, .. }) => guardian,
                _ => return Err(invalid("paired member did not authenticate ready")),
            };
            authenticate_process_identity(&member, &read_process_identity(child.pid())?)?;
            crate::guardian_protocol::validate_target_identity(&member, &group)?;
            Ok(member)
        })();
        match ready {
            Ok(member) => Ok(SpawnedPairMember {
                identity: member,
                child,
                control,
            }),
            Err(error) => {
                terminate_startup_child(&mut child);
                Err(error)
            }
        }
    }

    fn paired_member_main() -> io::Result<()> {
        install_signal_policy()?;
        for (key, _) in std::env::vars_os() {
            if !super::is_allowed_guardian_environment_key(&key)
                && key != OsStr::new(crate::guardian_protocol::PAIR_MEMBER_GROUP_ENV)
            {
                return Err(invalid(
                    "paired member inherited an unexpected environment key",
                ));
            }
        }
        let identity = FrameIdentity::new(
            required_text_environment(GUARDIAN_TOKEN_ENV)?,
            required_text_environment(GUARDIAN_GENERATION_ENV)?,
            required_text_environment(GUARDIAN_RUN_ID_ENV)?,
        )?;
        if required_positive_i32_environment(GUARDIAN_PARENT_PID_ENV)? != unsafe { libc::getppid() }
        {
            return Err(invalid("paired member parent is not its executor"));
        }
        let group: ProcessIdentity = serde_json::from_str(&required_text_environment(
            crate::guardian_protocol::PAIR_MEMBER_GROUP_ENV,
        )?)
        .map_err(io::Error::other)?;
        crate::guardian_protocol::validate_supervisor_anchor(&group)?;
        authenticate_process_identity(&group, &read_process_identity(group.pid)?)?;
        let _guard = tree_guard::acquire_from_environment().map_err(io::Error::other)?;
        if required_text_environment(tree_guard::GENERATION_ENV)? != identity.generation {
            return Err(invalid("paired member generation mismatch"));
        }
        let mut control = inherited_unix_stream(required_exact_fd_environment(
            GUARDIAN_REGISTRATION_FD_ENV,
            INTERNAL_CONTROL_FD,
        )?)?;
        if unsafe { libc::setpgid(0, group.pgid) } != 0 {
            return Err(io::Error::last_os_error());
        }
        authenticate_process_identity(&group, &read_process_identity(group.pid)?)?;
        let member = read_process_identity(std::process::id() as i32)?;
        crate::guardian_protocol::validate_target_identity(&member, &group)?;
        write_authenticated_frame(
            &mut control,
            &GuardianEvent::ready(&identity, member),
            &identity,
        )?;
        // An inert source-bound member never forks or leaves its group. Parent EOF retires
        // it; a stopped member is instead killed by the surviving group's owned authority.
        let mut byte = [0_u8; 1];
        loop {
            match control.read(&mut byte) {
                Ok(0) => return Ok(()),
                Ok(_) => return Err(invalid("paired member received unexpected control data")),
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(error),
            }
        }
    }

    pub fn spawn_run_guardian_with_failure<F>(
        root: &Path,
        identity: &FrameIdentity,
        on_failure: F,
    ) -> io::Result<SpawnedRunGuardian>
    where
        F: FnOnce(),
    {
        identity.validate()?;
        let root = canonical_private_root(root)?;
        let tree_environment = inherited_tree_environment(&identity.generation)?;
        let trace_environment = inherited_trace_environment()?;
        let executable = trusted_current_executable()?;
        let (control_parent, control_child) = cloexec_stream_pair()?;
        let (direct_parent, direct_child) = cloexec_stream_pair()?;
        control_parent.set_write_timeout(Some(SESSION_WRITE_TIMEOUT))?;
        direct_parent.set_write_timeout(Some(SESSION_WRITE_TIMEOUT))?;

        let mut environment = BTreeMap::new();
        insert_text_environment(&mut environment, GUARDIAN_TOKEN_ENV, &identity.token)?;
        insert_text_environment(
            &mut environment,
            GUARDIAN_GENERATION_ENV,
            &identity.generation,
        )?;
        insert_text_environment(&mut environment, GUARDIAN_RUN_ID_ENV, &identity.run_id)?;
        insert_text_environment(
            &mut environment,
            GUARDIAN_PARENT_PID_ENV,
            &std::process::id().to_string(),
        )?;
        insert_os_environment(
            &mut environment,
            GUARDIAN_ROOT_ENV,
            root.as_os_str().to_owned(),
        )?;
        insert_text_environment(
            &mut environment,
            GUARDIAN_REGISTRATION_FD_ENV,
            &INTERNAL_CONTROL_FD.to_string(),
        )?;
        insert_text_environment(
            &mut environment,
            GUARDIAN_SUPERVISOR_DIRECT_FD_ENV,
            &INTERNAL_DIRECT_FD.to_string(),
        )?;
        extend_unique_environment(&mut environment, tree_environment)?;
        extend_unique_environment(&mut environment, trace_environment)?;
        if let Some(built_in_root) = inherited_builtin_toolchains_root()? {
            insert_os_environment(
                &mut environment,
                crate::request_validation::BUILTIN_TOOLCHAINS_ENV,
                built_in_root.into_os_string(),
            )?;
        }

        let mut child = spawn_internal_child(
            &executable,
            MACOS_RUN_GUARDIAN_ARGUMENT,
            &environment,
            &[
                (control_child.as_raw_fd(), INTERNAL_CONTROL_FD),
                (direct_child.as_raw_fd(), INTERNAL_DIRECT_FD),
            ],
        )?;
        drop(control_child);
        drop(direct_child);

        let startup = (|| -> io::Result<ProcessIdentity> {
            control_parent.set_read_timeout(Some(STARTUP_TIMEOUT))?;
            let ready =
                read_authenticated_frame::<_, GuardianEvent>(&mut &control_parent, identity);
            let ready = ready.map_err(|error| contextual(error, "read guardian_ready"))?;
            control_parent.set_read_timeout(Some(SESSION_READ_TIMEOUT))?;
            let guardian = match ready {
                Some(GuardianEvent::Ready { guardian, .. }) => guardian,
                Some(GuardianEvent::Fatal { code, message, .. }) => {
                    return Err(io::Error::other(format!(
                        "run guardian startup failed: {code}: {message}"
                    )))
                }
                Some(event) => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!("run guardian sent {} before guardian_ready", event.kind()),
                    ))
                }
                None => {
                    let status = child.try_wait()?;
                    return Err(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        format!("run guardian exited before ready: {status:?}"),
                    ));
                }
            };
            let actual = read_process_identity(child.pid())?;
            authenticate_process_identity(&guardian, &actual)?;
            if guardian.pid != child.pid() {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "guardian_ready identity does not belong to the direct child",
                ));
            }
            Ok(guardian)
        })();
        let guardian = match startup {
            Ok(guardian) => guardian,
            Err(error) => {
                // Paired peers must observe cancellation before this child's bounded reap or
                // an uncertain cleanup can retain the caller's generation guard forever.
                on_failure();
                terminate_startup_child(&mut child);
                return Err(error);
            }
        };

        Ok(SpawnedRunGuardian {
            identity: identity.clone(),
            guardian,
            child,
            control: control_parent,
            direct: direct_parent,
        })
    }

    struct GuardianEnvironment {
        identity: FrameIdentity,
        expected_parent: i32,
        root: PathBuf,
        control: UnixStream,
        supervisor_direct: UnixStream,
    }

    struct GuardianSession {
        identity: FrameIdentity,
        guardian: ProcessIdentity,
        root: PathBuf,
        control: UnixStream,
        control_reader: FrameReader,
        control_open: bool,
        supervisor_direct: Option<UnixStream>,
        trace: Option<FaultTrace>,
        containment_active: bool,
        sandbox_profile: Option<PathBuf>,
        paired: bool,
        pair_member: Option<ProcessIdentity>,
    }

    struct SupervisorRuntime {
        stream: UnixStream,
        reader: FrameReader,
        anchor: ProcessIdentity,
        watcher: AnchorExitWatcher,
    }

    struct PendingSupervisor {
        child: GuardianChild,
        stream: UnixStream,
        reader: FrameReader,
    }

    enum SessionInput {
        Executor(GuardianCommand),
        ExecutorEof,
        Supervisor(SupervisorEvent),
        SupervisorEof,
        AnchorExited,
    }

    enum RegisteredInput {
        Executor(GuardianCommand),
        ExecutorEof,
        Supervisor(SupervisorEvent),
        SupervisorEof,
        SupervisorExited(ExitStatus),
    }

    fn guardian_main() -> io::Result<()> {
        install_signal_policy()?;
        let environment = guardian_environment_from_process()?;
        if unsafe { libc::getppid() } != environment.expected_parent {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "run guardian parent does not match its authenticated executor",
            ));
        }
        let generation_guard = tree_guard::acquire_from_environment()
            .map_err(|error| io::Error::new(io::ErrorKind::PermissionDenied, error))?;
        let tree_generation = std::env::var(tree_guard::GENERATION_ENV).map_err(|_| {
            io::Error::new(
                io::ErrorKind::PermissionDenied,
                "run guardian tree generation is missing",
            )
        })?;
        if tree_generation != environment.identity.generation {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "run guardian protocol and tree generations differ",
            ));
        }

        let guardian = read_process_identity(std::process::id() as i32)?;
        let trace = FaultTrace::from_environment(&environment.identity.generation)
            .map_err(io::Error::other)?;
        environment
            .control
            .set_read_timeout(Some(SESSION_READ_TIMEOUT))?;
        environment
            .control
            .set_write_timeout(Some(SESSION_WRITE_TIMEOUT))?;
        let mut session = GuardianSession {
            identity: environment.identity,
            guardian,
            root: environment.root,
            control: environment.control,
            control_reader: FrameReader::new(),
            control_open: true,
            supervisor_direct: Some(environment.supervisor_direct),
            trace,
            containment_active: false,
            sandbox_profile: None,
            paired: false,
            pair_member: None,
        };
        session.emit_trace(FaultTraceEvent::GuardianReady, None, None)?;
        session.send_guardian_event(&GuardianEvent::ready(&session.identity, guardian))?;

        // The guard must outlive every cleanup proof. If containment becomes active and a
        // protocol/system error prevents a safe drain, keep it forever rather than releasing a
        // new executor generation onto an uncertain process group.
        let _generation_guard = generation_guard;
        match session.run() {
            Ok(()) => session.remove_sandbox_profile(),
            Err(error) if session.containment_active => {
                session.send_fatal(
                    "GUARDIAN_CONTAINMENT_FAILED",
                    format!("{error}; generation guard remains held"),
                );
                hold_generation_guard_forever()
            }
            Err(error) => {
                // Before a supervisor anchor exists, the executor can safely classify the
                // launch as failed, but it still needs the authenticated root cause. Guardian
                // stdio is deliberately /dev/null, so report the failure on the existing
                // control channel before exiting. A best-effort diagnostic must never weaken
                // the cleanup result or turn a failed launch into a successful one.
                session.send_fatal("GUARDIAN_STARTUP_FAILED", error.to_string());
                match session.remove_sandbox_profile() {
                    Ok(()) => Err(error),
                    Err(cleanup_error) => Err(io::Error::new(
                        error.kind(),
                        format!("{error}; remove Seatbelt profile: {cleanup_error}"),
                    )),
                }
            }
        }
    }

    impl GuardianSession {
        fn run(&mut self) -> io::Result<()> {
            let deadline = checked_deadline(STARTUP_TIMEOUT)?;
            let (spec, peer_process_count) = loop {
                if Instant::now() >= deadline {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "guardian start handshake timed out",
                    ));
                }
                match self.read_executor_command()? {
                    FrameRead::Frame(GuardianCommand::Start {
                        spec,
                        peer_process_count,
                        ..
                    }) => break (*spec, peer_process_count),
                    FrameRead::Frame(GuardianCommand::Cancel { .. }) | FrameRead::Eof => {
                        return Ok(())
                    }
                    FrameRead::Pending => continue,
                    FrameRead::Frame(command) => {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            format!("expected guardian_start, received {}", command.kind()),
                        ))
                    }
                }
            };

            let launcher_spec = crate::platform::macos::prepare_launcher_spec_with_peer(
                &self.root,
                &spec,
                &self.identity,
                peer_process_count,
            )
            .map_err(|error| io::Error::other(error.to_string()))?;
            self.paired = peer_process_count != 0;
            self.sandbox_profile = Some(launcher_spec.sandbox_profile.clone());
            let pending = self.spawn_supervisor()?;
            self.containment_active = true;
            let (mut runtime, pending_cleanup) = self.wait_for_registration(pending)?;
            let result = (|| -> io::Result<()> {
                if let Some(cause) = pending_cleanup {
                    return self.cleanup_and_finish(&mut runtime, cause);
                }

                if self.paired
                    && spec.role == crate::protocol::RunRole::Checker
                    && crate::fault_trace::InteractiveFaultPause::from_environment(
                        self.trace.is_some(),
                    )
                    .map_err(io::Error::other)?
                        == Some(crate::fault_trace::InteractiveFaultPause::SecondConfigure)
                {
                    self.emit_trace(
                        FaultTraceEvent::InteractiveSecondConfigurePaused,
                        Some(runtime.anchor),
                        None,
                    )?;
                    let until = Instant::now() + Duration::from_secs(2);
                    while Instant::now() < until {
                        match self.read_executor_command()? {
                            FrameRead::Pending => {}
                            FrameRead::Eof => {
                                return self.cleanup_and_finish(
                                    &mut runtime,
                                    CleanupCause::ExecutorDisconnected,
                                )
                            }
                            FrameRead::Frame(GuardianCommand::Cancel { cause, .. }) => {
                                return self.cleanup_and_finish(&mut runtime, cause)
                            }
                            FrameRead::Frame(command) => {
                                return Err(io::Error::new(
                                    io::ErrorKind::InvalidData,
                                    format!(
                                    "unexpected command during interactive preparation pause: {}",
                                    command.kind()
                                ),
                                ))
                            }
                        }
                    }
                }

                self.send_supervisor_command(
                    &mut runtime.stream,
                    &SupervisorGuardianCommand::configure(&self.identity, launcher_spec),
                )?;
                let pending_cleanup = self.wait_for_supervisor_ready(&mut runtime)?;
                if let Some(cause) = pending_cleanup {
                    return self.cleanup_and_finish(&mut runtime, cause);
                }

                self.send_guardian_event(&GuardianEvent::started(&self.identity, runtime.anchor))?;
                self.emit_trace(FaultTraceEvent::GuardianStarted, Some(runtime.anchor), None)?;

                let cause = self.wait_for_commit_or_cleanup(&mut runtime)?;
                if let Some(cause) = cause {
                    return self.cleanup_and_finish(&mut runtime, cause);
                }
                self.emit_trace(FaultTraceEvent::GuardianGo, Some(runtime.anchor), None)?;
                self.send_supervisor_command(
                    &mut runtime.stream,
                    &SupervisorGuardianCommand::go(&self.identity, runtime.anchor),
                )?;

                loop {
                    match self.next_input(&mut runtime)? {
                        SessionInput::Executor(GuardianCommand::Cancel { cause, .. }) => {
                            return self.cleanup_and_finish(&mut runtime, cause)
                        }
                        SessionInput::Executor(command) => {
                            self.send_fatal(
                                "GUARDIAN_PROTOCOL_FAILED",
                                format!("out-of-order executor command {}", command.kind()),
                            );
                            return self
                                .cleanup_and_finish(&mut runtime, CleanupCause::ProtocolViolation);
                        }
                        SessionInput::ExecutorEof => {
                            self.control_open = false;
                            return self.cleanup_and_finish(
                                &mut runtime,
                                CleanupCause::ExecutorDisconnected,
                            );
                        }
                        SessionInput::Supervisor(event) => {
                            if let Some(cause) = self.forward_supervisor_event(&runtime, event)? {
                                return self.cleanup_and_finish(&mut runtime, cause);
                            }
                        }
                        SessionInput::SupervisorEof => {
                            return self.wait_for_exact_anchor_exit_after_channel_loss(
                                &mut runtime,
                                "supervisor channel closed before cleanup",
                            )
                        }
                        SessionInput::AnchorExited => {
                            return self.drain_early_anchor_exit(
                                &mut runtime,
                                "supervisor exited before preparing a result",
                            )
                        }
                    }
                }
            })();
            match result {
                Err(error) if self.paired && self.containment_active => {
                    // Every paired protocol failure with an established owned S pin funnels
                    // through the same cleanup authority, including enrollment EOF and failed
                    // grant publication. Only exact direct-child termination precedes the
                    // existing exited-anchor whole-group capability; no channel is a PID handle.
                    self.send_fatal("PAIRED_PROTOCOL_FAILED", error.to_string());
                    self.control_open = false;
                    let _ = self.control.shutdown(std::net::Shutdown::Both);
                    runtime.watcher.terminate_for_paired_cleanup()?;
                    self.await_pair_member_release(&mut runtime)?;
                    stop_kill_anchor_group_and_reap(
                        &mut runtime.watcher,
                        crate::macos_process::DrainOptions::default(),
                        |_| {},
                    )?;
                    self.emit_trace(FaultTraceEvent::GroupDrained, Some(runtime.anchor), None)?;
                    self.containment_active = false;
                    Ok(())
                }
                other => other,
            }
        }

        fn spawn_supervisor(&mut self) -> io::Result<PendingSupervisor> {
            let direct = self.supervisor_direct.take().ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "supervisor direct channel was already transferred",
                )
            })?;
            let (guardian_parent, guardian_child) = cloexec_stream_pair()?;
            guardian_parent.set_read_timeout(Some(SESSION_READ_TIMEOUT))?;
            guardian_parent.set_write_timeout(Some(SESSION_WRITE_TIMEOUT))?;
            let executable = trusted_current_executable()?;
            let tree_environment = inherited_tree_environment(&self.identity.generation)?;
            let trace_environment = inherited_trace_environment()?;
            let mut environment = BTreeMap::new();
            insert_text_environment(&mut environment, SUPERVISOR_TOKEN_ENV, &self.identity.token)?;
            if self.paired {
                insert_text_environment(
                    &mut environment,
                    crate::guardian_protocol::PAIRED_SUPERVISOR_ENV,
                    "1",
                )?;
            }
            insert_text_environment(
                &mut environment,
                SUPERVISOR_GENERATION_ENV,
                &self.identity.generation,
            )?;
            insert_text_environment(
                &mut environment,
                SUPERVISOR_RUN_ID_ENV,
                &self.identity.run_id,
            )?;
            insert_text_environment(
                &mut environment,
                SUPERVISOR_GUARDIAN_PID_ENV,
                &self.guardian.pid.to_string(),
            )?;
            insert_text_environment(
                &mut environment,
                SUPERVISOR_GUARDIAN_FD_ENV,
                &INTERNAL_CONTROL_FD.to_string(),
            )?;
            insert_text_environment(
                &mut environment,
                SUPERVISOR_DIRECT_FD_ENV,
                &INTERNAL_DIRECT_FD.to_string(),
            )?;
            extend_unique_environment(&mut environment, tree_environment)?;
            extend_unique_environment(&mut environment, trace_environment)?;

            let child = spawn_internal_child(
                &executable,
                MACOS_RUN_SUPERVISOR_ARGUMENT,
                &environment,
                &[
                    (guardian_child.as_raw_fd(), INTERNAL_CONTROL_FD),
                    (direct.as_raw_fd(), INTERNAL_DIRECT_FD),
                ],
            )?;
            drop(guardian_child);
            drop(direct);
            Ok(PendingSupervisor {
                child,
                stream: guardian_parent,
                reader: FrameReader::new(),
            })
        }

        fn wait_for_registration(
            &mut self,
            mut pending: PendingSupervisor,
        ) -> io::Result<(SupervisorRuntime, Option<CleanupCause>)> {
            let deadline = checked_deadline(STARTUP_TIMEOUT)?;
            let registration = (|| {
                let mut pending_cleanup = None;
                loop {
                    match self.next_registered_input(&mut pending, deadline)? {
                        RegisteredInput::Executor(GuardianCommand::Cancel { cause, .. }) => {
                            pending_cleanup.get_or_insert(cause);
                        }
                        RegisteredInput::Executor(command) => {
                            return Err(io::Error::new(
                                io::ErrorKind::InvalidData,
                                format!(
                                    "out-of-order command {} before supervisor registration",
                                    command.kind()
                                ),
                            ))
                        }
                        RegisteredInput::ExecutorEof => {
                            self.control_open = false;
                            pending_cleanup.get_or_insert(CleanupCause::ExecutorDisconnected);
                        }
                        RegisteredInput::Supervisor(SupervisorEvent::Registered {
                            anchor, ..
                        }) => {
                            let actual = read_process_identity(pending.child.pid())?;
                            authenticate_process_identity(&anchor, &actual)?;
                            if anchor.pid != pending.child.pid() {
                                return Err(io::Error::new(
                                    io::ErrorKind::PermissionDenied,
                                    "supervisor registration does not belong to the direct child",
                                ));
                            }
                            let watcher = AnchorExitWatcher::new(anchor)?;
                            self.emit_trace(
                                FaultTraceEvent::SupervisorRegistered,
                                Some(anchor),
                                None,
                            )?;
                            return Ok((anchor, watcher, pending_cleanup));
                        }
                        RegisteredInput::Supervisor(event) => {
                            return Err(io::Error::new(
                                io::ErrorKind::InvalidData,
                                format!(
                                    "supervisor sent {} before supervisor_registered",
                                    event.kind()
                                ),
                            ))
                        }
                        RegisteredInput::SupervisorEof => {
                            return Err(io::Error::new(
                                io::ErrorKind::UnexpectedEof,
                                "supervisor channel closed before registration",
                            ))
                        }
                        RegisteredInput::SupervisorExited(status) => {
                            return Err(io::Error::other(format!(
                                "supervisor exited before registration: {status}"
                            )))
                        }
                    }
                }
            })();
            match registration {
                Ok((anchor, watcher, pending_cleanup)) => Ok((
                    SupervisorRuntime {
                        stream: pending.stream,
                        reader: pending.reader,
                        anchor,
                        watcher,
                    },
                    pending_cleanup,
                )),
                Err(error) => {
                    terminate_startup_child(&mut pending.child);
                    self.containment_active = false;
                    Err(error)
                }
            }
        }

        fn wait_for_supervisor_ready(
            &mut self,
            runtime: &mut SupervisorRuntime,
        ) -> io::Result<Option<CleanupCause>> {
            let deadline = checked_deadline(STARTUP_TIMEOUT)?;
            let input = match self.next_input_until(runtime, Some(deadline)) {
                Ok(input) => input,
                Err(error) if error.kind() == io::ErrorKind::TimedOut => {
                    self.kill_and_drain_live_anchor(
                        runtime,
                        "supervisor ready handshake timed out",
                    )?;
                    return Err(error);
                }
                Err(error) => return Err(error),
            };
            match input {
                SessionInput::Executor(GuardianCommand::Cancel { cause, .. }) => Ok(Some(cause)),
                SessionInput::Executor(command) => Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!(
                        "out-of-order command {} before supervisor_ready",
                        command.kind()
                    ),
                )),
                SessionInput::ExecutorEof => {
                    self.control_open = false;
                    Ok(Some(CleanupCause::ExecutorDisconnected))
                }
                SessionInput::Supervisor(SupervisorEvent::Ready { anchor, .. }) => {
                    authenticate_process_identity(&anchor, &runtime.anchor)?;
                    self.emit_trace(FaultTraceEvent::SupervisorReady, Some(runtime.anchor), None)?;
                    Ok(None)
                }
                SessionInput::Supervisor(SupervisorEvent::Fatal {
                    anchor,
                    code,
                    message,
                    ..
                }) => {
                    if let Some(anchor) = anchor {
                        authenticate_process_identity(&anchor, &runtime.anchor)?;
                    }
                    self.send_fatal(&code, message);
                    Ok(Some(CleanupCause::InternalError))
                }
                SessionInput::Supervisor(SupervisorEvent::CleanupRequested {
                    anchor,
                    cause,
                    ..
                }) => {
                    authenticate_process_identity(&anchor, &runtime.anchor)?;
                    self.forward_cleanup_requested(runtime.anchor, cause)?;
                    Ok(Some(cause))
                }
                SessionInput::Supervisor(event) => Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("supervisor sent {} before supervisor_ready", event.kind()),
                )),
                SessionInput::SupervisorEof => {
                    self.wait_for_exact_anchor_exit_after_channel_loss(
                        runtime,
                        "supervisor channel closed before ready",
                    )?;
                    Err(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        "supervisor was drained after its channel closed before ready",
                    ))
                }
                SessionInput::AnchorExited => {
                    self.drain_early_anchor_exit(runtime, "supervisor exited before ready")?;
                    Err(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        "supervisor was drained after exiting before ready",
                    ))
                }
            }
        }

        fn wait_for_commit_or_cleanup(
            &mut self,
            runtime: &mut SupervisorRuntime,
        ) -> io::Result<Option<CleanupCause>> {
            if self.paired {
                if let Some(cause) = self.wait_for_pair_member(runtime)? {
                    return Ok(Some(cause));
                }
            }
            let deadline = checked_deadline(STARTUP_TIMEOUT)?;
            let input = match self.next_input_until(runtime, Some(deadline)) {
                Ok(input) => input,
                Err(error) if error.kind() == io::ErrorKind::TimedOut => {
                    self.kill_and_drain_live_anchor(
                        runtime,
                        "executor commit handshake timed out",
                    )?;
                    return Err(error);
                }
                Err(error) => return Err(error),
            };
            match input {
                SessionInput::Executor(GuardianCommand::Commit { anchor, .. }) => {
                    authenticate_process_identity(&anchor, &runtime.anchor)?;
                    Ok(None)
                }
                SessionInput::Executor(GuardianCommand::Cancel { cause, .. }) => Ok(Some(cause)),
                SessionInput::Executor(command) => Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("out-of-order executor command {}", command.kind()),
                )),
                SessionInput::ExecutorEof => {
                    self.control_open = false;
                    Ok(Some(CleanupCause::ExecutorDisconnected))
                }
                SessionInput::Supervisor(SupervisorEvent::CleanupRequested {
                    anchor,
                    cause,
                    ..
                }) => {
                    authenticate_process_identity(&anchor, &runtime.anchor)?;
                    self.forward_cleanup_requested(runtime.anchor, cause)?;
                    Ok(Some(cause))
                }
                SessionInput::Supervisor(event) => Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("supervisor sent {} before executor commit", event.kind()),
                )),
                SessionInput::SupervisorEof => {
                    self.wait_for_exact_anchor_exit_after_channel_loss(
                        runtime,
                        "supervisor channel closed before executor commit",
                    )?;
                    Err(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        "supervisor was drained after its channel closed before executor commit",
                    ))
                }
                SessionInput::AnchorExited => {
                    self.drain_early_anchor_exit(
                        runtime,
                        "supervisor exited before executor commit",
                    )?;
                    Err(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        "supervisor was drained after exiting before executor commit",
                    ))
                }
            }
        }

        fn wait_for_pair_member(
            &mut self,
            runtime: &mut SupervisorRuntime,
        ) -> io::Result<Option<CleanupCause>> {
            let deadline = checked_deadline(STARTUP_TIMEOUT)?;
            match self.next_input_until(runtime, Some(deadline))? {
                SessionInput::Executor(GuardianCommand::RegisterPairPin {
                    anchor, member, ..
                }) => {
                    authenticate_process_identity(&anchor, &runtime.anchor)?;
                    if self.pair_member.is_some() || runtime.watcher.poll_exit_unreaped()? {
                        return Err(invalid("invalid paired member enrollment state"));
                    }
                    crate::guardian_protocol::validate_target_identity(&member, &runtime.anchor)?;
                    authenticate_process_identity(&member, &read_process_identity(member.pid)?)?;
                    authenticate_process_identity(
                        &runtime.anchor,
                        &read_process_identity(runtime.anchor.pid)?,
                    )?;
                    self.pair_member = Some(member);
                    self.send_guardian_event(&GuardianEvent::pair_pin_registered(
                        &self.identity,
                        runtime.anchor,
                        member,
                    ))?;
                    Ok(None)
                }
                SessionInput::Executor(GuardianCommand::Cancel { cause, .. }) => Ok(Some(cause)),
                SessionInput::ExecutorEof => {
                    self.control_open = false;
                    Ok(Some(CleanupCause::ExecutorDisconnected))
                }
                SessionInput::Supervisor(SupervisorEvent::CleanupRequested {
                    anchor,
                    cause,
                    ..
                }) => {
                    authenticate_process_identity(&anchor, &runtime.anchor)?;
                    self.forward_cleanup_requested(anchor, cause)?;
                    Ok(Some(cause))
                }
                _ => Err(invalid("paired member was not enrolled before commit")),
            }
        }

        fn await_pair_member_release(&mut self, runtime: &mut SupervisorRuntime) -> io::Result<()> {
            let Some(member) = self.pair_member else {
                return Ok(());
            };
            if !runtime.watcher.poll_exit_unreaped()? {
                return Err(invalid("paired release requires terminal owned supervisor"));
            }
            let mut last = None;
            let mut notified = false;
            loop {
                let snapshot =
                    crate::macos_process::inventory_live_process_group(runtime.anchor.pgid)?;
                if snapshot.members.is_empty()
                    && snapshot
                        .zombie_pids
                        .iter()
                        .all(|pid| *pid == runtime.anchor.pid || *pid == member.pid)
                {
                    if last.as_ref() == Some(&snapshot) {
                        if !snapshot.zombie_pids.contains(&member.pid) {
                            return Ok(());
                        }
                        if !notified && self.control_open {
                            if self
                                .send_guardian_event(&GuardianEvent::pair_quiescent(
                                    &self.identity,
                                    runtime.anchor,
                                    member,
                                ))
                                .is_err()
                            {
                                // E can die after the inventory proof but before this write.
                                // Retain S's real owned pin and wait for orphan A to disappear;
                                // notification failure never substitutes for physical drain.
                                self.control_open = false;
                                let _ = self.control.shutdown(std::net::Shutdown::Both);
                            }
                            notified = true;
                        }
                    }
                    last = Some(snapshot);
                } else if snapshot.members.is_empty() {
                    // Only zombies remain in the group (including at least one untrusted
                    // descendant zombie awaiting launchd reap). Darwin XNU rejects whole-group
                    // signals to a zombie-only PGID with EPERM; retain S's pin and wait for the
                    // external reaper without advancing the two-observation quiescence proof.
                    last = None;
                } else {
                    last = None;
                    for signal in [libc::SIGSTOP, libc::SIGKILL] {
                        signal_exited_anchor_group_for_pair_release(
                            &mut runtime.watcher,
                            runtime.anchor.pgid,
                            signal,
                        )?;
                    }
                }
                if self.control_open {
                    match self.read_executor_command() {
                        Ok(FrameRead::Frame(GuardianCommand::Cancel { .. }))
                        | Ok(FrameRead::Pending) => {}
                        // Truncated/malformed EOF is still controller loss. S remains pinned;
                        // close the channel and continue the physical orphan drain.
                        _ => {
                            self.control_open = false;
                            let _ = self.control.shutdown(std::net::Shutdown::Both);
                        }
                    }
                }
                thread::sleep(CHILD_WAIT_POLL_INTERVAL);
            }
        }

        fn forward_supervisor_event(
            &mut self,
            runtime: &SupervisorRuntime,
            event: SupervisorEvent,
        ) -> io::Result<Option<CleanupCause>> {
            match event {
                SupervisorEvent::TargetStarted { anchor, target, .. } => {
                    authenticate_process_identity(&anchor, &runtime.anchor)?;
                    self.send_guardian_event(&GuardianEvent::target_started(
                        &self.identity,
                        runtime.anchor,
                        target,
                    ))?;
                    self.emit_trace(
                        FaultTraceEvent::TargetStarted,
                        Some(runtime.anchor),
                        Some(target),
                    )?;
                    Ok(None)
                }
                SupervisorEvent::CleanupRequested { anchor, cause, .. } => {
                    authenticate_process_identity(&anchor, &runtime.anchor)?;
                    self.forward_cleanup_requested(runtime.anchor, cause)?;
                    Ok(Some(cause))
                }
                SupervisorEvent::Fatal {
                    anchor,
                    code,
                    message,
                    ..
                } => {
                    if let Some(anchor) = anchor {
                        authenticate_process_identity(&anchor, &runtime.anchor)?;
                    }
                    self.send_fatal(&code, message);
                    Ok(Some(CleanupCause::InternalError))
                }
                other => Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("unexpected active supervisor event {}", other.kind()),
                )),
            }
        }

        fn forward_cleanup_requested(
            &mut self,
            anchor: ProcessIdentity,
            cause: CleanupCause,
        ) -> io::Result<()> {
            self.send_guardian_event(&GuardianEvent::cleanup_requested(
                &self.identity,
                anchor,
                cause,
            ))?;
            self.emit_trace(FaultTraceEvent::CleanupRequested, Some(anchor), None)
        }

        fn cleanup_and_finish(
            &mut self,
            runtime: &mut SupervisorRuntime,
            cause: CleanupCause,
        ) -> io::Result<()> {
            if runtime.watcher.poll_exit_unreaped()? {
                return self.drain_early_anchor_exit(
                    runtime,
                    "supervisor exited before cleanup authorization",
                );
            }

            let liveness_stream = runtime.stream.try_clone()?;
            let liveness = LiveAnchorProtocolLiveness::after_authenticated_handshake(
                runtime.anchor,
                &liveness_stream,
            )?;
            require_group_signal_sent(
                signal_live_anchor_group(
                    &runtime.anchor,
                    &liveness,
                    &runtime.watcher,
                    libc::SIGSTOP,
                )?,
                runtime.anchor,
                libc::SIGSTOP,
            )?;
            self.send_supervisor_command(
                &mut runtime.stream,
                &SupervisorGuardianCommand::cleanup(&self.identity, runtime.anchor, cause),
            )?;
            signal_live_anchor_process(
                &runtime.anchor,
                &liveness,
                &runtime.watcher,
                libc::SIGCONT,
            )?;

            let result = self.wait_for_prepared(runtime)?;
            self.emit_trace(
                FaultTraceEvent::SupervisorPrepared,
                Some(runtime.anchor),
                None,
            )?;
            require_group_signal_sent(
                signal_live_anchor_group(
                    &runtime.anchor,
                    &liveness,
                    &runtime.watcher,
                    libc::SIGKILL,
                )?,
                runtime.anchor,
                libc::SIGKILL,
            )?;
            drop(liveness_stream);

            runtime
                .watcher
                .wait_for_exit_unreaped(crate::macos_process::DrainOptions::default(), |_| {})?;
            self.await_pair_member_release(runtime)?;
            stop_kill_anchor_group_and_reap(
                &mut runtime.watcher,
                crate::macos_process::DrainOptions::default(),
                |_| {},
            )?;
            self.emit_trace(FaultTraceEvent::GroupDrained, Some(runtime.anchor), None)?;
            self.emit_trace(FaultTraceEvent::GuardianCleaned, Some(runtime.anchor), None)?;
            self.containment_active = false;
            if self.control_open {
                self.send_guardian_event(&GuardianEvent::prepared(
                    &self.identity,
                    runtime.anchor,
                    result,
                ))?;
            }
            Ok(())
        }

        fn wait_for_prepared(&mut self, runtime: &mut SupervisorRuntime) -> io::Result<RunResult> {
            let deadline = checked_deadline(STARTUP_TIMEOUT)?;
            loop {
                let input = match self.next_input_until(runtime, Some(deadline)) {
                    Ok(input) => input,
                    Err(error) if error.kind() == io::ErrorKind::TimedOut => {
                        self.kill_and_drain_live_anchor(
                            runtime,
                            "supervisor prepared handshake timed out",
                        )?;
                        return Err(error);
                    }
                    Err(error) => return Err(error),
                };
                match input {
                    SessionInput::Executor(GuardianCommand::Cancel { .. }) => {}
                    SessionInput::Executor(command) => self.send_fatal(
                        "GUARDIAN_PROTOCOL_FAILED",
                        format!("ignored command {} during cleanup", command.kind()),
                    ),
                    SessionInput::ExecutorEof => self.control_open = false,
                    SessionInput::Supervisor(SupervisorEvent::Ready { anchor, .. }) => {
                        authenticate_process_identity(&anchor, &runtime.anchor)?;
                    }
                    SessionInput::Supervisor(SupervisorEvent::Prepared {
                        anchor, result, ..
                    }) => {
                        authenticate_process_identity(&anchor, &runtime.anchor)?;
                        return Ok(*result);
                    }
                    SessionInput::Supervisor(SupervisorEvent::TargetStarted {
                        anchor,
                        target,
                        ..
                    }) => {
                        authenticate_process_identity(&anchor, &runtime.anchor)?;
                        if self.control_open {
                            self.send_guardian_event(&GuardianEvent::target_started(
                                &self.identity,
                                runtime.anchor,
                                target,
                            ))?;
                        }
                    }
                    SessionInput::Supervisor(SupervisorEvent::CleanupRequested {
                        anchor,
                        cause,
                        ..
                    }) => {
                        authenticate_process_identity(&anchor, &runtime.anchor)?;
                        if self.control_open {
                            self.forward_cleanup_requested(runtime.anchor, cause)?;
                        }
                    }
                    SessionInput::Supervisor(SupervisorEvent::Fatal {
                        anchor,
                        code,
                        message,
                        ..
                    }) => {
                        if let Some(anchor) = anchor {
                            authenticate_process_identity(&anchor, &runtime.anchor)?;
                        }
                        self.send_fatal(&code, message);
                    }
                    SessionInput::Supervisor(event) => {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            format!(
                                "unexpected supervisor event {} during cleanup",
                                event.kind()
                            ),
                        ))
                    }
                    SessionInput::SupervisorEof => {
                        self.wait_for_exact_anchor_exit_after_channel_loss(
                            runtime,
                            "supervisor channel closed before prepared result",
                        )?;
                        return Err(io::Error::new(
                            io::ErrorKind::UnexpectedEof,
                            "supervisor was drained after its channel closed before prepared result",
                        ));
                    }
                    SessionInput::AnchorExited => {
                        self.drain_early_anchor_exit(
                            runtime,
                            "supervisor exited before prepared result",
                        )?;
                        return Err(io::Error::new(
                            io::ErrorKind::UnexpectedEof,
                            "supervisor was drained after exiting before prepared result",
                        ));
                    }
                }
            }
        }

        fn drain_early_anchor_exit(
            &mut self,
            runtime: &mut SupervisorRuntime,
            diagnostic: &str,
        ) -> io::Result<()> {
            self.await_pair_member_release(runtime)?;
            stop_kill_anchor_group_and_reap(
                &mut runtime.watcher,
                crate::macos_process::DrainOptions::default(),
                |_| {},
            )?;
            self.emit_trace(FaultTraceEvent::GroupDrained, Some(runtime.anchor), None)?;
            self.send_fatal("SUPERVISOR_EXITED_EARLY", diagnostic.to_owned());
            self.emit_trace(FaultTraceEvent::GuardianCleaned, Some(runtime.anchor), None)?;
            self.containment_active = false;
            Ok(())
        }

        fn kill_and_drain_live_anchor(
            &mut self,
            runtime: &mut SupervisorRuntime,
            diagnostic: &str,
        ) -> io::Result<()> {
            let liveness_stream = runtime.stream.try_clone()?;
            let liveness = LiveAnchorProtocolLiveness::after_authenticated_handshake(
                runtime.anchor,
                &liveness_stream,
            )?;
            require_group_signal_sent(
                signal_live_anchor_group(
                    &runtime.anchor,
                    &liveness,
                    &runtime.watcher,
                    libc::SIGKILL,
                )?,
                runtime.anchor,
                libc::SIGKILL,
            )?;
            drop(liveness_stream);
            runtime
                .watcher
                .wait_for_exit_unreaped(crate::macos_process::DrainOptions::default(), |_| {})?;
            self.await_pair_member_release(runtime)?;
            stop_kill_anchor_group_and_reap(
                &mut runtime.watcher,
                crate::macos_process::DrainOptions::default(),
                |_| {},
            )?;
            self.emit_trace(FaultTraceEvent::GroupDrained, Some(runtime.anchor), None)?;
            self.send_fatal("SUPERVISOR_HANDSHAKE_TIMEOUT", diagnostic.to_owned());
            self.emit_trace(FaultTraceEvent::GuardianCleaned, Some(runtime.anchor), None)?;
            self.containment_active = false;
            Ok(())
        }

        fn wait_for_exact_anchor_exit_after_channel_loss(
            &mut self,
            runtime: &mut SupervisorRuntime,
            diagnostic: &str,
        ) -> io::Result<()> {
            self.send_fatal(
                "SUPERVISOR_CHANNEL_LOST",
                format!(
                    "{diagnostic}; no non-parent numeric fallback is authorized, waiting for the exact direct child to exit"
                ),
            );
            runtime
                .watcher
                .wait_for_exit_unreaped(crate::macos_process::DrainOptions::default(), |_| {})?;
            self.drain_early_anchor_exit(runtime, diagnostic)
        }

        fn next_registered_input(
            &mut self,
            pending: &mut PendingSupervisor,
            deadline: Instant,
        ) -> io::Result<RegisteredInput> {
            loop {
                if Instant::now() >= deadline {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "supervisor registration timed out",
                    ));
                }
                if let Some(status) = pending.child.try_wait()? {
                    return Ok(RegisteredInput::SupervisorExited(status));
                }
                let ready = poll_streams(
                    if self.control_open {
                        Some(&self.control)
                    } else {
                        None
                    },
                    Some(&pending.stream),
                )?;
                if ready.control {
                    match self.read_executor_command()? {
                        FrameRead::Frame(command) => return Ok(RegisteredInput::Executor(command)),
                        FrameRead::Eof => return Ok(RegisteredInput::ExecutorEof),
                        FrameRead::Pending => {}
                    }
                }
                if ready.supervisor {
                    match pending
                        .reader
                        .receive::<_, SupervisorEvent>(&mut &pending.stream, &self.identity)?
                    {
                        FrameRead::Frame(event) => return Ok(RegisteredInput::Supervisor(event)),
                        FrameRead::Eof => return Ok(RegisteredInput::SupervisorEof),
                        FrameRead::Pending => {}
                    }
                }
            }
        }

        fn next_input(&mut self, runtime: &mut SupervisorRuntime) -> io::Result<SessionInput> {
            self.next_input_until(runtime, None)
        }

        fn next_input_until(
            &mut self,
            runtime: &mut SupervisorRuntime,
            deadline: Option<Instant>,
        ) -> io::Result<SessionInput> {
            loop {
                if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "internal guardian protocol handshake timed out",
                    ));
                }
                if runtime.watcher.poll_exit_unreaped()? {
                    return Ok(SessionInput::AnchorExited);
                }
                let ready = poll_streams(
                    if self.control_open {
                        Some(&self.control)
                    } else {
                        None
                    },
                    Some(&runtime.stream),
                )?;
                if ready.control {
                    match self.read_executor_command()? {
                        FrameRead::Frame(command) => return Ok(SessionInput::Executor(command)),
                        FrameRead::Eof => return Ok(SessionInput::ExecutorEof),
                        FrameRead::Pending => {}
                    }
                }
                if ready.supervisor {
                    match runtime
                        .reader
                        .receive::<_, SupervisorEvent>(&mut &runtime.stream, &self.identity)?
                    {
                        FrameRead::Frame(event) => return Ok(SessionInput::Supervisor(event)),
                        FrameRead::Eof => return Ok(SessionInput::SupervisorEof),
                        FrameRead::Pending => {}
                    }
                }
            }
        }

        fn read_executor_command(&mut self) -> io::Result<FrameRead<GuardianCommand>> {
            if !self.control_open {
                return Ok(FrameRead::Eof);
            }
            let command = self
                .control_reader
                .receive(&mut self.control, &self.identity)?;
            if matches!(command, FrameRead::Eof) {
                self.control_open = false;
            }
            Ok(command)
        }

        fn send_guardian_event(&mut self, event: &GuardianEvent) -> io::Result<()> {
            if !self.control_open {
                return Ok(());
            }
            if let Err(error) = write_authenticated_frame(&mut self.control, event, &self.identity)
            {
                self.control_open = false;
                return Err(error);
            }
            Ok(())
        }

        fn send_supervisor_command(
            &self,
            stream: &mut UnixStream,
            command: &SupervisorGuardianCommand,
        ) -> io::Result<()> {
            write_authenticated_frame(stream, command, &self.identity)
        }

        fn send_fatal(&mut self, code: &str, message: String) {
            if !self.control_open {
                return;
            }
            let event = GuardianEvent::fatal(&self.identity, code, message);
            let _ = self.send_guardian_event(&event);
        }

        fn emit_trace(
            &self,
            event: FaultTraceEvent,
            anchor: Option<ProcessIdentity>,
            target: Option<ProcessIdentity>,
        ) -> io::Result<()> {
            if let Some(trace) = &self.trace {
                trace
                    .emit(
                        event,
                        &self.identity.run_id,
                        Some(self.guardian),
                        anchor,
                        target,
                    )
                    .map_err(io::Error::other)?;
            }
            Ok(())
        }

        fn remove_sandbox_profile(&mut self) -> io::Result<()> {
            let Some(path) = self.sandbox_profile.take() else {
                return Ok(());
            };
            match std::fs::remove_file(&path) {
                Ok(()) => Ok(()),
                Err(error) => {
                    self.sandbox_profile = Some(path);
                    Err(error)
                }
            }
        }
    }

    #[derive(Debug, Clone, Copy)]
    struct PollReady {
        control: bool,
        supervisor: bool,
    }

    fn poll_streams(
        control: Option<&UnixStream>,
        supervisor: Option<&UnixStream>,
    ) -> io::Result<PollReady> {
        let mut descriptors = [
            libc::pollfd {
                fd: control.map_or(-1, AsRawFd::as_raw_fd),
                events: libc::POLLIN | libc::POLLHUP | libc::POLLERR,
                revents: 0,
            },
            libc::pollfd {
                fd: supervisor.map_or(-1, AsRawFd::as_raw_fd),
                events: libc::POLLIN | libc::POLLHUP | libc::POLLERR,
                revents: 0,
            },
        ];
        loop {
            let result = unsafe {
                libc::poll(
                    descriptors.as_mut_ptr(),
                    descriptors.len() as libc::nfds_t,
                    CONTROL_POLL_INTERVAL_MS,
                )
            };
            if result >= 0 {
                return Ok(PollReady {
                    control: descriptors[0].revents
                        & (libc::POLLIN | libc::POLLHUP | libc::POLLERR | libc::POLLNVAL)
                        != 0,
                    supervisor: descriptors[1].revents
                        & (libc::POLLIN | libc::POLLHUP | libc::POLLERR | libc::POLLNVAL)
                        != 0,
                });
            }
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
    }

    fn guardian_environment_from_process() -> io::Result<GuardianEnvironment> {
        validate_exact_guardian_environment()?;
        let identity = FrameIdentity::new(
            required_text_environment(GUARDIAN_TOKEN_ENV)?,
            required_text_environment(GUARDIAN_GENERATION_ENV)?,
            required_text_environment(GUARDIAN_RUN_ID_ENV)?,
        )?;
        let expected_parent = required_positive_i32_environment(GUARDIAN_PARENT_PID_ENV)?;
        let root = canonical_private_root(Path::new(&required_os_environment(GUARDIAN_ROOT_ENV)?))?;
        let control_fd =
            required_exact_fd_environment(GUARDIAN_REGISTRATION_FD_ENV, INTERNAL_CONTROL_FD)?;
        let direct_fd =
            required_exact_fd_environment(GUARDIAN_SUPERVISOR_DIRECT_FD_ENV, INTERNAL_DIRECT_FD)?;
        let control = inherited_unix_stream(control_fd)?;
        let supervisor_direct = inherited_unix_stream(direct_fd)?;
        Ok(GuardianEnvironment {
            identity,
            expected_parent,
            root,
            control,
            supervisor_direct,
        })
    }

    fn validate_exact_guardian_environment() -> io::Result<()> {
        for (key, _) in std::env::vars_os() {
            if !super::is_allowed_guardian_environment_key(&key) {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    format!(
                        "unexpected run guardian environment key {:?}",
                        key.to_string_lossy()
                    ),
                ));
            }
        }
        inherited_trace_environment()?;
        Ok(())
    }

    fn required_text_environment(key: &str) -> io::Result<String> {
        std::env::var(key).map_err(|_| {
            io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!("required run guardian environment {key} is missing or non-Unicode"),
            )
        })
    }

    fn required_os_environment(key: &str) -> io::Result<OsString> {
        std::env::var_os(key).ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!("required run guardian environment {key} is missing"),
            )
        })
    }

    fn required_positive_i32_environment(key: &str) -> io::Result<i32> {
        required_text_environment(key)?
            .parse::<i32>()
            .ok()
            .filter(|value| *value > 1)
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    format!("run guardian environment {key} is not a safe positive PID"),
                )
            })
    }

    fn required_exact_fd_environment(key: &str, expected: i32) -> io::Result<RawFd> {
        let actual = required_text_environment(key)?
            .parse::<i32>()
            .map_err(|_| invalid("run guardian inherited FD is invalid"))?;
        if actual == expected {
            Ok(actual)
        } else {
            Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!("run guardian FD {key} is {actual}, expected {expected}"),
            ))
        }
    }

    fn inherited_unix_stream(descriptor: RawFd) -> io::Result<UnixStream> {
        set_close_on_exec(descriptor)?;
        let socket_type = socket_type(descriptor)?;
        if socket_type != libc::SOCK_STREAM {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "run guardian inherited descriptor is not a stream socket",
            ));
        }
        // SAFETY: each exact inherited descriptor is validated and consumed once.
        Ok(unsafe { UnixStream::from_raw_fd(descriptor) })
    }

    fn socket_type(descriptor: RawFd) -> io::Result<i32> {
        let mut value = 0_i32;
        let mut length = std::mem::size_of::<i32>() as libc::socklen_t;
        loop {
            let result = unsafe {
                libc::getsockopt(
                    descriptor,
                    libc::SOL_SOCKET,
                    libc::SO_TYPE,
                    (&mut value as *mut i32).cast(),
                    &mut length,
                )
            };
            if result == 0 {
                if length as usize != std::mem::size_of::<i32>() {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "SO_TYPE returned an invalid length",
                    ));
                }
                return Ok(value);
            }
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
    }

    fn canonical_private_root(root: &Path) -> io::Result<PathBuf> {
        if !root.is_absolute() {
            return Err(invalid("run guardian root must be absolute"));
        }
        let root = std::fs::canonicalize(root)?;
        let metadata = std::fs::metadata(&root)?;
        if !metadata.is_dir()
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.permissions().mode() & 0o777 != 0o700
            || metadata.nlink() < 2
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "run guardian root must be an owner-private 0700 directory with a valid link count",
            ));
        }
        Ok(root)
    }

    fn inherited_tree_environment(
        expected_generation: &str,
    ) -> io::Result<BTreeMap<OsString, OsString>> {
        let required = required_os_environment(tree_guard::REQUIRED_ENV)?;
        if required != OsStr::new("1") {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "process tree guard requirement must equal 1",
            ));
        }
        let path = required_os_environment(tree_guard::PATH_ENV)?;
        if !Path::new(&path).is_absolute() {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "process tree guard path must be absolute",
            ));
        }
        let generation = required_text_environment(tree_guard::GENERATION_ENV)?;
        if generation != expected_generation {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "process tree guard generation does not match guardian identity",
            ));
        }
        Ok(BTreeMap::from([
            (OsString::from(tree_guard::REQUIRED_ENV), required),
            (OsString::from(tree_guard::PATH_ENV), path),
            (
                OsString::from(tree_guard::GENERATION_ENV),
                OsString::from(generation),
            ),
            (
                OsString::from(tree_guard::PARENT_PID_ENV),
                OsString::from(std::process::id().to_string()),
            ),
        ]))
    }

    fn inherited_trace_environment() -> io::Result<BTreeMap<OsString, OsString>> {
        let enabled = std::env::var_os(FAULT_GATE_ENV);
        let log = std::env::var_os(FAULT_EVENT_LOG_ENV);
        match (enabled, log) {
            (None, None) => Ok(BTreeMap::new()),
            (Some(enabled), Some(log)) if enabled == OsStr::new("1") => {
                crate::fault_trace::InteractiveFaultPause::from_environment(true)
                    .map_err(io::Error::other)?;
                let mut values = BTreeMap::from([
                    (OsString::from(FAULT_GATE_ENV), enabled),
                    (OsString::from(FAULT_EVENT_LOG_ENV), log),
                ]);
                if let Some(value) =
                    std::env::var_os(crate::fault_trace::INTERACTIVE_FAULT_PAUSE_ENV)
                {
                    values.insert(
                        OsString::from(crate::fault_trace::INTERACTIVE_FAULT_PAUSE_ENV),
                        value,
                    );
                }
                Ok(values)
            }
            _ => Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "run guardian fault trace environment is partial or invalid",
            )),
        }
    }

    fn inherited_builtin_toolchains_root() -> io::Result<Option<PathBuf>> {
        let Some(configured) = std::env::var_os(crate::request_validation::BUILTIN_TOOLCHAINS_ENV)
        else {
            return Ok(None);
        };
        let canonical = std::fs::canonicalize(PathBuf::from(configured))
            .map_err(|error| contextual(error, "canonicalize built-in toolchain root"))?;
        if !canonical.is_absolute() || !canonical.is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "built-in toolchain root must be an absolute existing directory",
            ));
        }
        Ok(Some(canonical))
    }

    fn resolve_executor_executable() -> io::Result<PathBuf> {
        if let Some(path) = std::env::var_os("JUDGEDESK_EXECUTOR_PATH") {
            let candidate = PathBuf::from(path);
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
        let current = std::env::current_exe()?;
        let file_name = current.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if file_name.starts_with("judgedesk-native-executor")
            || file_name.starts_with("judgedesk-executor")
        {
            return Ok(current);
        }
        if let Some(deps_parent) = current.parent().and_then(|p| p.parent()) {
            let candidate = deps_parent.join("judgedesk-native-executor");
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
        Ok(current)
    }

    pub fn trusted_current_executable() -> io::Result<PathBuf> {
        let executable = resolve_executor_executable()?;
        let executable = std::fs::canonicalize(executable)?;
        if executable.is_absolute() && executable.is_file() {
            Ok(executable)
        } else {
            Err(invalid(
                "run guardian current executable is not an absolute regular file",
            ))
        }
    }

    fn insert_text_environment(
        environment: &mut BTreeMap<OsString, OsString>,
        key: &str,
        value: &str,
    ) -> io::Result<()> {
        insert_os_environment(environment, key, OsString::from(value))
    }

    fn insert_os_environment(
        environment: &mut BTreeMap<OsString, OsString>,
        key: &str,
        value: OsString,
    ) -> io::Result<()> {
        if environment.insert(OsString::from(key), value).is_some() {
            Err(invalid("duplicate internal child environment key"))
        } else {
            Ok(())
        }
    }

    fn extend_unique_environment(
        environment: &mut BTreeMap<OsString, OsString>,
        values: BTreeMap<OsString, OsString>,
    ) -> io::Result<()> {
        for (key, value) in values {
            if environment.insert(key, value).is_some() {
                return Err(invalid("duplicate internal child environment key"));
            }
        }
        Ok(())
    }

    fn cloexec_stream_pair() -> io::Result<(UnixStream, UnixStream)> {
        let pair = UnixStream::pair()?;
        require_close_on_exec(pair.0.as_raw_fd())?;
        require_close_on_exec(pair.1.as_raw_fd())?;
        Ok(pair)
    }

    fn spawn_internal_child(
        executable: &Path,
        mode: &str,
        environment: &BTreeMap<OsString, OsString>,
        mappings: &[(RawFd, RawFd)],
    ) -> io::Result<GuardianChild> {
        validate_child_mappings(mode, mappings)?;
        let executable_c = path_cstring(executable)?;
        let mode_c = CString::new(mode).map_err(|_| invalid("internal mode contains NUL"))?;
        let argv_storage = [executable_c.clone(), mode_c];
        let argv: [*mut libc::c_char; 3] = [
            argv_storage[0].as_ptr().cast_mut(),
            argv_storage[1].as_ptr().cast_mut(),
            std::ptr::null_mut(),
        ];
        let environment_storage = environment
            .iter()
            .map(|(key, value)| environment_cstring(key, value))
            .collect::<io::Result<Vec<_>>>()?;
        let mut environment_pointers = environment_storage
            .iter()
            .map(|entry| entry.as_ptr().cast_mut())
            .collect::<Vec<*mut libc::c_char>>();
        environment_pointers.push(std::ptr::null_mut());

        let mut file_actions = PosixSpawnFileActions::new()?;
        let devnull = CString::new("/dev/null")
            .map_err(|error| io::Error::other(format!("invalid static /dev/null path: {error}")))?;
        for descriptor in [libc::STDIN_FILENO, libc::STDOUT_FILENO, libc::STDERR_FILENO] {
            file_actions.add_open(descriptor, &devnull, libc::O_RDWR | libc::O_NOFOLLOW, 0)?;
        }
        let mut mapping_sources = Vec::with_capacity(mappings.len());
        for (source, destination) in mappings {
            mapping_sources.push((duplicate_high_cloexec(*source)?, *destination));
        }
        for (source, destination) in &mapping_sources {
            file_actions.add_dup2(source.as_raw_fd(), *destination)?;
        }
        let attributes = PosixSpawnAttributes::cloexec_default()?;
        let mut child_pid = 0_i32;
        let result = unsafe {
            libc::posix_spawn(
                &mut child_pid,
                executable_c.as_ptr(),
                file_actions.as_ptr(),
                attributes.as_ptr(),
                argv.as_ptr(),
                environment_pointers.as_ptr(),
            )
        };
        if result != 0 {
            return Err(io::Error::new(
                io::Error::from_raw_os_error(result).kind(),
                format!(
                    "posix_spawn internal mode {mode}: {}",
                    io::Error::from_raw_os_error(result)
                ),
            ));
        }
        if child_pid <= 1 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "posix_spawn returned an invalid internal child PID",
            ));
        }
        Ok(GuardianChild {
            pid: child_pid,
            reaped: None,
        })
    }

    fn validate_child_mappings(mode: &str, mappings: &[(RawFd, RawFd)]) -> io::Result<()> {
        let mut destinations = std::collections::BTreeSet::new();
        for (source, destination) in mappings {
            if *source < 0
                || !matches!(*destination, INTERNAL_CONTROL_FD | INTERNAL_DIRECT_FD)
                || !destinations.insert(*destination)
            {
                return Err(invalid("internal child FD mapping is invalid"));
            }
        }
        let required = match mode {
            crate::guardian_protocol::MACOS_PAIR_MEMBER_ARGUMENT => {
                std::collections::BTreeSet::from([INTERNAL_CONTROL_FD])
            }
            MACOS_RUN_GUARDIAN_ARGUMENT | MACOS_RUN_SUPERVISOR_ARGUMENT => {
                std::collections::BTreeSet::from([INTERNAL_CONTROL_FD, INTERNAL_DIRECT_FD])
            }
            _ => return Err(invalid("unknown internal child mode")),
        };
        if destinations == required {
            Ok(())
        } else {
            Err(invalid(
                "internal child FD mappings do not match its trusted mode",
            ))
        }
    }

    fn duplicate_high_cloexec(descriptor: RawFd) -> io::Result<OwnedFd> {
        loop {
            let duplicate =
                unsafe { libc::fcntl(descriptor, libc::F_DUPFD_CLOEXEC, MIN_DUPLICATED_CHILD_FD) };
            if duplicate >= 0 {
                // SAFETY: F_DUPFD_CLOEXEC returned a new owned descriptor.
                return Ok(unsafe { OwnedFd::from_raw_fd(duplicate) });
            }
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
    }

    struct PosixSpawnFileActions {
        raw: libc::posix_spawn_file_actions_t,
    }

    impl PosixSpawnFileActions {
        fn new() -> io::Result<Self> {
            let mut raw = std::ptr::null_mut();
            let result = unsafe { libc::posix_spawn_file_actions_init(&mut raw) };
            if result == 0 {
                Ok(Self { raw })
            } else {
                Err(posix_spawn_api_error(
                    "initialize internal child file actions",
                    result,
                ))
            }
        }

        fn add_open(
            &mut self,
            descriptor: RawFd,
            path: &CString,
            flags: i32,
            mode: libc::mode_t,
        ) -> io::Result<()> {
            let result = unsafe {
                libc::posix_spawn_file_actions_addopen(
                    &mut self.raw,
                    descriptor,
                    path.as_ptr(),
                    flags,
                    mode,
                )
            };
            require_posix_spawn_api("add internal child open action", result)
        }

        fn add_dup2(&mut self, source: RawFd, destination: RawFd) -> io::Result<()> {
            let result = unsafe {
                libc::posix_spawn_file_actions_adddup2(&mut self.raw, source, destination)
            };
            require_posix_spawn_api("add internal child descriptor mapping", result)
        }

        fn as_ptr(&self) -> *const libc::posix_spawn_file_actions_t {
            &self.raw
        }
    }

    impl Drop for PosixSpawnFileActions {
        fn drop(&mut self) {
            unsafe {
                libc::posix_spawn_file_actions_destroy(&mut self.raw);
            }
        }
    }

    struct PosixSpawnAttributes {
        raw: libc::posix_spawnattr_t,
    }

    impl PosixSpawnAttributes {
        fn cloexec_default() -> io::Result<Self> {
            let mut raw = std::ptr::null_mut();
            let result = unsafe { libc::posix_spawnattr_init(&mut raw) };
            if result != 0 {
                return Err(posix_spawn_api_error(
                    "initialize internal child spawn attributes",
                    result,
                ));
            }
            let mut attributes = Self { raw };
            let flags = libc::c_short::try_from(libc::POSIX_SPAWN_CLOEXEC_DEFAULT)
                .map_err(|_| io::Error::other("CLOEXEC_DEFAULT flag does not fit c_short"))?;
            let result = unsafe { libc::posix_spawnattr_setflags(&mut attributes.raw, flags) };
            require_posix_spawn_api("set internal child CLOEXEC_DEFAULT", result)?;
            Ok(attributes)
        }

        fn as_ptr(&self) -> *const libc::posix_spawnattr_t {
            &self.raw
        }
    }

    impl Drop for PosixSpawnAttributes {
        fn drop(&mut self) {
            unsafe {
                libc::posix_spawnattr_destroy(&mut self.raw);
            }
        }
    }

    fn require_posix_spawn_api(operation: &str, result: i32) -> io::Result<()> {
        if result == 0 {
            Ok(())
        } else {
            Err(posix_spawn_api_error(operation, result))
        }
    }

    fn posix_spawn_api_error(operation: &str, error_code: i32) -> io::Error {
        let error = io::Error::from_raw_os_error(error_code);
        io::Error::new(error.kind(), format!("{operation}: {error}"))
    }

    fn environment_cstring(key: &OsStr, value: &OsStr) -> io::Result<CString> {
        if key.as_bytes().is_empty() || key.as_bytes().contains(&b'=') {
            return Err(invalid("internal child environment key is invalid"));
        }
        let mut entry = Vec::with_capacity(key.as_bytes().len() + value.as_bytes().len() + 1);
        entry.extend_from_slice(key.as_bytes());
        entry.push(b'=');
        entry.extend_from_slice(value.as_bytes());
        CString::new(entry).map_err(|_| invalid("internal child environment contains NUL"))
    }

    fn path_cstring(path: &Path) -> io::Result<CString> {
        CString::new(path.as_os_str().as_bytes())
            .map_err(|_| invalid("internal executable path contains NUL"))
    }

    fn install_signal_policy() -> io::Result<()> {
        let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
        action.sa_sigaction = libc::SIG_IGN;
        if unsafe { libc::sigemptyset(&mut action.sa_mask) } != 0 {
            return Err(io::Error::last_os_error());
        }
        loop {
            if unsafe { libc::sigaction(libc::SIGPIPE, &action, std::ptr::null_mut()) } == 0 {
                return Ok(());
            }
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
    }

    fn set_close_on_exec(descriptor: RawFd) -> io::Result<()> {
        let flags = descriptor_flags(descriptor)?;
        loop {
            if unsafe { libc::fcntl(descriptor, libc::F_SETFD, flags | libc::FD_CLOEXEC) } >= 0 {
                return Ok(());
            }
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
    }

    fn require_close_on_exec(descriptor: RawFd) -> io::Result<()> {
        if descriptor_flags(descriptor)? & libc::FD_CLOEXEC != 0 {
            Ok(())
        } else {
            Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "new internal channel is not close-on-exec",
            ))
        }
    }

    fn descriptor_flags(descriptor: RawFd) -> io::Result<i32> {
        loop {
            let flags = unsafe { libc::fcntl(descriptor, libc::F_GETFD) };
            if flags >= 0 {
                return Ok(flags);
            }
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
    }

    fn terminate_startup_child(child: &mut GuardianChild) {
        match child.terminate_and_wait(STARTUP_TIMEOUT) {
            Ok(Some(_)) => {}
            Ok(None) => {
                eprintln!("JudgeDesk internal startup child could not be reaped; generation guard remains held");
                hold_generation_guard_forever();
            }
            Err(error) => {
                eprintln!("JudgeDesk internal startup child cleanup failed: {error}; generation guard remains held");
                hold_generation_guard_forever();
            }
        }
    }

    fn require_group_signal_sent(
        outcome: GroupSignalOutcome,
        anchor: ProcessIdentity,
        signal: i32,
    ) -> io::Result<()> {
        match outcome {
            GroupSignalOutcome::Sent => Ok(()),
            GroupSignalOutcome::GroupMissing => Err(io::Error::new(
                io::ErrorKind::NotFound,
                format!(
                    "live anchored process group {} disappeared before signal {signal}",
                    anchor.pgid
                ),
            )),
        }
    }

    fn signal_exited_anchor_group_for_pair_release(
        watcher: &mut AnchorExitWatcher,
        pgid: i32,
        signal: i32,
    ) -> io::Result<()> {
        match crate::macos_process::signal_exited_anchor_group(watcher, signal) {
            Ok(_) => Ok(()),
            // Darwin XNU killpg1 returns EPERM when every remaining member of an existing
            // process group has transitioned to SZOMB before the signal is delivered.
            // Never treat raw EPERM as a drain proof: corroborate that the owned anchor
            // remains pinned and no live member remains in the group.
            Err(error) if error.raw_os_error() == Some(libc::EPERM) => {
                if watcher.poll_exit_unreaped()?
                    && crate::macos_process::inventory_live_process_group(pgid)?
                        .members
                        .is_empty()
                {
                    Ok(())
                } else {
                    Err(error)
                }
            }
            Err(error) => Err(error),
        }
    }

    fn hold_generation_guard_forever() -> ! {
        loop {
            unsafe {
                libc::pause();
            }
        }
    }

    fn checked_deadline(timeout: Duration) -> io::Result<Instant> {
        Instant::now()
            .checked_add(timeout)
            .ok_or_else(|| invalid("internal protocol timeout is too large"))
    }

    fn invalid(message: &str) -> io::Error {
        io::Error::new(io::ErrorKind::InvalidInput, message)
    }

    fn contextual(error: io::Error, context: &str) -> io::Error {
        io::Error::new(error.kind(), format!("{context}: {error}"))
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::fs::{self, File};
        use std::io::Read;
        use std::os::fd::{FromRawFd, OwnedFd};
        use std::time::{SystemTime, UNIX_EPOCH};

        #[test]
        fn internal_child_descriptors_are_exact_for_each_trusted_mode() {
            let member = crate::guardian_protocol::MACOS_PAIR_MEMBER_ARGUMENT;
            let control = [(10, INTERNAL_CONTROL_FD)];
            let both = [(10, INTERNAL_CONTROL_FD), (11, INTERNAL_DIRECT_FD)];
            assert!(validate_child_mappings(member, &control).is_ok());
            assert!(validate_child_mappings(member, &both).is_err());
            for mode in [MACOS_RUN_GUARDIAN_ARGUMENT, MACOS_RUN_SUPERVISOR_ARGUMENT] {
                assert!(validate_child_mappings(mode, &both).is_ok());
                assert!(validate_child_mappings(mode, &control).is_err());
            }
            assert!(validate_child_mappings("unknown", &both).is_err());
            assert!(validate_child_mappings(member, &[(-1, INTERNAL_CONTROL_FD)]).is_err());
            assert!(validate_child_mappings(member, &[(10, INTERNAL_DIRECT_FD)]).is_err());
            assert!(validate_child_mappings(
                member,
                &[(10, INTERNAL_CONTROL_FD), (11, INTERNAL_CONTROL_FD)]
            )
            .is_err());
        }

        struct TestDirectory(PathBuf);

        impl TestDirectory {
            fn new() -> Self {
                let nonce = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .expect("test clock after Unix epoch")
                    .as_nanos();
                let path = std::env::temp_dir().join(format!(
                    "judgedesk-posix-spawn-test-{}-{nonce}",
                    std::process::id()
                ));
                fs::create_dir(&path).expect("create POSIX spawn test directory");
                Self(path)
            }
        }

        impl Drop for TestDirectory {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }

        #[test]
        fn guardian_control_preserves_fragmented_frames_between_session_polls() {
            use crate::guardian_io::{FrameRead, FrameReader};
            use std::io::Write;

            let identity =
                FrameIdentity::new("11".repeat(32), "22".repeat(32), "fragmented-cancel".into())
                    .expect("frame identity");
            let mut frame = Vec::new();
            write_authenticated_frame(
                &mut frame,
                &GuardianCommand::cancel(&identity, CleanupCause::Cancelled),
                &identity,
            )
            .expect("encode cancel");
            for split in [1, 2, 3, 4, frame.len() - 1] {
                let (control, mut sender) = UnixStream::pair().expect("control pair");
                control
                    .set_read_timeout(Some(Duration::from_millis(2)))
                    .expect("bounded session read");
                let mut session = GuardianSession {
                    identity: identity.clone(),
                    guardian: ProcessIdentity {
                        pid: 10,
                        pgid: 10,
                        start_abstime: 1,
                    },
                    root: std::env::temp_dir(),
                    control,
                    control_reader: FrameReader::new(),
                    control_open: true,
                    supervisor_direct: None,
                    trace: None,
                    containment_active: false,
                    sandbox_profile: None,
                    paired: false,
                    pair_member: None,
                };
                sender
                    .write_all(&frame[..split])
                    .expect("write frame prefix");
                assert!(matches!(
                    session
                        .read_executor_command()
                        .expect("partial command yields"),
                    FrameRead::Pending
                ));
                sender
                    .write_all(&frame[split..])
                    .expect("write frame suffix");
                assert!(matches!(
                    session.read_executor_command().expect("resume command"),
                    FrameRead::Frame(GuardianCommand::Cancel {
                        cause: CleanupCause::Cancelled,
                        ..
                    })
                ));
                // Parallel containment tests fork; their transient inherited copies must not
                // postpone this fixture's EOF. shutdown acts on the socket endpoint itself.
                sender
                    .shutdown(std::net::Shutdown::Write)
                    .expect("close sender write half");
                drop(sender);
                assert!(matches!(
                    session.read_executor_command().expect("frame boundary EOF"),
                    FrameRead::Eof
                ));
                assert!(!session.control_open);
            }
        }

        #[test]
        fn posix_spawn_closes_ambient_descriptors_and_preserves_only_mappings() {
            let directory = TestDirectory::new();
            let script = directory.0.join("inspect-fds.sh");
            fs::write(
                &script,
                concat!(
                    "#!/bin/sh\n",
                    "if [ -e \"/dev/fd/$AMBIENT_FD\" ]; then\n",
                    "  printf 'ambient-open\\n' >&3\n",
                    "  exit 91\n",
                    "fi\n",
                    "printf 'control-ok\\n' >&3\n",
                    "printf 'direct-ok\\n' >&4\n",
                ),
            )
            .expect("write descriptor inspection script");
            fs::set_permissions(&script, fs::Permissions::from_mode(0o500))
                .expect("make owned descriptor inspection script executable");

            let source = File::open("/dev/null").expect("open ambient descriptor source");
            let ambient_raw = unsafe { libc::fcntl(source.as_raw_fd(), libc::F_DUPFD, 99) };
            assert!(
                ambient_raw >= 99,
                "duplicate ambient descriptor: {}",
                io::Error::last_os_error()
            );
            // SAFETY: F_DUPFD returned a new owned descriptor.
            let ambient = unsafe { OwnedFd::from_raw_fd(ambient_raw) };

            let (mut control_parent, control_child) =
                cloexec_stream_pair().expect("control stream pair");
            let (mut direct_parent, direct_child) =
                cloexec_stream_pair().expect("direct stream pair");
            control_parent
                .set_read_timeout(Some(Duration::from_secs(2)))
                .expect("control read timeout");
            direct_parent
                .set_read_timeout(Some(Duration::from_secs(2)))
                .expect("direct read timeout");
            let environment = BTreeMap::from([(
                OsString::from("AMBIENT_FD"),
                OsString::from(ambient.as_raw_fd().to_string()),
            )]);

            let mut child = spawn_internal_child(
                &script,
                MACOS_RUN_SUPERVISOR_ARGUMENT,
                &environment,
                &[
                    (control_child.as_raw_fd(), INTERNAL_CONTROL_FD),
                    (direct_child.as_raw_fd(), INTERNAL_DIRECT_FD),
                ],
            )
            .expect("spawn descriptor inspection child");
            drop(control_child);
            drop(direct_child);

            let status = child
                .wait_timeout(Duration::from_secs(2))
                .expect("wait descriptor inspection child")
                .expect("descriptor inspection child timed out");
            let mut control_message = String::new();
            let mut direct_message = String::new();
            control_parent
                .read_to_string(&mut control_message)
                .expect("read mapped control descriptor");
            direct_parent
                .read_to_string(&mut direct_message)
                .expect("read mapped direct descriptor");

            assert!(status.success(), "descriptor inspection failed: {status}");
            assert_eq!(control_message, "control-ok\n");
            assert_eq!(direct_message, "direct-ok\n");
        }

        struct TestExternalGroupZombie {
            reaper_pid: i32,
            zombie_pid: i32,
            release_write: Option<File>,
        }

        impl TestExternalGroupZombie {
            fn new(pgid: i32) -> Self {
                let mut ready_fds = [-1_i32; 2];
                let mut release_fds = [-1_i32; 2];
                assert_eq!(unsafe { libc::pipe(ready_fds.as_mut_ptr()) }, 0);
                assert_eq!(unsafe { libc::pipe(release_fds.as_mut_ptr()) }, 0);
                let reaper_pid = unsafe { libc::fork() };
                assert!(reaper_pid >= 0, "fork external zombie reaper");
                if reaper_pid == 0 {
                    unsafe {
                        libc::close(ready_fds[0]);
                        libc::close(release_fds[1]);
                        if libc::setpgid(0, 0) != 0 {
                            libc::_exit(161);
                        }
                        let zombie = libc::fork();
                        if zombie < 0 {
                            libc::_exit(162);
                        }
                        if zombie == 0 {
                            libc::close(ready_fds[1]);
                            libc::close(release_fds[0]);
                            if libc::setpgid(0, pgid) != 0 {
                                libc::_exit(163);
                            }
                            libc::_exit(0);
                        }
                        let mut info: libc::siginfo_t = std::mem::zeroed();
                        if libc::waitid(
                            libc::P_PID,
                            zombie as libc::id_t,
                            &mut info,
                            libc::WEXITED | libc::WNOWAIT,
                        ) != 0
                        {
                            libc::_exit(164);
                        }
                        let bytes = zombie.to_ne_bytes();
                        if libc::write(ready_fds[1], bytes.as_ptr().cast(), bytes.len())
                            != bytes.len() as isize
                        {
                            libc::_exit(165);
                        }
                        libc::close(ready_fds[1]);
                        let mut poll = libc::pollfd {
                            fd: release_fds[0],
                            events: libc::POLLIN,
                            revents: 0,
                        };
                        libc::poll(&mut poll, 1, 5_000);
                        libc::close(release_fds[0]);
                        let mut status = 0_i32;
                        let _ = libc::waitpid(zombie, &mut status, 0);
                        libc::_exit(0);
                    }
                }
                unsafe {
                    libc::close(ready_fds[1]);
                    libc::close(release_fds[0]);
                }
                let mut ready_read = unsafe { File::from_raw_fd(ready_fds[0]) };
                let release_write = unsafe { File::from_raw_fd(release_fds[1]) };
                let mut pid_bytes = [0_u8; std::mem::size_of::<i32>()];
                ready_read
                    .read_exact(&mut pid_bytes)
                    .expect("read external zombie pid");
                Self {
                    reaper_pid,
                    zombie_pid: i32::from_ne_bytes(pid_bytes),
                    release_write: Some(release_write),
                }
            }

            fn release(&mut self) {
                drop(self.release_write.take());
            }
        }

        impl Drop for TestExternalGroupZombie {
            fn drop(&mut self) {
                self.release();
                loop {
                    if unsafe { libc::waitpid(self.reaper_pid, std::ptr::null_mut(), 0) }
                        == self.reaper_pid
                    {
                        break;
                    }
                    if io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
                        break;
                    }
                }
            }
        }

        fn wait_until_zombie_unreaped(pid: i32) {
            let deadline = Instant::now() + Duration::from_secs(2);
            loop {
                let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
                let rc = unsafe {
                    libc::waitid(
                        libc::P_PID,
                        pid as libc::id_t,
                        &mut info,
                        libc::WEXITED | libc::WNOWAIT | libc::WNOHANG,
                    )
                };
                assert_eq!(rc, 0, "waitid failed: {}", io::Error::last_os_error());
                if unsafe { info.si_pid() } != 0 {
                    return;
                }
                assert!(
                    Instant::now() < deadline,
                    "timed out waiting for pid {pid} to become unreaped zombie"
                );
                thread::sleep(Duration::from_millis(1));
            }
        }

        #[test]
        fn await_pair_member_release_waits_for_untrusted_zombie_without_zombie_group_eperm() {
            use std::os::unix::process::CommandExt;
            use std::process::Command;

            let mut anchor_child = Command::new("/bin/sleep")
                .arg("30")
                .process_group(0)
                .spawn()
                .expect("spawn anchor group leader");
            let anchor_pid = anchor_child.id() as i32;
            let anchor = read_process_identity(anchor_pid).expect("read anchor identity");
            let mut watcher = AnchorExitWatcher::new(anchor).expect("watch anchor");

            let mut member_child = Command::new("/bin/sleep")
                .arg("30")
                .process_group(anchor.pgid)
                .spawn()
                .expect("spawn paired member in anchor group");
            let member_pid = member_child.id() as i32;
            let member = read_process_identity(member_pid).expect("read member identity");

            let mut external_zombie = TestExternalGroupZombie::new(anchor.pgid);
            let zombie_pid = external_zombie.zombie_pid;

            assert_eq!(unsafe { libc::kill(anchor.pid, libc::SIGKILL) }, 0);
            assert_eq!(unsafe { libc::kill(member.pid, libc::SIGKILL) }, 0);
            watcher
                .wait_for_exit_unreaped(crate::macos_process::DrainOptions::default(), |_| {})
                .expect("wait for anchor unreaped exit");
            wait_until_zombie_unreaped(member.pid);

            let initial_snapshot = crate::macos_process::inventory_live_process_group(anchor.pgid)
                .expect("inventory zombie-only group");
            assert!(
                initial_snapshot.members.is_empty(),
                "expected zero live members, got {initial_snapshot:?}"
            );
            assert!(
                initial_snapshot.zombie_pids.contains(&anchor.pid)
                    && initial_snapshot.zombie_pids.contains(&member.pid)
                    && initial_snapshot.zombie_pids.contains(&zombie_pid),
                "expected anchor, member, and untrusted zombie in group: {initial_snapshot:?}"
            );

            let identity = FrameIdentity::new(
                "11".repeat(32),
                "22".repeat(32),
                "paired-zombie-release".into(),
            )
            .expect("frame identity");
            let (control, mut executor_control) = UnixStream::pair().expect("control socket pair");
            control
                .set_read_timeout(Some(SESSION_READ_TIMEOUT))
                .expect("control read timeout");
            control
                .set_write_timeout(Some(SESSION_WRITE_TIMEOUT))
                .expect("control write timeout");
            executor_control
                .set_read_timeout(Some(Duration::from_secs(2)))
                .expect("executor read timeout");
            let (supervisor_stream, _supervisor_peer) =
                UnixStream::pair().expect("supervisor stream pair");

            let mut session = GuardianSession {
                identity: identity.clone(),
                guardian: ProcessIdentity {
                    pid: std::process::id() as i32,
                    pgid: anchor.pgid,
                    start_abstime: 1,
                },
                root: std::env::temp_dir(),
                control,
                control_reader: FrameReader::new(),
                control_open: true,
                supervisor_direct: None,
                trace: None,
                containment_active: true,
                sandbox_profile: None,
                paired: true,
                pair_member: Some(member),
            };
            let mut runtime = SupervisorRuntime {
                stream: supervisor_stream,
                reader: FrameReader::new(),
                anchor,
                watcher,
            };

            let controller_thread = thread::spawn(move || -> io::Result<()> {
                thread::sleep(Duration::from_millis(15));
                external_zombie.release();
                let event: Option<GuardianEvent> =
                    read_authenticated_frame(&mut executor_control, &identity)?;
                match event {
                    Some(GuardianEvent::PairQuiescent {
                        anchor: observed_anchor,
                        member: observed_member,
                        ..
                    }) => {
                        assert_eq!(observed_anchor, anchor);
                        assert_eq!(observed_member, member);
                        let _ = member_child.wait();
                        Ok(())
                    }
                    other => Err(io::Error::other(format!(
                        "expected PairQuiescent event, received {other:?}"
                    ))),
                }
            });

            let release_result = session.await_pair_member_release(&mut runtime);
            let _ = session.control.shutdown(std::net::Shutdown::Both);
            let controller_result = controller_thread.join().expect("join controller thread");
            let _ = anchor_child.wait();

            release_result
                .expect("await_pair_member_release should succeed without zombie-only EPERM");
            controller_result.expect("executor should receive PairQuiescent and reap member");
        }

        #[test]
        fn signal_exited_anchor_group_for_pair_release_corroborates_zombie_only_eperm() {
            use std::os::unix::process::CommandExt;
            use std::process::Command;

            let mut anchor_child = Command::new("/bin/sleep")
                .arg("30")
                .process_group(0)
                .spawn()
                .expect("spawn anchor group leader");
            let anchor_pid = anchor_child.id() as i32;
            let anchor = read_process_identity(anchor_pid).expect("read anchor identity");
            let mut watcher = AnchorExitWatcher::new(anchor).expect("watch anchor");

            assert_eq!(unsafe { libc::kill(anchor.pid, libc::SIGKILL) }, 0);
            watcher
                .wait_for_exit_unreaped(crate::macos_process::DrainOptions::default(), |_| {})
                .expect("wait for anchor unreaped exit");

            assert_eq!(
                crate::macos_process::signal_exited_anchor_group(&watcher, libc::SIGSTOP)
                    .expect_err("raw Darwin group signal to zombie-only group returns EPERM")
                    .raw_os_error(),
                Some(libc::EPERM)
            );
            for signal in [libc::SIGSTOP, libc::SIGKILL] {
                signal_exited_anchor_group_for_pair_release(&mut watcher, anchor.pgid, signal)
                    .expect("corroborated zombie-only EPERM should succeed");
            }
            let _ = anchor_child.wait();
        }
    }
}

#[cfg(target_os = "macos")]
pub use imp::{
    spawn_run_guardian, trusted_current_executable, try_run_internal_mode, GuardianChild,
    SpawnedRunGuardian,
};

#[cfg(target_os = "macos")]
pub(crate) use imp::spawn_run_guardian_with_failure;
#[cfg(target_os = "macos")]
pub(crate) use imp::{spawn_pair_member, SpawnedPairMember};

#[cfg(not(target_os = "macos"))]
pub fn trusted_current_executable() -> io::Result<std::path::PathBuf> {
    std::env::current_exe()
}

#[cfg(not(target_os = "macos"))]
#[derive(Debug)]
pub struct GuardianChild;

#[cfg(not(target_os = "macos"))]
impl GuardianChild {
    pub fn pid(&self) -> i32 {
        0
    }

    pub fn try_wait(&mut self) -> io::Result<Option<std::process::ExitStatus>> {
        Err(unsupported())
    }

    pub fn wait_timeout(
        &mut self,
        _timeout: Duration,
    ) -> io::Result<Option<std::process::ExitStatus>> {
        Err(unsupported())
    }

    pub fn wait(&mut self) -> io::Result<std::process::ExitStatus> {
        Err(unsupported())
    }

    pub fn terminate_and_wait(
        &mut self,
        _timeout: Duration,
    ) -> io::Result<Option<std::process::ExitStatus>> {
        Err(unsupported())
    }
}

#[cfg(not(target_os = "macos"))]
#[derive(Debug)]
pub struct SpawnedRunGuardian;

#[cfg(not(target_os = "macos"))]
pub fn try_run_internal_mode() -> Option<i32> {
    None
}

#[cfg(not(target_os = "macos"))]
pub fn spawn_run_guardian(
    _root: &Path,
    _identity: &FrameIdentity,
) -> io::Result<SpawnedRunGuardian> {
    Err(unsupported())
}

#[cfg(not(target_os = "macos"))]
fn unsupported() -> io::Error {
    io::Error::new(
        io::ErrorKind::Unsupported,
        "macOS run guardian is unavailable on this platform",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paired_nproc_ceiling_reserves_both_targets_and_supervisors() {
        assert_eq!(
            paired_launcher_nproc_ceiling(100, 1_000, 1, 0).expect("ordinary run"),
            107
        );
        assert_eq!(
            paired_launcher_nproc_ceiling(100, 1_000, 1, 32).expect("paired run"),
            142
        );
        assert_eq!(
            paired_launcher_nproc_ceiling(100, 173, 32, 32).expect("exact hard limit"),
            173
        );
        let error = paired_launcher_nproc_ceiling(100, 172, 32, 32)
            .expect_err("cannot fit pair below hard limit");
        assert!(error.contains("required=173"), "{error}");
        assert!(error.contains("hardMax=172"), "{error}");
    }

    #[test]
    fn paired_nproc_ceiling_rejects_invalid_budgets_and_arithmetic_overflow() {
        for (own, peer) in [(0, 1), (33, 1), (1, 33), (u32::MAX, u32::MAX)] {
            assert!(paired_launcher_nproc_ceiling(100, 1_000, own, peer).is_err());
        }
        assert!(paired_launcher_nproc_ceiling(u64::MAX, u64::MAX, 1, 1).is_err());
        assert!(paired_launcher_nproc_ceiling(u64::MAX, u64::MAX, 1, 0).is_err());
    }

    #[test]
    fn paired_nproc_reserves_the_two_trusted_executor_owned_members() {
        assert_eq!(
            paired_launcher_nproc_ceiling(100, 173, 32, 32).expect("pair fits exactly"),
            173
        );
        assert!(
            paired_launcher_nproc_ceiling(100, 172, 32, 32).is_err(),
            "member helpers cannot consume reserved target headroom"
        );
    }

    #[test]
    fn guardian_environment_allowlist_is_exact() {
        let required = [
            crate::guardian_protocol::GUARDIAN_TOKEN_ENV,
            crate::guardian_protocol::GUARDIAN_GENERATION_ENV,
            crate::guardian_protocol::GUARDIAN_RUN_ID_ENV,
            crate::guardian_protocol::GUARDIAN_PARENT_PID_ENV,
            crate::guardian_protocol::GUARDIAN_ROOT_ENV,
            crate::guardian_protocol::GUARDIAN_REGISTRATION_FD_ENV,
            GUARDIAN_SUPERVISOR_DIRECT_FD_ENV,
            crate::tree_guard::REQUIRED_ENV,
            crate::tree_guard::PATH_ENV,
            crate::tree_guard::GENERATION_ENV,
            crate::tree_guard::PARENT_PID_ENV,
            crate::request_validation::BUILTIN_TOOLCHAINS_ENV,
            crate::fault_trace::FAULT_GATE_ENV,
            crate::fault_trace::FAULT_EVENT_LOG_ENV,
        ];
        for key in required {
            assert!(
                is_allowed_guardian_environment_key(OsStr::new(key)),
                "required key rejected: {key}"
            );
        }
        for forbidden in [
            "PATH",
            "HOME",
            "DYLD_INSERT_LIBRARIES",
            "LD_PRELOAD",
            "JUDGEDESK_RUN_GUARDIAN_UNKNOWN",
        ] {
            assert!(
                !is_allowed_guardian_environment_key(OsStr::new(forbidden)),
                "unexpected key accepted: {forbidden}"
            );
        }
    }

    #[test]
    fn non_macos_internal_mode_is_not_claimed() {
        #[cfg(not(target_os = "macos"))]
        {
            assert_eq!(try_run_internal_mode(), None);
            let identity = FrameIdentity::new("11".repeat(32), "22".repeat(32), "run".into())
                .expect("identity");
            assert_eq!(
                spawn_run_guardian(Path::new("."), &identity)
                    .expect_err("non-macOS spawn must fail")
                    .kind(),
                io::ErrorKind::Unsupported
            );
        }
    }
}
