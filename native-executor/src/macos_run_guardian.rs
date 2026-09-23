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
            | crate::request_validation::BUILTIN_TOOLCHAINS_ENV
            | crate::fault_trace::FAULT_GATE_ENV
            | crate::fault_trace::FAULT_EVENT_LOG_ENV
    )
}

#[cfg(target_os = "macos")]
mod imp {
    use super::{
        CHILD_WAIT_POLL_INTERVAL, GUARDIAN_SUPERVISOR_DIRECT_FD_ENV, INTERNAL_CONTROL_FD,
        INTERNAL_DIRECT_FD, STARTUP_TIMEOUT,
    };
    use crate::fault_trace::{FaultTrace, FaultTraceEvent, FAULT_EVENT_LOG_ENV, FAULT_GATE_ENV};
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
    use std::io;
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

    #[derive(Debug)]
    pub struct GuardianChild {
        pid: i32,
        reaped: Option<ExitStatus>,
    }

    impl GuardianChild {
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
        identity.validate()?;
        let root = canonical_private_root(root)?;
        let tree_environment = inherited_tree_environment(&identity.generation)?;
        let trace_environment = inherited_trace_environment()?;
        let executable = trusted_current_executable()?;
        let (control_parent, control_child) = cloexec_stream_pair()?;
        let (direct_parent, direct_child) = cloexec_stream_pair()?;

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
            let _ = control_parent.set_read_timeout(None);
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
        control_open: bool,
        supervisor_direct: Option<UnixStream>,
        trace: Option<FaultTrace>,
        containment_active: bool,
        sandbox_profile: Option<PathBuf>,
    }

    struct SupervisorRuntime {
        stream: UnixStream,
        anchor: ProcessIdentity,
        watcher: AnchorExitWatcher,
    }

    struct PendingSupervisor {
        child: GuardianChild,
        stream: UnixStream,
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
            .map_err(|error| io::Error::new(io::ErrorKind::PermissionDenied, error))?
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "run guardian requires an independent generation guard",
                )
            })?;
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
        let mut session = GuardianSession {
            identity: environment.identity,
            guardian,
            root: environment.root,
            control: environment.control,
            control_open: true,
            supervisor_direct: Some(environment.supervisor_direct),
            trace,
            containment_active: false,
            sandbox_profile: None,
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
            let spec = match self.read_executor_command()? {
                Some(GuardianCommand::Start { spec, .. }) => *spec,
                Some(GuardianCommand::Cancel { .. }) | None => return Ok(()),
                Some(command) => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!("expected guardian_start, received {}", command.kind()),
                    ))
                }
            };

            let launcher_spec =
                crate::platform::macos::prepare_launcher_spec(&self.root, &spec, &self.identity)
                    .map_err(|error| io::Error::other(error.to_string()))?;
            self.sandbox_profile = Some(launcher_spec.sandbox_profile.clone());
            let pending = self.spawn_supervisor()?;
            self.containment_active = true;
            let (mut runtime, pending_cleanup) = self.wait_for_registration(pending)?;
            if let Some(cause) = pending_cleanup {
                return self.cleanup_and_finish(&mut runtime, cause);
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
                        return self
                            .cleanup_and_finish(&mut runtime, CleanupCause::ExecutorDisconnected);
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
        }

        fn spawn_supervisor(&mut self) -> io::Result<PendingSupervisor> {
            let direct = self.supervisor_direct.take().ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "supervisor direct channel was already transferred",
                )
            })?;
            let (guardian_parent, guardian_child) = cloexec_stream_pair()?;
            let executable = trusted_current_executable()?;
            let tree_environment = inherited_tree_environment(&self.identity.generation)?;
            let trace_environment = inherited_trace_environment()?;
            let mut environment = BTreeMap::new();
            insert_text_environment(&mut environment, SUPERVISOR_TOKEN_ENV, &self.identity.token)?;
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
                    return Ok(match self.read_executor_command()? {
                        Some(command) => RegisteredInput::Executor(command),
                        None => RegisteredInput::ExecutorEof,
                    });
                }
                if ready.supervisor {
                    return Ok(
                        match read_authenticated_frame::<_, SupervisorEvent>(
                            &mut &pending.stream,
                            &self.identity,
                        )? {
                            Some(event) => RegisteredInput::Supervisor(event),
                            None => RegisteredInput::SupervisorEof,
                        },
                    );
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
                    return Ok(match self.read_executor_command()? {
                        Some(command) => SessionInput::Executor(command),
                        None => SessionInput::ExecutorEof,
                    });
                }
                if ready.supervisor {
                    return Ok(
                        match read_authenticated_frame::<_, SupervisorEvent>(
                            &mut &runtime.stream,
                            &self.identity,
                        )? {
                            Some(event) => SessionInput::Supervisor(event),
                            None => SessionInput::SupervisorEof,
                        },
                    );
                }
            }
        }

        fn read_executor_command(&mut self) -> io::Result<Option<GuardianCommand>> {
            if !self.control_open {
                return Ok(None);
            }
            let command =
                read_authenticated_frame::<_, GuardianCommand>(&mut self.control, &self.identity)?;
            if command.is_none() {
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
        ]))
    }

    fn inherited_trace_environment() -> io::Result<BTreeMap<OsString, OsString>> {
        let enabled = std::env::var_os(FAULT_GATE_ENV);
        let log = std::env::var_os(FAULT_EVENT_LOG_ENV);
        match (enabled, log) {
            (None, None) => Ok(BTreeMap::new()),
            (Some(enabled), Some(log)) if enabled == OsStr::new("1") => Ok(BTreeMap::from([
                (OsString::from(FAULT_GATE_ENV), enabled),
                (OsString::from(FAULT_EVENT_LOG_ENV), log),
            ])),
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
        validate_child_mappings(mappings)?;
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
        let devnull = CString::new("/dev/null").expect("static /dev/null path has no NUL");
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

    fn validate_child_mappings(mappings: &[(RawFd, RawFd)]) -> io::Result<()> {
        let mut destinations = std::collections::BTreeSet::new();
        for (source, destination) in mappings {
            if *source < 0
                || !matches!(*destination, INTERNAL_CONTROL_FD | INTERNAL_DIRECT_FD)
                || !destinations.insert(*destination)
            {
                return Err(invalid("internal child FD mapping is invalid"));
            }
        }
        if destinations.len() == 2 {
            Ok(())
        } else {
            Err(invalid(
                "internal child requires distinct control and direct FD mappings",
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
        let _ = child.terminate_and_wait(STARTUP_TIMEOUT);
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
        fn posix_spawn_closes_ambient_descriptors_and_preserves_only_mappings() {
            let directory = TestDirectory::new();
            let script = directory.0.join("inspect-fds.sh");
            fs::write(
                &script,
                concat!(
                    "if [ -e \"/dev/fd/$AMBIENT_FD\" ]; then\n",
                    "  printf 'ambient-open\\n' >&3\n",
                    "  exit 91\n",
                    "fi\n",
                    "printf 'control-ok\\n' >&3\n",
                    "printf 'direct-ok\\n' >&4\n",
                ),
            )
            .expect("write descriptor inspection script");

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
                Path::new("/bin/sh"),
                script.to_str().expect("Unicode test script path"),
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
    }
}

#[cfg(target_os = "macos")]
pub use imp::{
    spawn_run_guardian, trusted_current_executable, try_run_internal_mode, GuardianChild,
    SpawnedRunGuardian,
};

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
