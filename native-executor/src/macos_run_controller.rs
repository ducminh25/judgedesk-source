//! Executor-side orchestration for one guarded macOS run.
//!
//! This module never discovers containment processes by PPID. The guardian identity comes from
//! the exact direct `GuardianChild`; the supervisor anchor comes from two independently
//! authenticated channels. A run becomes active only after both channels agree on that anchor.
//! The direct channel cross-checks protocol state and terminal results; it is deliberately not a
//! numeric signalling authority because the executor does not own the supervisor's direct-child
//! reap pin.

#[cfg(any(target_os = "macos", test))]
use crate::guardian_protocol::{CleanupCause, CleanupLatch, ProcessIdentity};
#[cfg(any(target_os = "macos", test))]
use std::io;

#[cfg(any(target_os = "macos", test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EventSource {
    Guardian,
    Direct,
}

#[cfg(any(target_os = "macos", test))]
#[derive(Debug, Default)]
struct ExecutorRunState {
    anchor: Option<ProcessIdentity>,
    direct_registered: bool,
    direct_ready: bool,
    guardian_started: bool,
    committed: bool,
    guardian_target_seen: bool,
    direct_target_seen: bool,
    target: Option<ProcessIdentity>,
    cleanup: CleanupLatch,
    guardian_prepared: bool,
    direct_prepared: bool,
}

#[cfg(any(target_os = "macos", test))]
impl ExecutorRunState {
    fn record_direct_registered(&mut self, anchor: ProcessIdentity) -> io::Result<()> {
        if self.direct_registered {
            return Err(invalid("duplicate direct supervisor registration"));
        }
        self.bind_anchor(anchor)?;
        self.direct_registered = true;
        Ok(())
    }

    fn record_direct_ready(&mut self, anchor: ProcessIdentity) -> io::Result<()> {
        if !self.direct_registered {
            return Err(invalid(
                "direct supervisor became ready before registration",
            ));
        }
        if self.direct_ready {
            return Err(invalid("duplicate direct supervisor ready event"));
        }
        self.require_anchor(anchor)?;
        self.direct_ready = true;
        Ok(())
    }

    fn record_guardian_started(&mut self, anchor: ProcessIdentity) -> io::Result<()> {
        if self.guardian_started {
            return Err(invalid("duplicate guardian started event"));
        }
        self.bind_anchor(anchor)?;
        self.guardian_started = true;
        Ok(())
    }

    fn proofs_complete(&self) -> bool {
        self.anchor.is_some()
            && self.direct_registered
            && self.direct_ready
            && self.guardian_started
    }

    fn record_committed(&mut self) -> io::Result<()> {
        if self.committed {
            return Err(invalid("duplicate executor active commit"));
        }
        if !self.proofs_complete() {
            return Err(invalid(
                "executor committed before both anchor proofs completed",
            ));
        }
        if self.cleanup.is_requested() {
            return Err(invalid("executor committed after cleanup was requested"));
        }
        self.committed = true;
        Ok(())
    }

    fn record_target(
        &mut self,
        source: EventSource,
        anchor: ProcessIdentity,
        target: ProcessIdentity,
    ) -> io::Result<()> {
        if !self.committed {
            return Err(invalid("target started before executor active commit"));
        }
        self.require_anchor(anchor)?;
        crate::guardian_protocol::validate_target_identity(&target, &anchor)?;
        let seen = match source {
            EventSource::Guardian => &mut self.guardian_target_seen,
            EventSource::Direct => &mut self.direct_target_seen,
        };
        if *seen {
            return Err(invalid("duplicate target-started event on one channel"));
        }
        if let Some(expected) = self.target {
            crate::guardian_protocol::authenticate_process_identity(&target, &expected)?;
        } else {
            self.target = Some(target);
        }
        *seen = true;
        Ok(())
    }

    fn request_cleanup(
        &mut self,
        anchor: Option<ProcessIdentity>,
        cause: CleanupCause,
    ) -> io::Result<()> {
        if let Some(anchor) = anchor {
            self.bind_anchor(anchor)?;
        }
        self.cleanup.request(cause);
        Ok(())
    }

    fn record_prepared(&mut self, source: EventSource, anchor: ProcessIdentity) -> io::Result<()> {
        self.require_anchor(anchor)?;
        if !self.cleanup.is_requested() {
            return Err(invalid("prepared result arrived before cleanup request"));
        }
        let prepared = match source {
            EventSource::Guardian => &mut self.guardian_prepared,
            EventSource::Direct => &mut self.direct_prepared,
        };
        if *prepared {
            return Err(invalid("duplicate prepared result on one channel"));
        }
        *prepared = true;
        Ok(())
    }

    fn bind_anchor(&mut self, anchor: ProcessIdentity) -> io::Result<()> {
        crate::guardian_protocol::validate_supervisor_anchor(&anchor)?;
        if let Some(expected) = self.anchor {
            crate::guardian_protocol::authenticate_process_identity(&anchor, &expected)
        } else {
            self.anchor = Some(anchor);
            Ok(())
        }
    }

    fn require_anchor(&self, anchor: ProcessIdentity) -> io::Result<()> {
        let expected = self
            .anchor
            .ok_or_else(|| invalid("supervisor anchor has not been established"))?;
        crate::guardian_protocol::authenticate_process_identity(&anchor, &expected)
    }

    fn anchor(&self) -> io::Result<ProcessIdentity> {
        self.anchor
            .ok_or_else(|| invalid("supervisor anchor has not been established"))
    }

    fn cleanup_cause(&self) -> Option<CleanupCause> {
        self.cleanup.cause()
    }
}

#[cfg(any(target_os = "macos", test))]
fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

#[cfg(target_os = "macos")]
mod imp {
    use super::{invalid, EventSource, ExecutorRunState};
    use crate::fault_trace::{FaultTrace, FaultTraceEvent};
    use crate::guardian_io::{FrameRead, FrameReader};
    use crate::guardian_protocol::{
        generate_nonce, write_authenticated_frame, CleanupCause, FrameIdentity, GuardianCommand,
        GuardianEvent, ProcessIdentity, SupervisorDirectCommand, SupervisorEvent,
    };
    use crate::macos_interactive::PairControl;
    use crate::macos_run_guardian::{
        spawn_pair_member, spawn_run_guardian_with_failure, GuardianChild, SpawnedPairMember,
        SpawnedRunGuardian,
    };
    use crate::macos_stdio::{send_stdio, TargetStdio};
    use crate::platform::{ActiveRuns, Cancellation};
    use crate::protocol::{RunReason, RunResult, RunSpec};
    use crate::tree_guard::{self, ProcessTreeGuard};
    use std::io;
    use std::os::fd::AsRawFd;
    use std::os::unix::net::UnixStream;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    const POLL_INTERVAL_MS: i32 = 2;
    const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
    const PREFERRED_CLEANUP_TIMEOUT: Duration = Duration::from_secs(10);
    const GUARDIAN_TERMINATION_TIMEOUT: Duration = Duration::from_secs(5);

    struct RunCancellation {
        cancelled: AtomicBool,
        _generation_guard: Arc<ProcessTreeGuard>,
    }

    impl Cancellation for RunCancellation {
        fn cancel(&self) {
            self.cancelled.store(true, Ordering::Release);
        }
    }

    enum ControllerInput {
        Guardian(GuardianEvent),
        GuardianEof,
        Direct(SupervisorEvent),
        DirectEof,
        GuardianExited,
        Tick,
    }

    enum StageOutcome {
        ReadyToCommit,
        PreferredCleanup,
        DirectFallback,
    }

    pub(crate) struct PairedRun {
        pub control: Arc<PairControl>,
        pub side: usize,
        pub stdio: Option<TargetStdio>,
        pub peer_process_count: u32,
    }

    struct RunController<'a> {
        root: PathBuf,
        spec: &'a RunSpec,
        active: &'a ActiveRuns,
        identity: FrameIdentity,
        guardian_identity: ProcessIdentity,
        guardian_child: GuardianChild,
        guardian_control: UnixStream,
        direct: UnixStream,
        guardian_open: bool,
        direct_open: bool,
        guardian_exit_reported: bool,
        state: ExecutorRunState,
        trace: Option<FaultTrace>,
        cancellation: Arc<RunCancellation>,
        active_handle: Option<Arc<dyn Cancellation>>,
        guardian_result: Option<RunResult>,
        direct_result: Option<RunResult>,
        diagnostic: Option<String>,
        group_proven: bool,
        paired: Option<PairedRun>,
        stdio_ready: bool,
        guardian_reader: FrameReader,
        direct_reader: FrameReader,
        reported_stdout: u64,
        pair_member: Option<SpawnedPairMember>,
        pair_pin: Option<crate::macos_process::PairedMemberPin>,
        pair_pin_released: bool,
    }

    pub fn run_with_guardian(
        root: &Path,
        spec: &RunSpec,
        active: &ActiveRuns,
    ) -> Result<RunResult, String> {
        run_with_guardian_options(root, spec, active, None)
    }

    pub(crate) fn run_with_guardian_paired(
        root: &Path,
        spec: &RunSpec,
        active: &ActiveRuns,
        paired: PairedRun,
    ) -> Result<RunResult, String> {
        let control = Arc::clone(&paired.control);
        let side = paired.side;
        let result = run_with_guardian_options(root, spec, active, Some(paired));
        if result.is_err() {
            control.abort(side, CleanupCause::LaunchFailed);
        }
        result
    }

    fn run_with_guardian_options(
        root: &Path,
        spec: &RunSpec,
        active: &ActiveRuns,
        paired: Option<PairedRun>,
    ) -> Result<RunResult, String> {
        let generation_guard = tree_guard::acquire_from_environment()
            .map_err(|error| format!("acquire per-run executor generation guard: {error}"))?;
        let generation = std::env::var(tree_guard::GENERATION_ENV)
            .map_err(|_| "guarded macOS run generation is missing".to_string())?;
        let identity = FrameIdentity::new(
            generate_nonce().map_err(|error| format!("generate guardian token: {error}"))?,
            generation,
            spec.run_id.clone(),
        )
        .map_err(|error| format!("create guardian identity: {error}"))?;
        let trace = FaultTrace::from_environment(&identity.generation)?;
        let spawned = spawn_run_guardian_with_failure(root, &identity, || {
            if let Some(pair) = &paired {
                pair.control.abort(pair.side, CleanupCause::LaunchFailed);
            }
        })
        .map_err(|error| format!("spawn per-run guardian: {error}"))?;
        let run_guard = Arc::new(generation_guard);
        let cancellation = Arc::new(RunCancellation {
            cancelled: AtomicBool::new(false),
            _generation_guard: Arc::clone(&run_guard),
        });
        let mut controller =
            RunController::new(root, spec, active, spawned, trace, cancellation, paired)
                .map_err(|error| format!("initialize run controller: {error}"))?;
        // Keep an executor-owned shared guard even before the active cancellation record is
        // committed. If startup becomes uncertain, fail_closed consumes this stack frame.
        let _run_guard = run_guard;
        controller
            .run()
            .map_err(|error| format!("guarded macOS run failed: {error}"))
    }

    impl<'a> RunController<'a> {
        fn new(
            root: &Path,
            spec: &'a RunSpec,
            active: &'a ActiveRuns,
            spawned: SpawnedRunGuardian,
            trace: Option<FaultTrace>,
            cancellation: Arc<RunCancellation>,
            paired: Option<PairedRun>,
        ) -> io::Result<Self> {
            let SpawnedRunGuardian {
                identity,
                guardian,
                mut child,
                control,
                direct,
            } = spawned;
            if let Err(error) = protect_stream_from_sigpipe(&control)
                .and_then(|_| protect_stream_from_sigpipe(&direct))
                .and_then(|_| control.set_read_timeout(Some(Duration::from_millis(2))))
                .and_then(|_| direct.set_read_timeout(Some(Duration::from_millis(2))))
                .and_then(|_| control.set_write_timeout(Some(Duration::from_secs(2))))
                .and_then(|_| direct.set_write_timeout(Some(Duration::from_secs(2))))
            {
                if let Some(pair) = &paired {
                    pair.control.abort(pair.side, CleanupCause::LaunchFailed);
                }
                if !matches!(
                    child.terminate_and_wait(GUARDIAN_TERMINATION_TIMEOUT),
                    Ok(Some(_))
                ) {
                    eprintln!("JUDGEDESK_MACOS_RUN_CONTAINMENT_UNCERTAIN controller initialization could not reap guardian; retaining generation guard");
                    loop {
                        std::thread::sleep(Duration::from_secs(10));
                    }
                }
                return Err(error);
            }
            Ok(Self {
                root: root.to_path_buf(),
                spec,
                active,
                identity,
                guardian_identity: guardian,
                guardian_child: child,
                guardian_control: control,
                direct,
                guardian_open: true,
                direct_open: true,
                guardian_exit_reported: false,
                state: ExecutorRunState::default(),
                trace,
                cancellation,
                active_handle: None,
                guardian_result: None,
                direct_result: None,
                diagnostic: None,
                group_proven: false,
                paired,
                stdio_ready: false,
                guardian_reader: FrameReader::new(),
                direct_reader: FrameReader::new(),
                reported_stdout: 0,
                pair_member: None,
                pair_pin: None,
                pair_pin_released: false,
            })
        }

        fn run_inner(&mut self) -> io::Result<RunResult> {
            let start = match &self.paired {
                Some(pair) => GuardianCommand::start_paired(
                    &self.identity,
                    self.spec.clone(),
                    pair.peer_process_count,
                ),
                None => GuardianCommand::start(&self.identity, self.spec.clone()),
            };
            if let Err(error) = self.send_guardian(&start) {
                self.request_cleanup(
                    None,
                    CleanupCause::InternalError,
                    format!("cannot send guardian_start: {error}"),
                )?;
                return self.handle_guardian_loss("guardian_start write failed");
            }

            match self.wait_for_handshake()? {
                StageOutcome::ReadyToCommit => {}
                StageOutcome::PreferredCleanup => return self.preferred_cleanup(),
                StageOutcome::DirectFallback => {
                    return self.handle_guardian_loss("guardian failed during ownership handshake")
                }
            }

            if self.cancellation.cancelled.load(Ordering::Acquire) {
                self.request_cleanup(None, CleanupCause::Cancelled, "run cancelled before commit")?;
                return self.preferred_cleanup();
            }
            if let Err(error) = self.insert_active_record() {
                self.request_cleanup(None, CleanupCause::InternalError, error)?;
                return self.preferred_cleanup();
            }
            let anchor = self.state.anchor()?;
            if self.paired.is_some() {
                self.pair_member = Some(spawn_pair_member(&self.identity, anchor)?);
                let member = self
                    .pair_member
                    .as_ref()
                    .ok_or_else(|| invalid("paired member spawn missing"))?
                    .identity;
                self.send_guardian(&GuardianCommand::register_pair_pin(
                    &self.identity,
                    anchor,
                    member,
                ))?;
                let enrollment_deadline = checked_deadline(HANDSHAKE_TIMEOUT)?;
                while self.pair_pin.is_none() {
                    if self.check_pair_cancellation()? || Instant::now() >= enrollment_deadline {
                        self.request_cleanup(
                            Some(anchor),
                            CleanupCause::LaunchFailed,
                            "paired member enrollment did not complete",
                        )?;
                        return self.preferred_cleanup();
                    }
                    match self.next_input()? {
                        ControllerInput::Guardian(event) => {
                            self.handle_precommit_guardian(event)?
                        }
                        ControllerInput::Direct(event) => self.handle_precommit_direct(event)?,
                        ControllerInput::Tick => {}
                        _ => {
                            return self.handle_guardian_loss(
                                "paired member enrollment authority disappeared",
                            )
                        }
                    }
                    if self.state.cleanup_cause().is_some() {
                        return self.preferred_cleanup();
                    }
                }
                let target = self
                    .paired
                    .as_mut()
                    .and_then(|pair| pair.stdio.take())
                    .ok_or_else(|| invalid("interactive target descriptors are missing"))?;
                self.send_direct(&SupervisorDirectCommand::install_paired_stdio(
                    &self.identity,
                    anchor,
                    Some(member),
                ))?;
                send_stdio(&self.direct, target)?;
                let deadline = checked_deadline(HANDSHAKE_TIMEOUT)?;
                while !self.stdio_ready {
                    if self.check_pair_cancellation()? || Instant::now() >= deadline {
                        self.request_cleanup(
                            Some(anchor),
                            CleanupCause::LaunchFailed,
                            "interactive stdio installation did not complete",
                        )?;
                        return self.preferred_cleanup();
                    }
                    match self.next_input()? {
                        ControllerInput::Direct(event) => self.handle_precommit_direct(event)?,
                        ControllerInput::Guardian(event) => {
                            self.handle_precommit_guardian(event)?
                        }
                        ControllerInput::Tick => {}
                        _ => {
                            self.request_cleanup(
                                Some(anchor),
                                CleanupCause::LaunchFailed,
                                "interactive ownership channel closed",
                            )?;
                            return self.preferred_cleanup();
                        }
                    }
                    if self.state.cleanup_cause().is_some() {
                        return self.preferred_cleanup();
                    }
                }
                if let Some(pair) = &self.paired {
                    let both_ready = pair.control.mark_ready(pair.side)?;
                    let fault_pause = crate::fault_trace::InteractiveFaultPause::from_environment(
                        self.trace.is_some(),
                    )
                    .map_err(io::Error::other)?;
                    if fault_pause
                        == Some(crate::fault_trace::InteractiveFaultPause::SecondConfigure)
                    {
                        self.emit_trace(
                            FaultTraceEvent::InteractiveParticipantEnrolled,
                            None,
                            anchor,
                        )
                        .map_err(io::Error::other)?;
                    }
                    if both_ready
                        && fault_pause
                            == Some(crate::fault_trace::InteractiveFaultPause::PairCommit)
                    {
                        self.emit_trace(FaultTraceEvent::InteractivePairEnrolled, None, anchor)
                            .map_err(io::Error::other)?;
                    }
                }
                while !self
                    .paired
                    .as_ref()
                    .is_some_and(|pair| pair.control.may_release())
                {
                    if self.check_pair_cancellation()? {
                        return self.preferred_cleanup();
                    }
                    if Instant::now() >= deadline {
                        self.request_cleanup(
                            Some(anchor),
                            CleanupCause::LaunchFailed,
                            "interactive peer did not become ready",
                        )?;
                        return self.preferred_cleanup();
                    }
                    match self.next_input()? {
                        ControllerInput::Direct(event) => self.handle_precommit_direct(event)?,
                        ControllerInput::Guardian(event) => {
                            self.handle_precommit_guardian(event)?
                        }
                        ControllerInput::Tick => {}
                        _ => {
                            self.request_cleanup(
                                Some(anchor),
                                CleanupCause::LaunchFailed,
                                "interactive ownership channel closed before release",
                            )?;
                            return self.preferred_cleanup();
                        }
                    }
                }
            }
            if self.check_pair_cancellation()? {
                return self.preferred_cleanup();
            }
            if let Err(error) = self.emit_trace(
                FaultTraceEvent::ExecutorActiveCommitted,
                Some(self.guardian_identity),
                anchor,
            ) {
                self.request_cleanup(None, CleanupCause::InternalError, error)?;
                return self.preferred_cleanup();
            }
            if let Err(error) =
                self.send_direct(&SupervisorDirectCommand::commit(&self.identity, anchor))
            {
                self.request_cleanup(
                    Some(anchor),
                    CleanupCause::InternalError,
                    format!("cannot send direct supervisor commit: {error}"),
                )?;
                return self.preferred_cleanup();
            }
            if self.cancellation.cancelled.load(Ordering::Acquire) {
                self.request_cleanup(
                    Some(anchor),
                    CleanupCause::Cancelled,
                    "run cancelled during ownership commit",
                )?;
                return self.preferred_cleanup();
            }
            if let Err(error) = self.send_guardian(&GuardianCommand::commit(&self.identity, anchor))
            {
                self.request_cleanup(
                    Some(anchor),
                    CleanupCause::InternalError,
                    format!("cannot send guardian commit: {error}"),
                )?;
                return self.handle_guardian_loss("guardian commit write failed");
            }
            self.state.record_committed()?;

            match self.wait_for_cleanup_trigger()? {
                StageOutcome::PreferredCleanup => self.preferred_cleanup(),
                StageOutcome::DirectFallback => {
                    self.handle_guardian_loss("guardian failed while target was active")
                }
                StageOutcome::ReadyToCommit => Err(invalid(
                    "active run returned an impossible ownership-handshake outcome",
                )),
            }
        }

        fn wait_for_handshake(&mut self) -> io::Result<StageOutcome> {
            let deadline = checked_deadline(HANDSHAKE_TIMEOUT)?;
            loop {
                if self.check_pair_cancellation()? {
                    return Ok(StageOutcome::PreferredCleanup);
                }
                if self.state.cleanup_cause().is_some() {
                    return Ok(StageOutcome::PreferredCleanup);
                }
                if self.state.proofs_complete() {
                    return Ok(StageOutcome::ReadyToCommit);
                }
                if Instant::now() >= deadline {
                    self.request_cleanup(
                        self.state.anchor,
                        CleanupCause::InternalError,
                        "guardian ownership handshake timed out",
                    )?;
                    return Ok(StageOutcome::DirectFallback);
                }
                match self.next_input()? {
                    ControllerInput::Guardian(event) => {
                        if let Err(error) = self.handle_precommit_guardian(event) {
                            self.request_cleanup(
                                self.state.anchor,
                                CleanupCause::ProtocolViolation,
                                error.to_string(),
                            )?;
                            return Ok(StageOutcome::PreferredCleanup);
                        }
                    }
                    ControllerInput::Direct(event) => {
                        if let Err(error) = self.handle_precommit_direct(event) {
                            self.request_cleanup(
                                self.state.anchor,
                                CleanupCause::ProtocolViolation,
                                error.to_string(),
                            )?;
                            return Ok(StageOutcome::PreferredCleanup);
                        }
                    }
                    ControllerInput::GuardianEof | ControllerInput::GuardianExited => {
                        self.request_cleanup(
                            self.state.anchor,
                            CleanupCause::GuardianDisconnected,
                            "guardian exited during ownership handshake",
                        )?;
                        return Ok(StageOutcome::DirectFallback);
                    }
                    ControllerInput::DirectEof => {
                        self.request_cleanup(
                            self.state.anchor,
                            CleanupCause::ExecutorDisconnected,
                            "direct supervisor channel closed during ownership handshake",
                        )?;
                        return Ok(StageOutcome::PreferredCleanup);
                    }
                    ControllerInput::Tick => {}
                }
            }
        }

        fn wait_for_cleanup_trigger(&mut self) -> io::Result<StageOutcome> {
            loop {
                if self.check_pair_cancellation()? {
                    return Ok(StageOutcome::PreferredCleanup);
                }
                if self.cancellation.cancelled.load(Ordering::Acquire) {
                    self.request_cleanup(
                        self.state.anchor,
                        CleanupCause::Cancelled,
                        "run cancellation requested",
                    )?;
                    return Ok(StageOutcome::PreferredCleanup);
                }
                if self.state.cleanup_cause().is_some() {
                    return Ok(StageOutcome::PreferredCleanup);
                }
                match self.next_input()? {
                    ControllerInput::Guardian(event) => {
                        if let Err(error) = self.handle_active_guardian(event) {
                            self.request_cleanup(
                                self.state.anchor,
                                CleanupCause::ProtocolViolation,
                                error.to_string(),
                            )?;
                            return Ok(StageOutcome::PreferredCleanup);
                        }
                    }
                    ControllerInput::Direct(event) => {
                        if let Err(error) = self.handle_active_direct(event) {
                            self.request_cleanup(
                                self.state.anchor,
                                CleanupCause::ProtocolViolation,
                                error.to_string(),
                            )?;
                            return Ok(StageOutcome::PreferredCleanup);
                        }
                    }
                    ControllerInput::GuardianEof | ControllerInput::GuardianExited => {
                        self.request_cleanup(
                            self.state.anchor,
                            CleanupCause::GuardianDisconnected,
                            "guardian exited while target was active",
                        )?;
                        return Ok(StageOutcome::DirectFallback);
                    }
                    ControllerInput::DirectEof => {
                        self.request_cleanup(
                            self.state.anchor,
                            CleanupCause::ExecutorDisconnected,
                            "direct supervisor channel closed while target was active",
                        )?;
                        return Ok(StageOutcome::PreferredCleanup);
                    }
                    ControllerInput::Tick => {}
                }
            }
        }

        fn handle_precommit_guardian(&mut self, event: GuardianEvent) -> io::Result<()> {
            match event {
                GuardianEvent::PairPinRegistered { anchor, member, .. } => {
                    self.state.require_anchor(anchor)?;
                    let expected = self
                        .pair_member
                        .as_ref()
                        .ok_or_else(|| invalid("unexpected paired member grant"))?
                        .identity;
                    crate::guardian_protocol::authenticate_process_identity(&member, &expected)?;
                    if self.pair_pin.is_some() || self.guardian_child.try_wait()?.is_some() {
                        return Err(invalid("paired member grant has no live owned guardian"));
                    }
                    crate::guardian_protocol::authenticate_process_identity(
                        &self.guardian_identity,
                        &crate::macos_process::read_process_identity(self.guardian_child.pid())?,
                    )?;
                    self.pair_pin =
                        Some(crate::macos_process::PairedMemberPin::new(member, anchor)?);
                    Ok(())
                }
                GuardianEvent::Started { anchor, .. } => self.state.record_guardian_started(anchor),
                GuardianEvent::CleanupRequested { anchor, cause, .. } => self.request_cleanup(
                    Some(anchor),
                    cause,
                    "supervisor requested cleanup before executor commit",
                ),
                GuardianEvent::Fatal { code, message, .. } => self.request_cleanup(
                    self.state.anchor,
                    CleanupCause::InternalError,
                    format!("guardian fatal {code}: {message}"),
                ),
                other => Err(invalid(format!(
                    "guardian sent {} before executor commit",
                    other.kind()
                ))),
            }
        }

        fn handle_precommit_direct(&mut self, event: SupervisorEvent) -> io::Result<()> {
            match event {
                SupervisorEvent::StdioReady { anchor, .. } => {
                    self.state.require_anchor(anchor)?;
                    if self.paired.is_none()
                        || self.stdio_ready
                        || self
                            .paired
                            .as_ref()
                            .is_some_and(|pair| pair.stdio.is_some())
                    {
                        return Err(invalid("unexpected interactive stdio acknowledgement"));
                    }
                    self.stdio_ready = true;
                    Ok(())
                }
                SupervisorEvent::Registered { anchor, .. } => {
                    self.state.record_direct_registered(anchor)
                }
                SupervisorEvent::Ready { anchor, .. } => self.state.record_direct_ready(anchor),
                SupervisorEvent::CleanupRequested { anchor, cause, .. } => self.request_cleanup(
                    Some(anchor),
                    cause,
                    "supervisor requested cleanup before executor commit",
                ),
                SupervisorEvent::Fatal {
                    anchor,
                    code,
                    message,
                    ..
                } => self.request_cleanup(
                    anchor,
                    CleanupCause::InternalError,
                    format!("supervisor fatal {code}: {message}"),
                ),
                other => Err(invalid(format!(
                    "direct supervisor sent {} before executor commit",
                    other.kind()
                ))),
            }
        }

        fn handle_active_guardian(&mut self, event: GuardianEvent) -> io::Result<()> {
            match event {
                GuardianEvent::TargetStarted { anchor, target, .. } => {
                    self.state
                        .record_target(EventSource::Guardian, anchor, target)
                }
                GuardianEvent::CleanupRequested { anchor, cause, .. } => self.request_cleanup(
                    Some(anchor),
                    cause,
                    "supervisor requested active-run cleanup",
                ),
                GuardianEvent::Fatal { code, message, .. } => self.request_cleanup(
                    self.state.anchor,
                    CleanupCause::InternalError,
                    format!("guardian fatal {code}: {message}"),
                ),
                other => Err(invalid(format!(
                    "guardian sent unexpected active event {}",
                    other.kind()
                ))),
            }
        }

        fn handle_active_direct(&mut self, event: SupervisorEvent) -> io::Result<()> {
            match event {
                SupervisorEvent::TargetStarted { anchor, target, .. } => {
                    self.state
                        .record_target(EventSource::Direct, anchor, target)
                }
                SupervisorEvent::CleanupRequested { anchor, cause, .. } => self.request_cleanup(
                    Some(anchor),
                    cause,
                    "supervisor requested active-run cleanup",
                ),
                SupervisorEvent::Fatal {
                    anchor,
                    code,
                    message,
                    ..
                } => self.request_cleanup(
                    anchor,
                    CleanupCause::InternalError,
                    format!("supervisor fatal {code}: {message}"),
                ),
                other => Err(invalid(format!(
                    "direct supervisor sent unexpected active event {}",
                    other.kind()
                ))),
            }
        }

        fn preferred_cleanup(&mut self) -> io::Result<RunResult> {
            if self.paired.is_some() && self.pair_pin.is_none() && !self.state.committed {
                if let Some(member) = &mut self.pair_member {
                    if member
                        .child
                        .terminate_and_wait(GUARDIAN_TERMINATION_TIMEOUT)?
                        .is_none()
                    {
                        return self.fail_closed("cannot retire pre-grant owned member");
                    }
                }
            }
            let cause = self
                .state
                .cleanup_cause()
                .unwrap_or(CleanupCause::InternalError);
            if !self.guardian_open {
                return self.handle_guardian_loss("guardian channel unavailable before cancel");
            }
            if let Err(error) = self.send_guardian(&GuardianCommand::cancel(&self.identity, cause))
            {
                self.append_diagnostic(format!("cannot send guardian cancel: {error}"));
                return self.handle_guardian_loss("guardian cancel write failed");
            }

            let deadline = checked_deadline(PREFERRED_CLEANUP_TIMEOUT)?;
            loop {
                if self.guardian_result.is_some() && self.guardian_exit_reported {
                    return self.finish_preferred_result();
                }
                if Instant::now() >= deadline {
                    if !self.ensure_guardian_terminated()? {
                        return self.fail_closed(
                            "guardian cleanup timed out and exact direct child could not be reaped",
                        );
                    }
                    if self.guardian_result.is_some() {
                        return self.finish_preferred_result();
                    }
                    return self.handle_guardian_loss("guardian cleanup timed out before prepared");
                }

                match self.next_input()? {
                    ControllerInput::Guardian(event) => {
                        if let Err(error) = self.handle_cleanup_guardian(event) {
                            self.append_diagnostic(format!(
                                "guardian cleanup protocol failed: {error}"
                            ));
                            if !self.ensure_guardian_terminated()? {
                                return self.fail_closed(
                                    "guardian protocol failed and guardian could not be reaped",
                                );
                            }
                            return self.handle_guardian_loss(
                                "guardian protocol failed during preferred cleanup",
                            );
                        }
                    }
                    ControllerInput::Direct(event) => {
                        if let Err(error) = self.handle_cleanup_direct(event) {
                            self.append_diagnostic(format!(
                                "direct cleanup protocol failed: {error}"
                            ));
                            if !self.ensure_guardian_terminated()? {
                                return self.fail_closed(
                                    "direct protocol failed and guardian could not be reaped",
                                );
                            }
                            return self.handle_guardian_loss(
                                "direct protocol failed during guardian cleanup",
                            );
                        }
                    }
                    ControllerInput::GuardianEof => {
                        if self.guardian_result.is_none() {
                            if !self.ensure_guardian_terminated()? {
                                return self.fail_closed(
                                    "guardian EOF occurred but the direct child was not reapable",
                                );
                            }
                            return self.handle_guardian_loss("guardian EOF before prepared");
                        }
                    }
                    ControllerInput::GuardianExited => {
                        if self.guardian_result.is_some() {
                            return self.finish_preferred_result();
                        }
                        return self.handle_guardian_loss("guardian exited before prepared");
                    }
                    ControllerInput::DirectEof | ControllerInput::Tick => {}
                }
            }
        }

        fn handle_cleanup_guardian(&mut self, event: GuardianEvent) -> io::Result<()> {
            match event {
                GuardianEvent::PairQuiescent { anchor, member, .. } => {
                    self.state.require_anchor(anchor)?;
                    let pin = self
                        .pair_pin
                        .as_mut()
                        .ok_or_else(|| invalid("quiescent grant lacks owned member pin"))?;
                    crate::guardian_protocol::authenticate_process_identity(
                        &member,
                        &pin.identity(),
                    )?;
                    if self.pair_pin_released {
                        return Err(invalid("duplicate paired quiescent grant"));
                    }
                    pin.reap_after_quiescence(&[anchor])?;
                    self.pair_pin_released = true;
                    Ok(())
                }
                GuardianEvent::Started { anchor, .. } if !self.state.guardian_started => {
                    self.state.record_guardian_started(anchor)
                }
                GuardianEvent::TargetStarted { anchor, target, .. } => {
                    self.state
                        .record_target(EventSource::Guardian, anchor, target)
                }
                GuardianEvent::CleanupRequested { anchor, cause, .. } => self.request_cleanup(
                    Some(anchor),
                    cause,
                    "guardian forwarded cleanup during cleanup",
                ),
                GuardianEvent::Prepared { anchor, result, .. } => {
                    self.state.record_prepared(EventSource::Guardian, anchor)?;
                    self.store_guardian_result(*result)
                }
                GuardianEvent::Fatal { code, message, .. } => {
                    self.append_diagnostic(format!("guardian fatal {code}: {message}"));
                    Ok(())
                }
                other => Err(invalid(format!(
                    "unexpected guardian cleanup event {}",
                    other.kind()
                ))),
            }
        }

        fn handle_cleanup_direct(&mut self, event: SupervisorEvent) -> io::Result<()> {
            match event {
                SupervisorEvent::Registered { anchor, .. } if !self.state.direct_registered => {
                    self.state.record_direct_registered(anchor)
                }
                SupervisorEvent::Ready { anchor, .. } if !self.state.direct_ready => {
                    self.state.record_direct_ready(anchor)
                }
                SupervisorEvent::TargetStarted { anchor, target, .. } => {
                    self.state
                        .record_target(EventSource::Direct, anchor, target)
                }
                SupervisorEvent::CleanupRequested { anchor, cause, .. } => {
                    self.request_cleanup(Some(anchor), cause, "supervisor repeated cleanup request")
                }
                SupervisorEvent::Prepared { anchor, result, .. } => {
                    self.state.record_prepared(EventSource::Direct, anchor)?;
                    self.store_direct_result(*result)
                }
                SupervisorEvent::Fatal {
                    anchor,
                    code,
                    message,
                    ..
                } => {
                    if let Some(anchor) = anchor {
                        self.state.bind_anchor(anchor)?;
                    }
                    self.append_diagnostic(format!("supervisor fatal {code}: {message}"));
                    Ok(())
                }
                other => Err(invalid(format!(
                    "unexpected direct cleanup event {}",
                    other.kind()
                ))),
            }
        }

        fn finish_preferred_result(&mut self) -> io::Result<RunResult> {
            if self.pair_pin.is_some() && !self.pair_pin_released {
                return Err(invalid(
                    "guardian result arrived before paired owned pin release proof",
                ));
            }
            let result = self
                .guardian_result
                .take()
                .ok_or_else(|| invalid("guardian exit had no prepared result"))?;
            // The authenticated guardian emits Prepared only after killing the anchored group,
            // reaping its exact direct supervisor child, and proving the group inventory empty.
            self.group_proven = true;
            if let Some(direct) = &self.direct_result {
                require_same_result(&result, direct)?;
            }
            self.finish_after_group_proof(result)
        }

        fn handle_guardian_loss_inner(&mut self, reason: &str) -> io::Result<RunResult> {
            if let Some(pair) = &self.paired {
                pair.control
                    .abort(pair.side, CleanupCause::GuardianDisconnected);
            }
            self.append_diagnostic(format!("executor observed guardian loss: {reason}"));
            self.state.request_cleanup(
                self.state.anchor,
                self.state
                    .cleanup_cause()
                    .unwrap_or(CleanupCause::InternalError),
            )?;
            if !self.ensure_guardian_terminated()? {
                return self.fail_closed(
                    "guardian loss cannot be classified until the exact guardian child is reaped",
                );
            }

            if self.state.anchor.is_none() && !self.discover_fallback_anchor()? {
                // A supervisor cannot fork a target before it has registered, become ready,
                // and received both ownership commits. Direct EOF after the exact guardian
                // child is reaped therefore proves that this pre-registration branch never
                // acquired untrusted containment.
                self.group_proven = true;
                self.cleanup_profiles_after_proof()?;
                self.remove_active_record()?;
                let diagnostic = self.diagnostic.clone().unwrap_or_else(|| {
                    "guardian failed before any supervisor anchor was registered".into()
                });
                return Ok(crate::platform::failure(
                    self.spec,
                    RunReason::LaunchError,
                    diagnostic,
                ));
            }

            if self.paired.is_some() {
                let anchor = self.state.anchor()?;
                self.emit_trace(FaultTraceEvent::ExecutorFallbackDrainStarted, None, anchor)
                    .map_err(io::Error::other)?;
                if let Some(pin) = &mut self.pair_pin {
                    if !self.pair_pin_released {
                        for signal in [libc::SIGSTOP, libc::SIGKILL] {
                            if let Err(signal_error) = pin.signal_group(signal) {
                                // Darwin can reject a signal to a group containing only our
                                // terminal owned member. The error itself grants no drain
                                // proof: independently require physical quiescence before
                                // consuming that member's wait status.
                                match pin.reap_after_quiescence(&[]) {
                                    Ok(_) => {
                                        self.pair_pin_released = true;
                                        break;
                                    }
                                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                                        return Err(signal_error);
                                    }
                                    Err(error) => {
                                        return Err(io::Error::new(
                                            error.kind(),
                                            format!("paired group signal failed: {signal_error}; quiescence failed: {error}"),
                                        ));
                                    }
                                }
                            }
                        }
                        while !self.pair_pin_released {
                            match pin.reap_after_quiescence(&[]) {
                                Ok(_) => {
                                    self.pair_pin_released = true;
                                    break;
                                }
                                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                                    std::thread::sleep(Duration::from_millis(2))
                                }
                                Err(error) => return Err(error),
                            }
                        }
                    }
                } else {
                    if self.state.committed {
                        return Err(invalid("committed pair lost its member pin"));
                    }
                    if let Some(member) = &mut self.pair_member {
                        let _ = member.control.shutdown(std::net::Shutdown::Both);
                        if member
                            .child
                            .terminate_and_wait(GUARDIAN_TERMINATION_TIMEOUT)?
                            .is_none()
                        {
                            return Err(invalid("precommit member retirement did not finish"));
                        }
                    }
                    // No commit was ever sent before enrollment. Only the trusted supervisor
                    // can remain; closing both source-bound controllers lets it retire without
                    // untrusted release. This branch grants no numeric group authority.
                    self.direct.shutdown(std::net::Shutdown::Both)?;
                    self.direct_open = false;
                }
                let mut observations = 0_u8;
                while observations < 2 {
                    let snapshot = crate::macos_process::inventory_live_process_group(anchor.pgid)?;
                    if snapshot.members.is_empty() && snapshot.zombie_pids.is_empty() {
                        observations += 1;
                    } else {
                        observations = 0;
                        std::thread::sleep(Duration::from_millis(2));
                    }
                }
                self.group_proven = true;
                self.emit_trace(FaultTraceEvent::GroupDrained, None, anchor)
                    .map_err(io::Error::other)?;
                let result = crate::platform::failure(
                    self.spec,
                    RunReason::InternalError,
                    format!("paired guardian lost; owned containment drained: {reason}"),
                );
                return self.finish_after_group_proof(result);
            }

            // Once a single-run supervisor anchor has existed, the executor cannot safely signal its
            // numeric PID or PGID after the guardian dies. The executor is not the supervisor's
            // direct parent, the direct socket is not a pidfd, and launchd may reap an orphan
            // between identity verification and kill(2). Retain the active record and generation
            // guard forever instead of risking an unrelated process or overlapping generation.
            Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "guardian died after supervisor registration; executor has no owned unreaped anchor pin and will not signal a numeric PID/PGID",
            ))
        }

        fn discover_fallback_anchor(&mut self) -> io::Result<bool> {
            let deadline = checked_deadline(HANDSHAKE_TIMEOUT)?;
            loop {
                if self.state.anchor.is_some() {
                    return Ok(true);
                }
                if !self.direct_open {
                    return Ok(false);
                }
                if Instant::now() >= deadline {
                    return self.fail_closed(
                        "guardian was reaped but direct channel neither registered nor closed",
                    );
                }
                match self.next_input()? {
                    ControllerInput::Direct(SupervisorEvent::Registered { anchor, .. }) => {
                        self.state.record_direct_registered(anchor)?;
                    }
                    ControllerInput::Direct(SupervisorEvent::Fatal {
                        anchor: Some(anchor),
                        code,
                        message,
                        ..
                    }) => {
                        self.state.bind_anchor(anchor)?;
                        self.append_diagnostic(format!(
                            "supervisor fatal during fallback discovery {code}: {message}"
                        ));
                    }
                    ControllerInput::Direct(event) => {
                        return self.fail_closed(&format!(
                            "direct channel sent {} before fallback registration",
                            event.kind()
                        ))
                    }
                    ControllerInput::DirectEof => return Ok(false),
                    ControllerInput::Guardian(event) => {
                        // Validate buffered guardian data, but never derive the fallback anchor
                        // solely from it.
                        if let GuardianEvent::Fatal { code, message, .. } = event {
                            self.append_diagnostic(format!(
                                "buffered guardian fatal during discovery {code}: {message}"
                            ));
                        } else {
                            return self.fail_closed(&format!(
                                "unexpected buffered guardian event {} during fallback discovery",
                                event.kind()
                            ));
                        }
                    }
                    ControllerInput::GuardianEof
                    | ControllerInput::GuardianExited
                    | ControllerInput::Tick => {}
                }
            }
        }

        fn run(&mut self) -> io::Result<RunResult> {
            match self.run_inner() {
                Ok(result) => Ok(result),
                Err(error) if self.group_proven => {
                    self.append_diagnostic(format!(
                        "controller failed after containment proof: {error}"
                    ));
                    let cleanup_error = self.cleanup_profiles_after_proof().err();
                    if let Err(remove_error) = self.remove_active_record() {
                        return self.fail_closed(&format!(
                            "cannot remove active record after containment proof: {remove_error}"
                        ));
                    }
                    let mut message = error.to_string();
                    if let Some(cleanup_error) = cleanup_error {
                        message.push_str(&format!(
                            "; remove Seatbelt profile after proof: {cleanup_error}"
                        ));
                    }
                    Err(io::Error::new(error.kind(), message))
                }
                Err(error) => {
                    if let Some(pair) = &self.paired {
                        pair.control.abort(pair.side, CleanupCause::InternalError);
                    }
                    self.append_diagnostic(format!("controller state machine failed: {error}"));
                    if let Err(cleanup_error) = self
                        .state
                        .request_cleanup(self.state.anchor, CleanupCause::InternalError)
                    {
                        return self.fail_closed(&format!(
                            "controller failed and cleanup could not be latched: {cleanup_error}"
                        ));
                    }
                    self.handle_guardian_loss("unhandled controller state-machine failure")
                }
            }
        }

        fn handle_guardian_loss(&mut self, reason: &str) -> io::Result<RunResult> {
            match self.handle_guardian_loss_inner(reason) {
                Ok(result) => Ok(result),
                Err(error) => self.fail_closed(&format!(
                    "guardian loss crossed the no-signal containment boundary: {error}"
                )),
            }
        }

        fn next_input(&mut self) -> io::Result<ControllerInput> {
            self.report_pipe_progress()?;
            let ready = poll_controller_streams(
                self.guardian_open.then_some(&self.guardian_control),
                self.direct_open.then_some(&self.direct),
            )?;

            // Consume authenticated channel data before observing child exit. This preserves
            // a final Prepared frame that was already queued when the guardian became a zombie.
            if ready.guardian {
                let event = self
                    .guardian_reader
                    .receive::<_, GuardianEvent>(&mut &self.guardian_control, &self.identity)?;
                return Ok(match event {
                    FrameRead::Frame(event) => ControllerInput::Guardian(event),
                    FrameRead::Pending => ControllerInput::Tick,
                    FrameRead::Eof => {
                        self.guardian_open = false;
                        if self.guardian_result.is_some() {
                            // Prepared is queued before the guardian drops its only executor
                            // control descriptor. Once EOF follows that authenticated proof,
                            // wait for the exact direct child immediately instead of adding a
                            // polling interval to every successful run. A containment failure
                            // keeps this descriptor open while holding the generation guard.
                            self.guardian_child.wait()?;
                            self.guardian_exit_reported = true;
                            ControllerInput::GuardianExited
                        } else {
                            ControllerInput::GuardianEof
                        }
                    }
                });
            }
            if ready.direct {
                let event = self
                    .direct_reader
                    .receive::<_, SupervisorEvent>(&mut &self.direct, &self.identity)?;
                return Ok(match event {
                    FrameRead::Frame(event) => ControllerInput::Direct(event),
                    FrameRead::Pending => ControllerInput::Tick,
                    FrameRead::Eof => {
                        self.direct_open = false;
                        ControllerInput::DirectEof
                    }
                });
            }
            if !self.guardian_exit_reported && self.guardian_child.try_wait()?.is_some() {
                self.guardian_exit_reported = true;
                return Ok(ControllerInput::GuardianExited);
            }
            Ok(ControllerInput::Tick)
        }

        fn send_guardian(&mut self, command: &GuardianCommand) -> io::Result<()> {
            if !self.guardian_open {
                return Err(io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "guardian control channel is closed",
                ));
            }
            if let Err(error) =
                write_authenticated_frame(&mut self.guardian_control, command, &self.identity)
            {
                self.guardian_open = false;
                return Err(error);
            }
            Ok(())
        }

        fn send_direct(&mut self, command: &SupervisorDirectCommand) -> io::Result<()> {
            if !self.direct_open {
                return Err(io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "direct supervisor channel is closed",
                ));
            }
            if let Err(error) = write_authenticated_frame(&mut self.direct, command, &self.identity)
            {
                self.direct_open = false;
                return Err(error);
            }
            Ok(())
        }

        fn request_cleanup(
            &mut self,
            anchor: Option<ProcessIdentity>,
            cause: CleanupCause,
            diagnostic: impl Into<String>,
        ) -> io::Result<()> {
            self.state.request_cleanup(anchor, cause)?;
            if cause != CleanupCause::TargetExited {
                if let Some(pair) = &self.paired {
                    pair.control.abort(pair.side, cause);
                }
            }
            self.append_diagnostic(diagnostic);
            self.report_pipe_progress()?;
            Ok(())
        }

        fn report_pipe_progress(&mut self) -> io::Result<()> {
            if self.state.target.is_none()
                || !self.direct_open
                || self.direct_result.is_some()
                || self.guardian_result.is_some()
            {
                return Ok(());
            }
            let bytes = self
                .paired
                .as_ref()
                .map(|pair| pair.control.stdout_bytes(pair.side))
                .unwrap_or(0);
            if bytes > self.reported_stdout {
                self.send_direct(&SupervisorDirectCommand::output_progress(
                    &self.identity,
                    self.state.anchor()?,
                    bytes,
                ))?;
                self.reported_stdout = bytes;
            }
            Ok(())
        }

        fn check_pair_cancellation(&mut self) -> io::Result<bool> {
            let cause = self
                .paired
                .as_ref()
                .and_then(|pair| pair.control.cleanup_cause(pair.side));
            if let Some(cause) = cause {
                self.request_cleanup(
                    self.state.anchor,
                    cause,
                    "interactive pair cleanup requested",
                )?;
                return Ok(true);
            }
            if self.cancellation.cancelled.load(Ordering::Acquire) {
                self.request_cleanup(
                    self.state.anchor,
                    CleanupCause::Cancelled,
                    "run cancellation requested",
                )?;
                return Ok(true);
            }
            Ok(false)
        }

        fn insert_active_record(&mut self) -> Result<(), String> {
            if self.active_handle.is_some() {
                return Err("active cancellation record is already installed".into());
            }
            let handle: Arc<dyn Cancellation> = self.cancellation.clone();
            let mut active = self
                .active
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if active.contains_key(&self.spec.run_id) {
                return Err("duplicate active runId".into());
            }
            active.insert(self.spec.run_id.clone(), handle.clone());
            self.active_handle = Some(handle);
            Ok(())
        }

        fn remove_active_record(&mut self) -> io::Result<()> {
            let Some(expected) = self.active_handle.as_ref() else {
                return Ok(());
            };
            let mut active = self
                .active
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let Some(actual) = active.get(&self.spec.run_id) else {
                return Err(invalid("active cancellation record disappeared"));
            };
            if !Arc::ptr_eq(actual, expected) {
                return Err(invalid("active cancellation record identity changed"));
            }
            active.remove(&self.spec.run_id);
            self.active_handle = None;
            Ok(())
        }

        fn ensure_guardian_terminated(&mut self) -> io::Result<bool> {
            if self.guardian_exit_reported {
                return Ok(true);
            }
            match self
                .guardian_child
                .terminate_and_wait(GUARDIAN_TERMINATION_TIMEOUT)?
            {
                Some(status) => {
                    self.guardian_exit_reported = true;
                    self.guardian_open = false;
                    self.append_diagnostic(format!(
                        "exact guardian child reaped with status {status}"
                    ));
                    Ok(true)
                }
                None => Ok(false),
            }
        }

        fn store_guardian_result(&mut self, result: RunResult) -> io::Result<()> {
            self.validate_result(&result)?;
            if self.guardian_result.is_some() {
                return Err(invalid("duplicate guardian prepared result"));
            }
            if let Some(direct) = &self.direct_result {
                require_same_result(&result, direct)?;
            }
            self.guardian_result = Some(result);
            Ok(())
        }

        fn store_direct_result(&mut self, result: RunResult) -> io::Result<()> {
            self.validate_result(&result)?;
            if self.direct_result.is_some() {
                return Err(invalid("duplicate direct prepared result"));
            }
            if let Some(guardian) = &self.guardian_result {
                require_same_result(&result, guardian)?;
            }
            self.direct_result = Some(result);
            Ok(())
        }

        fn validate_result(&self, result: &RunResult) -> io::Result<()> {
            if result.run_id != self.spec.run_id {
                return Err(invalid("prepared result belongs to a different run"));
            }
            Ok(())
        }

        fn finish_after_group_proof(&mut self, mut result: RunResult) -> io::Result<RunResult> {
            if !self.group_proven {
                return self.fail_closed(
                    "controller attempted to finish without an authenticated group proof",
                );
            }
            if let Err(error) = self.cleanup_profiles_after_proof() {
                result.reason = RunReason::InternalError;
                self.append_diagnostic(format!(
                    "cannot remove Seatbelt profile after containment proof: {error}"
                ));
            }
            if let Err(error) = self.remove_active_record() {
                return self.fail_closed(&format!(
                    "cannot remove active cancellation record after proof: {error}"
                ));
            }
            if let Some(diagnostic) = self.diagnostic.take() {
                result.diagnostic = Some(match result.diagnostic.take() {
                    Some(existing) => format!("{existing}; {diagnostic}"),
                    None => diagnostic,
                });
            }
            Ok(result)
        }

        fn cleanup_profiles_after_proof(&self) -> io::Result<()> {
            if !self.group_proven {
                return Err(invalid(
                    "Seatbelt profile cleanup requires a containment proof",
                ));
            }
            crate::platform::macos::cleanup_run_profiles(&self.root, &self.spec.run_id)
                .map_err(io::Error::other)
        }

        fn append_diagnostic(&mut self, diagnostic: impl Into<String>) {
            let diagnostic = diagnostic.into();
            self.diagnostic = Some(match self.diagnostic.take() {
                Some(existing) => format!("{existing}; {diagnostic}"),
                None => diagnostic,
            });
        }

        fn emit_trace(
            &self,
            event: FaultTraceEvent,
            guardian: Option<ProcessIdentity>,
            anchor: ProcessIdentity,
        ) -> Result<(), String> {
            match &self.trace {
                Some(trace) => {
                    trace.emit(event, &self.identity.run_id, guardian, Some(anchor), None)
                }
                None => Ok(()),
            }
        }

        fn fail_closed<T>(&mut self, diagnostic: &str) -> io::Result<T> {
            if let Some(pair) = &self.paired {
                pair.control.abort(pair.side, CleanupCause::InternalError);
            }
            self.append_diagnostic(diagnostic);
            eprintln!(
                "JUDGEDESK_MACOS_RUN_CONTAINMENT_UNCERTAIN runId={}; retaining active record and generation guard: {}",
                self.spec.run_id,
                self.diagnostic.as_deref().unwrap_or(diagnostic)
            );
            loop {
                std::thread::sleep(Duration::from_secs(10));
            }
        }
    }

    #[derive(Debug, Default)]
    struct ReadyStreams {
        guardian: bool,
        direct: bool,
    }

    fn poll_controller_streams(
        guardian: Option<&UnixStream>,
        direct: Option<&UnixStream>,
    ) -> io::Result<ReadyStreams> {
        let mut descriptors = Vec::with_capacity(2);
        let mut sources = Vec::with_capacity(2);
        if let Some(stream) = guardian {
            descriptors.push(libc::pollfd {
                fd: stream.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            });
            sources.push(EventSource::Guardian);
        }
        if let Some(stream) = direct {
            descriptors.push(libc::pollfd {
                fd: stream.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            });
            sources.push(EventSource::Direct);
        }

        loop {
            let result = unsafe {
                libc::poll(
                    descriptors.as_mut_ptr(),
                    descriptors.len() as libc::nfds_t,
                    POLL_INTERVAL_MS,
                )
            };
            if result >= 0 {
                break;
            }
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
            }
        }

        let mut ready = ReadyStreams::default();
        for (descriptor, source) in descriptors.iter().zip(sources) {
            if descriptor.revents & libc::POLLNVAL != 0 {
                return Err(invalid("controller poll observed an invalid descriptor"));
            }
            if descriptor.revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR) == 0 {
                continue;
            }
            match source {
                EventSource::Guardian => ready.guardian = true,
                EventSource::Direct => ready.direct = true,
            }
        }
        Ok(ready)
    }

    fn protect_stream_from_sigpipe(stream: &UnixStream) -> io::Result<()> {
        let enabled: libc::c_int = 1;
        let result = unsafe {
            libc::setsockopt(
                stream.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_NOSIGPIPE,
                (&enabled as *const libc::c_int).cast(),
                std::mem::size_of_val(&enabled) as libc::socklen_t,
            )
        };
        if result == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }

    fn checked_deadline(timeout: Duration) -> io::Result<Instant> {
        Instant::now()
            .checked_add(timeout)
            .ok_or_else(|| invalid("controller deadline is too large"))
    }

    fn require_same_result(left: &RunResult, right: &RunResult) -> io::Result<()> {
        let left = serde_json::to_vec(left)
            .map_err(|error| invalid(format!("serialize guardian result: {error}")))?;
        let right = serde_json::to_vec(right)
            .map_err(|error| invalid(format!("serialize direct result: {error}")))?;
        if left == right {
            Ok(())
        } else {
            Err(invalid(
                "guardian and direct supervisor prepared results differ",
            ))
        }
    }
}

#[cfg(target_os = "macos")]
pub use imp::run_with_guardian;
#[cfg(target_os = "macos")]
pub(crate) use imp::{run_with_guardian_paired, PairedRun};

#[cfg(not(target_os = "macos"))]
pub fn run_with_guardian(
    _root: &std::path::Path,
    _spec: &crate::protocol::RunSpec,
    _active: &crate::platform::ActiveRuns,
) -> Result<crate::protocol::RunResult, String> {
    Err("guarded macOS runs are unavailable on this platform".into())
}

#[cfg(test)]
mod tests {
    use super::{CleanupCause, EventSource, ExecutorRunState, ProcessIdentity};

    fn identity(pid: i32, pgid: i32, start_abstime: u64) -> ProcessIdentity {
        ProcessIdentity {
            pid,
            pgid,
            start_abstime,
        }
    }

    #[test]
    fn ownership_commit_requires_matching_direct_and_guardian_proofs() {
        let anchor = identity(40, 40, 400);
        let mut state = ExecutorRunState::default();
        state.record_direct_registered(anchor).unwrap();
        state.record_direct_ready(anchor).unwrap();
        assert_eq!(state.anchor().unwrap(), anchor);
        assert!(!state.proofs_complete());
        assert!(state.record_committed().is_err());
        state.record_guardian_started(anchor).unwrap();
        assert!(state.proofs_complete());
        state.record_committed().unwrap();
    }

    #[test]
    fn target_identity_is_bound_across_both_channels() {
        let anchor = identity(50, 50, 500);
        let target = identity(51, 50, 510);
        let mut state = ExecutorRunState::default();
        state.record_direct_registered(anchor).unwrap();
        state.record_direct_ready(anchor).unwrap();
        state.record_guardian_started(anchor).unwrap();
        state.record_committed().unwrap();
        state
            .record_target(EventSource::Direct, anchor, target)
            .unwrap();
        state
            .record_target(EventSource::Guardian, anchor, target)
            .unwrap();
        assert!(state
            .record_target(EventSource::Guardian, anchor, target)
            .is_err());
        assert!(state
            .record_target(EventSource::Direct, anchor, identity(52, 50, 520))
            .is_err());
    }

    #[test]
    fn cleanup_is_first_wins_and_prepared_requires_a_request() {
        let anchor = identity(60, 60, 600);
        let mut state = ExecutorRunState::default();
        state.record_direct_registered(anchor).unwrap();
        assert!(state.record_prepared(EventSource::Direct, anchor).is_err());
        state
            .request_cleanup(Some(anchor), CleanupCause::Cancelled)
            .unwrap();
        state
            .request_cleanup(Some(anchor), CleanupCause::InternalError)
            .unwrap();
        assert_eq!(state.cleanup_cause(), Some(CleanupCause::Cancelled));
        state.record_prepared(EventSource::Direct, anchor).unwrap();
    }
}
