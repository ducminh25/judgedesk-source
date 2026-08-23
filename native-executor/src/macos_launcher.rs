#[cfg(target_os = "macos")]
mod macos {
    use crate::guardian_protocol::{
        authenticate_process_identity, read_authenticated_frame, write_authenticated_frame,
        CleanupCause, FrameIdentity, LauncherMonitorLimits, LauncherRlimits, LauncherSpec,
        ProcessIdentity, SupervisorDirectCommand, SupervisorEvent, SupervisorGuardianCommand,
        SupervisorLaunchState, MACOS_RUN_SUPERVISOR_ARGUMENT, SUPERVISOR_DIRECT_FD_ENV,
        SUPERVISOR_GENERATION_ENV, SUPERVISOR_GUARDIAN_FD_ENV, SUPERVISOR_GUARDIAN_PID_ENV,
        SUPERVISOR_RUN_ID_ENV, SUPERVISOR_TOKEN_ENV,
    };
    use crate::macos_process::{
        inventory_live_process_group, read_process_identity,
        verify_live_anchor_descendants_stopped, verify_process_identity, IdentityVerification,
        LiveAnchorProtocolLiveness,
    };
    use crate::protocol::{RunReason, RunResult};
    use crate::request_validation::validate_environment;
    use crate::tree_guard;
    use crate::workspace::{file_size, inspect_workspace};
    use std::ffi::{CString, OsStr};
    use std::fs::{File, OpenOptions};
    use std::io::{self, Read, Write};
    use std::os::fd::{AsRawFd, FromRawFd, RawFd};
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::{FileTypeExt, MetadataExt, OpenOptionsExt};
    use std::os::unix::net::UnixStream;
    use std::os::unix::process::ExitStatusExt;
    use std::path::{Path, PathBuf};
    use std::process::ExitStatus;
    use std::time::{Duration, Instant};

    const SANDBOX_EXECUTABLE: &str = "/usr/bin/sandbox-exec";
    const FIRST_AMBIENT_FD: RawFd = 3;
    const MAX_ARGUMENTS: usize = 4096;
    const MAX_ENVIRONMENT_ENTRIES: usize = 256;
    const MAX_LAUNCH_TEXT_BYTES: usize = 512 * 1024;
    const MAX_OPEN_FILES: u64 = 1024;
    const CONTROL_POLL_INTERVAL_MS: i32 = 2;
    const EXEC_CONFIRM_TIMEOUT: Duration = Duration::from_secs(5);
    const CHILD_IDENTITY_TIMEOUT: Duration = Duration::from_millis(250);
    const EXTERNAL_FREEZE_PROOF_TIMEOUT: Duration = Duration::from_millis(200);
    const EXEC_STATUS_BYTES: usize = 8;
    const CHILD_RELEASE_BYTE: u8 = 0xa5;

    #[derive(Debug, Clone, Copy)]
    #[repr(u32)]
    enum ChildSetupStage {
        Release = 1,
        SignalPolicy = 2,
        Limits = 3,
        WorkingDirectory = 4,
        Stdin = 5,
        Stdout = 6,
        Stderr = 7,
        Exec = 9,
    }

    #[derive(Debug, Clone, Copy)]
    struct ChildSetupFailure {
        stage: u32,
        errno: i32,
    }

    #[derive(Debug)]
    struct PreparedLaunch {
        sandbox_executable: CString,
        arguments: Vec<CString>,
        environment: Vec<CString>,
        cwd: CString,
        cwd_path: PathBuf,
        stdout_path: PathBuf,
        stderr_path: PathBuf,
        stdin: File,
        stdout: File,
        stderr: File,
        limits: LauncherRlimits,
        monitor_limits: LauncherMonitorLimits,
        fd_scan_limit: RawFd,
        baseline_workspace_bytes: u64,
        baseline_workspace_files: u32,
    }

    #[derive(Debug)]
    struct SpawnedTarget {
        identity: ProcessIdentity,
        exec_confirmed: bool,
        setup_failure: Option<ChildSetupFailure>,
        reaped: Option<WaitOutcome>,
        started_at: Instant,
        finished_at: Option<Instant>,
        security_setup_time_us: u64,
        peak_memory_bytes: u64,
        last_usage: GroupUsage,
        baseline_workspace_bytes: u64,
        baseline_workspace_files: u32,
        cwd_path: PathBuf,
        stdout_path: PathBuf,
        stderr_path: PathBuf,
        monitor_limits: LauncherMonitorLimits,
    }

    #[derive(Debug)]
    struct WaitOutcome {
        status: ExitStatus,
        usage: libc::rusage,
    }

    #[derive(Debug, Default, Clone, Copy)]
    struct GroupUsage {
        memory_bytes: u64,
        user_time_ns: u64,
        system_time_ns: u64,
        processes: u32,
        threads: u32,
    }

    struct ControllerChannel {
        stream: UnixStream,
        open: bool,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum Controller {
        Guardian,
        Direct,
    }

    const PREPARED_BROADCAST_ORDER: [Controller; 2] = [Controller::Direct, Controller::Guardian];

    struct SupervisorSession {
        identity: FrameIdentity,
        anchor: ProcessIdentity,
        guardian: ControllerChannel,
        direct: ControllerChannel,
        state: SupervisorLaunchState,
        prepared: Option<PreparedLaunch>,
        target: Option<SpawnedTarget>,
        cleanup_authorized: bool,
        cleanup_authorizer: Option<Controller>,
        diagnostic: Option<String>,
        setup_started: Instant,
    }

    pub fn try_run_internal_mode() -> Option<i32> {
        if std::env::args_os().nth(1).as_deref() != Some(OsStr::new(MACOS_RUN_SUPERVISOR_ARGUMENT))
        {
            return None;
        }
        if std::env::args_os().nth(2).is_some() {
            return Some(64);
        }
        Some(match supervisor_main() {
            Ok(()) => 0,
            Err(error) => {
                let _ = writeln!(
                    io::stderr(),
                    "JudgeDesk macOS run supervisor startup failed: {error}"
                );
                70
            }
        })
    }

    fn supervisor_main() -> io::Result<()> {
        install_supervisor_signal_policy()?;
        let identity = supervisor_identity_from_environment()?;
        let expected_guardian = positive_i32_environment(
            SUPERVISOR_GUARDIAN_PID_ENV,
            "run supervisor guardian PID is missing or invalid",
        )?;
        validate_guardian_parent(expected_guardian, unsafe { libc::getppid() })?;

        let guardian_fd = inherited_fd_from_environment(
            SUPERVISOR_GUARDIAN_FD_ENV,
            "run supervisor guardian channel FD is missing or invalid",
        )?;
        let direct_fd = inherited_fd_from_environment(
            SUPERVISOR_DIRECT_FD_ENV,
            "run supervisor direct channel FD is missing or invalid",
        )?;
        if guardian_fd == direct_fd {
            return Err(invalid(
                "run supervisor control channels must use distinct descriptors",
            ));
        }
        let guardian = inherited_unix_stream(guardian_fd)?;
        let direct = inherited_unix_stream(direct_fd)?;

        let generation_guard = tree_guard::acquire_from_environment()
            .map_err(|error| io::Error::new(io::ErrorKind::PermissionDenied, error))?
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "run supervisor requires an independent generation guard",
                )
            })?;
        let tree_generation = std::env::var(tree_guard::GENERATION_ENV).map_err(|_| {
            io::Error::new(
                io::ErrorKind::PermissionDenied,
                "run supervisor tree generation is missing",
            )
        })?;
        if tree_generation != identity.generation {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "run supervisor protocol and tree generations differ",
            ));
        }

        let anchor = become_process_group_anchor()?;
        let mut session = SupervisorSession::new(identity, anchor, guardian, direct)?;
        // The guard is intentionally held across the infinite post-Prepared wait. The only
        // successful terminal path is the external controller's whole-group SIGKILL.
        let _generation_guard = generation_guard;
        loop {
            match session.run() {
                Ok(()) => hold_generation_guard_forever(),
                Err(error) => {
                    session.diagnostic.get_or_insert_with(|| error.to_string());
                    session.report_fatal("SUPERVISOR_INTERNAL_FAILED", error.to_string());
                    session.request_cleanup(CleanupCause::InternalError);
                    if !session.guardian.open && !session.direct.open {
                        hold_generation_guard_forever();
                    }
                }
            }
        }
    }

    impl SupervisorSession {
        fn new(
            identity: FrameIdentity,
            anchor: ProcessIdentity,
            guardian: UnixStream,
            direct: UnixStream,
        ) -> io::Result<Self> {
            let mut state = SupervisorLaunchState::default();
            state.record_registered(anchor)?;
            let mut session = Self {
                identity,
                anchor,
                guardian: ControllerChannel {
                    stream: guardian,
                    open: true,
                },
                direct: ControllerChannel {
                    stream: direct,
                    open: true,
                },
                state,
                prepared: None,
                target: None,
                cleanup_authorized: false,
                cleanup_authorizer: None,
                diagnostic: None,
                setup_started: Instant::now(),
            };
            session.broadcast(&SupervisorEvent::registered(
                &session.identity,
                session.anchor,
            ));
            session.reconcile_channel_loss();
            Ok(session)
        }

        fn run(&mut self) -> io::Result<()> {
            loop {
                if self.cleanup_authorized {
                    match self.prepare_final_result() {
                        Ok(result) => {
                            self.state.record_prepared()?;
                            self.broadcast_prepared(&SupervisorEvent::prepared(
                                &self.identity,
                                self.anchor,
                                result,
                            ));
                            hold_generation_guard_forever();
                        }
                        Err(error) => {
                            self.report_fatal(
                                "SUPERVISOR_PREPARE_FAILED",
                                format!(
                                    "cannot reap the direct target or prepare its result: {error}"
                                ),
                            );
                            hold_generation_guard_forever();
                        }
                    }
                }

                if self.state.may_fork_target() {
                    if let Err(error) = self.launch_target() {
                        self.diagnostic = Some(format!("target launch failed: {error}"));
                        self.request_cleanup(CleanupCause::LaunchFailed);
                    }
                    continue;
                }

                self.observe_target();
                if !self.guardian.open && !self.direct.open {
                    hold_generation_guard_forever();
                }

                let timeout_ms = if self.target.is_some() {
                    CONTROL_POLL_INTERVAL_MS
                } else {
                    -1
                };
                let ready = self.poll_controllers(timeout_ms)?;
                for controller in ready {
                    if let Err(error) = self.read_controller(controller) {
                        self.close_controller(controller);
                        self.diagnostic
                            .get_or_insert_with(|| format!("control protocol failed: {error}"));
                        self.report_fatal("SUPERVISOR_PROTOCOL_FAILED", error.to_string());
                        self.request_cleanup(CleanupCause::ProtocolViolation);
                    }
                }
                self.reconcile_channel_loss();
            }
        }

        fn read_controller(&mut self, controller: Controller) -> io::Result<()> {
            match controller {
                Controller::Guardian => {
                    let frame = read_authenticated_frame::<_, SupervisorGuardianCommand>(
                        &mut self.guardian.stream,
                        &self.identity,
                    )?;
                    let Some(frame) = frame else {
                        self.close_controller(controller);
                        return Ok(());
                    };
                    self.handle_guardian_command(frame)
                }
                Controller::Direct => {
                    let frame = read_authenticated_frame::<_, SupervisorDirectCommand>(
                        &mut self.direct.stream,
                        &self.identity,
                    )?;
                    let Some(frame) = frame else {
                        self.close_controller(controller);
                        return Ok(());
                    };
                    self.handle_direct_command(frame)
                }
            }
        }

        fn handle_guardian_command(&mut self, frame: SupervisorGuardianCommand) -> io::Result<()> {
            match frame {
                SupervisorGuardianCommand::Configure { spec, .. } => {
                    if self.prepared.is_some()
                        || self.target.is_some()
                        || self.state.cleanup_cause().is_some()
                    {
                        return Err(invalid(
                            "duplicate or out-of-order supervisor configuration",
                        ));
                    }
                    let prepared = PreparedLaunch::new(*spec)?;
                    self.state.record_ready(self.anchor)?;
                    self.prepared = Some(prepared);
                    self.broadcast(&SupervisorEvent::ready(&self.identity, self.anchor));
                    self.reconcile_channel_loss();
                    Ok(())
                }
                SupervisorGuardianCommand::Go { anchor, .. } => {
                    authenticate_process_identity(&anchor, &self.anchor)?;
                    self.state.record_guardian_go(anchor)
                }
                SupervisorGuardianCommand::Cleanup { anchor, cause, .. } => {
                    self.authorize_cleanup(Controller::Guardian, anchor, cause)
                }
            }
        }

        fn handle_direct_command(&mut self, frame: SupervisorDirectCommand) -> io::Result<()> {
            match frame {
                SupervisorDirectCommand::Commit { anchor, .. } => {
                    authenticate_process_identity(&anchor, &self.anchor)?;
                    self.state.record_direct_commit(anchor)
                }
                SupervisorDirectCommand::Cleanup { anchor, cause, .. } => {
                    self.authorize_cleanup(Controller::Direct, anchor, cause)
                }
            }
        }

        fn authorize_cleanup(
            &mut self,
            controller: Controller,
            anchor: ProcessIdentity,
            cause: CleanupCause,
        ) -> io::Result<()> {
            authenticate_process_identity(&anchor, &self.anchor)?;
            if self.state.cleanup_cause().is_none() {
                self.request_cleanup(cause);
            }
            if self.cleanup_authorized {
                // Either controller may race to acknowledge the same first-wins cleanup cause.
                // Matching authenticated duplicates are idempotent and may refresh the channel
                // used for the stopped-descendant liveness proof.
                self.cleanup_authorizer = Some(controller);
                return Ok(());
            }
            self.cleanup_authorized = true;
            self.cleanup_authorizer = Some(controller);
            Ok(())
        }

        fn launch_target(&mut self) -> io::Result<()> {
            let prepared = self
                .prepared
                .as_ref()
                .ok_or_else(|| invalid("supervisor launch state has no prepared target"))?;
            let security_setup_time_us = self
                .setup_started
                .elapsed()
                .as_micros()
                .min(u64::MAX as u128) as u64;
            let target = prepared.spawn(self.anchor, security_setup_time_us)?;
            self.state.record_target_started(target.identity)?;
            let target_identity = target.identity;
            let exec_confirmed = target.exec_confirmed;
            if !exec_confirmed {
                let detail = target
                    .setup_failure
                    .map(|failure| {
                        format!(
                            "target child setup failed at stage {} with errno {}",
                            failure.stage, failure.errno
                        )
                    })
                    .unwrap_or_else(|| {
                        "target child did not confirm exec before the bounded deadline".into()
                    });
                self.diagnostic = Some(detail);
            }
            self.target = Some(target);
            self.prepared = None;
            if exec_confirmed {
                self.broadcast(&SupervisorEvent::target_started(
                    &self.identity,
                    self.anchor,
                    target_identity,
                ));
                self.reconcile_channel_loss();
            } else {
                self.request_cleanup(CleanupCause::LaunchFailed);
            }
            Ok(())
        }

        fn observe_target(&mut self) {
            if self.state.cleanup_cause().is_some() {
                return;
            }
            let Some(target) = self.target.as_mut() else {
                return;
            };

            match wait4_target(target.identity.pid, libc::WNOHANG) {
                Ok(Some(outcome)) => {
                    target.reaped = Some(outcome);
                    target.finished_at.get_or_insert_with(Instant::now);
                }
                Ok(None) => {}
                Err(error) => {
                    self.diagnostic = Some(format!("wait4 target monitor failed: {error}"));
                    self.request_cleanup(CleanupCause::InternalError);
                    return;
                }
            }

            match observe_group_usage(self.anchor) {
                Ok(usage) => {
                    target.peak_memory_bytes = target.peak_memory_bytes.max(usage.memory_bytes);
                    target.last_usage = usage;
                }
                Err(error) => {
                    self.diagnostic =
                        Some(format!("cannot inventory anchored target group: {error}"));
                    self.request_cleanup(CleanupCause::InternalError);
                    return;
                }
            }
            let (cause, diagnostic) = if target.reaped.is_some() {
                classify_exited_target(target)
            } else {
                classify_live_target(target)
            };
            if let Some(cause) = cause {
                if diagnostic.is_some() {
                    self.diagnostic = diagnostic;
                }
                self.request_cleanup(cause);
            }
        }

        fn prepare_final_result(&mut self) -> io::Result<RunResult> {
            let collection_started = Instant::now();
            let cause = self
                .state
                .cleanup_cause()
                .ok_or_else(|| invalid("cleanup was authorized without a cleanup cause"))?;
            if let Some(target) = self.target.as_mut() {
                if target.reaped.is_none() {
                    // The external controller has already stopped the whole anchored group. A
                    // direct target may have exited after the monitor's last WNOHANG but before
                    // that freeze. macOS libproc still lists the resulting zombie in the PGID
                    // while refusing its identity with ESRCH, so reap this exact owned child
                    // non-blockingly before asking libproc to prove the remaining live
                    // descendants stopped. A still-live target returns None and is handled only
                    // after the freeze proof below.
                    pre_reap_exited_direct_target(target.identity, &mut target.reaped)?;
                }
            }
            self.verify_external_freeze()?;

            let result = if let Some(mut target) = self.target.take() {
                if target.reaped.is_none() {
                    kill_direct_target(target.identity).map_err(|error| {
                        io::Error::new(
                            error.kind(),
                            format!("terminate exact direct target: {error}"),
                        )
                    })?;
                    target.reaped = Some(
                        wait4_target(target.identity.pid, 0)
                            .map_err(|error| {
                                io::Error::new(
                                    error.kind(),
                                    format!("wait4 exact direct target: {error}"),
                                )
                            })?
                            .ok_or_else(|| io::Error::other("blocking wait4 returned no target"))?,
                    );
                }
                let final_usage = observe_group_usage(self.anchor).unwrap_or(target.last_usage);
                target.peak_memory_bytes = target.peak_memory_bytes.max(final_usage.memory_bytes);
                target.last_usage = final_usage;
                build_target_result(
                    &self.identity.run_id,
                    cause,
                    target,
                    self.diagnostic.take(),
                    collection_started,
                )
            } else {
                build_no_target_result(
                    &self.identity.run_id,
                    cause,
                    self.prepared.as_ref(),
                    self.diagnostic.take(),
                    self.setup_started,
                    collection_started,
                )
            };
            Ok(result)
        }

        fn verify_external_freeze(&self) -> io::Result<()> {
            let authorizer = self.cleanup_authorizer.ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "cleanup has no authenticated external authorizer",
                )
            })?;
            let channel = match authorizer {
                Controller::Guardian if self.guardian.open => &self.guardian.stream,
                Controller::Direct if self.direct.open => &self.direct.stream,
                _ => {
                    return Err(io::Error::new(
                        io::ErrorKind::BrokenPipe,
                        "cleanup authorizer disconnected before the freeze proof",
                    ))
                }
            };
            let deadline = Instant::now()
                .checked_add(EXTERNAL_FREEZE_PROOF_TIMEOUT)
                .ok_or_else(|| io::Error::other("freeze-proof deadline overflow"))?;
            loop {
                match verify_descendants_stopped(self.anchor, channel) {
                    Ok(()) => return Ok(()),
                    Err(error)
                        if error.kind() == io::ErrorKind::WouldBlock
                            || error.kind() == io::ErrorKind::NotFound =>
                    {
                        if Instant::now() >= deadline {
                            if matches!(
                                self.state.cleanup_cause(),
                                Some(
                                    CleanupCause::ProcessLimit
                                        | CleanupCause::MemoryLimit
                                        | CleanupCause::WallTimeLimit
                                        | CleanupCause::OutputLimit
                                        | CleanupCause::WriteLimit
                                        | CleanupCause::Cancelled
                                )
                            ) {
                                return Ok(());
                            }
                            return Err(io::Error::new(
                                error.kind(),
                                format!(
                                    "stopped process-group proof did not stabilize within {:?}: {error}",
                                    EXTERNAL_FREEZE_PROOF_TIMEOUT
                                ),
                            ));
                        }
                        std::thread::sleep(Duration::from_millis(CONTROL_POLL_INTERVAL_MS as u64));
                    }
                    Err(error) => return Err(error),
                }
            }
        }

        fn request_cleanup(&mut self, cause: CleanupCause) {
            if self.state.cleanup_cause().is_some() {
                return;
            }
            if let Some(target) = self.target.as_mut() {
                target.finished_at.get_or_insert_with(Instant::now);
            }
            self.state.request_cleanup(cause);
            self.broadcast(&SupervisorEvent::cleanup_requested(
                &self.identity,
                self.anchor,
                cause,
            ));
            self.reconcile_channel_loss();
        }

        fn report_fatal(&mut self, code: &str, message: String) {
            self.broadcast(&SupervisorEvent::fatal(
                &self.identity,
                Some(self.anchor),
                code,
                message,
            ));
        }

        fn broadcast(&mut self, event: &SupervisorEvent) {
            for controller in [Controller::Guardian, Controller::Direct] {
                self.send_event(controller, event);
            }
        }

        fn broadcast_prepared(&mut self, event: &SupervisorEvent) {
            // The guardian is authorized to SIGKILL the anchored group as soon as it receives
            // Prepared. Publish the complete direct-executor frame first so that a guardian
            // receiving Prepared is also proof that SIGKILL cannot truncate the direct frame.
            for controller in PREPARED_BROADCAST_ORDER {
                self.send_event(controller, event);
            }
        }

        fn send_event(&mut self, controller: Controller, event: &SupervisorEvent) {
            let channel = match controller {
                Controller::Guardian => &mut self.guardian,
                Controller::Direct => &mut self.direct,
            };
            if channel.open
                && write_authenticated_frame(&mut channel.stream, event, &self.identity).is_err()
            {
                channel.open = false;
            }
        }

        fn reconcile_channel_loss(&mut self) {
            if self.state.cleanup_cause().is_some() {
                return;
            }
            let cause = if !self.guardian.open {
                Some(CleanupCause::GuardianDisconnected)
            } else if !self.direct.open {
                Some(CleanupCause::ExecutorDisconnected)
            } else {
                None
            };
            if let Some(cause) = cause {
                self.diagnostic = Some(format!(
                    "{} controller disconnected before cleanup",
                    if cause == CleanupCause::GuardianDisconnected {
                        "guardian"
                    } else {
                        "executor"
                    }
                ));
                self.request_cleanup(cause);
            }
        }

        fn close_controller(&mut self, controller: Controller) {
            match controller {
                Controller::Guardian => self.guardian.open = false,
                Controller::Direct => self.direct.open = false,
            }
        }

        fn poll_controllers(&self, timeout_ms: i32) -> io::Result<Vec<Controller>> {
            let mut descriptors = [
                libc::pollfd {
                    fd: if self.guardian.open {
                        self.guardian.stream.as_raw_fd()
                    } else {
                        -1
                    },
                    events: libc::POLLIN | libc::POLLHUP | libc::POLLERR,
                    revents: 0,
                },
                libc::pollfd {
                    fd: if self.direct.open {
                        self.direct.stream.as_raw_fd()
                    } else {
                        -1
                    },
                    events: libc::POLLIN | libc::POLLHUP | libc::POLLERR,
                    revents: 0,
                },
            ];
            loop {
                let count = unsafe {
                    libc::poll(descriptors.as_mut_ptr(), descriptors.len() as _, timeout_ms)
                };
                if count >= 0 {
                    break;
                }
                let error = io::Error::last_os_error();
                if error.kind() != io::ErrorKind::Interrupted {
                    return Err(error);
                }
            }
            let mut ready = Vec::with_capacity(2);
            for (index, descriptor) in descriptors.iter().enumerate() {
                if descriptor.revents
                    & (libc::POLLIN | libc::POLLHUP | libc::POLLERR | libc::POLLNVAL)
                    != 0
                {
                    ready.push(if index == 0 {
                        Controller::Guardian
                    } else {
                        Controller::Direct
                    });
                }
            }
            Ok(ready)
        }
    }

    impl PreparedLaunch {
        fn new(spec: LauncherSpec) -> io::Result<Self> {
            validate_spec(&spec)?;
            let stdin = open_regular_input(&spec.stdin)?;
            let stdout = open_regular_output(&spec.stdout)?;
            let stderr = open_regular_output(&spec.stderr)?;

            let mut arguments = Vec::with_capacity(spec.arguments.len() + 5);
            arguments.push(path_cstring(
                &spec.sandbox_executable,
                "sandbox executable",
            )?);
            arguments.push(CString::new("-f").expect("static argument has no NUL"));
            arguments.push(path_cstring(&spec.sandbox_profile, "sandbox profile")?);
            arguments.push(path_cstring(&spec.target_executable, "target executable")?);
            for argument in &spec.arguments {
                arguments.push(text_cstring(argument, "target argument")?);
            }
            let environment = spec
                .environment
                .iter()
                .map(|(key, value)| text_cstring(&format!("{key}={value}"), "environment entry"))
                .collect::<io::Result<Vec<_>>>()?;
            let (baseline_workspace_bytes, baseline_workspace_files) = inspect_workspace(&spec.cwd);
            let fd_scan_limit = unsafe { libc::getdtablesize() };
            if fd_scan_limit <= FIRST_AMBIENT_FD {
                return Err(io::Error::other(
                    "run supervisor cannot determine its descriptor-table size",
                ));
            }

            Ok(Self {
                sandbox_executable: path_cstring(&spec.sandbox_executable, "sandbox executable")?,
                arguments,
                environment,
                cwd: path_cstring(&spec.cwd, "working directory")?,
                cwd_path: spec.cwd,
                stdout_path: spec.stdout,
                stderr_path: spec.stderr,
                stdin,
                stdout,
                stderr,
                limits: spec.limits,
                monitor_limits: spec.monitor_limits,
                fd_scan_limit,
                baseline_workspace_bytes,
                baseline_workspace_files,
            })
        }

        fn spawn(
            &self,
            anchor: ProcessIdentity,
            security_setup_time_us: u64,
        ) -> io::Result<SpawnedTarget> {
            let release = cloexec_pipe()?;
            let status = match cloexec_pipe() {
                Ok(status) => status,
                Err(error) => {
                    close_pipe(release);
                    return Err(error);
                }
            };
            let pid = unsafe { libc::fork() };
            if pid < 0 {
                let error = io::Error::last_os_error();
                close_pipe(release);
                close_pipe(status);
                return Err(error);
            }
            if pid == 0 {
                unsafe {
                    libc::close(release[1]);
                    libc::close(status[0]);
                }
                child_exec(self, release[0], status[1]);
            }

            unsafe {
                libc::close(release[0]);
                libc::close(status[1]);
            }
            let mut release_writer = unsafe { File::from_raw_fd(release[1]) };
            let mut status_reader = unsafe { File::from_raw_fd(status[0]) };

            let identity = match read_child_identity(pid, anchor, CHILD_IDENTITY_TIMEOUT) {
                Ok(identity) => identity,
                Err(error) => {
                    drop(release_writer);
                    drop(status_reader);
                    let _ = wait4_target(pid, 0);
                    return Err(error);
                }
            };
            if let Err(error) = release_writer.write_all(&[CHILD_RELEASE_BYTE]) {
                drop(release_writer);
                drop(status_reader);
                let _ = wait4_target(pid, 0);
                return Err(io::Error::new(
                    error.kind(),
                    format!("release target child: {error}"),
                ));
            }
            drop(release_writer);

            let (exec_confirmed, setup_failure) =
                match read_exec_confirmation(&mut status_reader, EXEC_CONFIRM_TIMEOUT) {
                    Ok(Some(failure)) => (false, Some(failure)),
                    Ok(None) => (true, None),
                    Err(error) if error.kind() == io::ErrorKind::TimedOut => (false, None),
                    Err(error) => (
                        false,
                        Some(ChildSetupFailure {
                            stage: ChildSetupStage::Exec as u32,
                            errno: error.raw_os_error().unwrap_or(libc::EIO),
                        }),
                    ),
                };

            Ok(SpawnedTarget {
                identity,
                exec_confirmed,
                setup_failure,
                reaped: None,
                started_at: Instant::now(),
                finished_at: None,
                security_setup_time_us,
                peak_memory_bytes: 0,
                last_usage: GroupUsage::default(),
                baseline_workspace_bytes: self.baseline_workspace_bytes,
                baseline_workspace_files: self.baseline_workspace_files,
                cwd_path: self.cwd_path.clone(),
                stdout_path: self.stdout_path.clone(),
                stderr_path: self.stderr_path.clone(),
                monitor_limits: self.monitor_limits.clone(),
            })
        }
    }

    fn child_exec(prepared: &PreparedLaunch, release_fd: RawFd, status_fd: RawFd) -> ! {
        let mut release = [0_u8; 1];
        if !child_read_exact(release_fd, &mut release) || release[0] != CHILD_RELEASE_BYTE {
            child_fail(ChildSetupStage::Release, status_fd);
        }
        unsafe {
            libc::close(release_fd);
        }
        if reset_child_signal_policy().is_err() {
            child_fail(ChildSetupStage::SignalPolicy, status_fd);
        }
        if set_limits(&prepared.limits).is_err() {
            child_fail(ChildSetupStage::Limits, status_fd);
        }
        if unsafe { libc::chdir(prepared.cwd.as_ptr()) } != 0 {
            child_fail(ChildSetupStage::WorkingDirectory, status_fd);
        }
        if duplicate(prepared.stdin.as_raw_fd(), libc::STDIN_FILENO).is_err() {
            child_fail(ChildSetupStage::Stdin, status_fd);
        }
        if duplicate(prepared.stdout.as_raw_fd(), libc::STDOUT_FILENO).is_err() {
            child_fail(ChildSetupStage::Stdout, status_fd);
        }
        if duplicate(prepared.stderr.as_raw_fd(), libc::STDERR_FILENO).is_err() {
            child_fail(ChildSetupStage::Stderr, status_fd);
        }

        close_ambient_file_descriptors(prepared.fd_scan_limit, status_fd);

        let mut argv = prepared
            .arguments
            .iter()
            .map(|value| value.as_ptr())
            .collect::<Vec<_>>();
        argv.push(std::ptr::null());
        let mut envp = prepared
            .environment
            .iter()
            .map(|value| value.as_ptr())
            .collect::<Vec<_>>();
        envp.push(std::ptr::null());
        unsafe {
            libc::execve(
                prepared.sandbox_executable.as_ptr(),
                argv.as_ptr(),
                envp.as_ptr(),
            );
        }
        child_fail(ChildSetupStage::Exec, status_fd)
    }

    fn child_fail(stage: ChildSetupStage, status_fd: RawFd) -> ! {
        let errno = unsafe { *libc::__error() };
        let mut record = [0_u8; EXEC_STATUS_BYTES];
        record[..4].copy_from_slice(&(stage as u32).to_le_bytes());
        record[4..].copy_from_slice(&errno.to_le_bytes());
        child_write_all(status_fd, &record);
        unsafe {
            libc::_exit(127);
        }
    }

    fn child_read_exact(descriptor: RawFd, bytes: &mut [u8]) -> bool {
        let mut read = 0;
        while read < bytes.len() {
            let amount = unsafe {
                libc::read(
                    descriptor,
                    bytes[read..].as_mut_ptr().cast(),
                    bytes.len() - read,
                )
            };
            if amount > 0 {
                read += amount as usize;
                continue;
            }
            if amount == 0 {
                return false;
            }
            if unsafe { *libc::__error() } != libc::EINTR {
                return false;
            }
        }
        true
    }

    fn child_write_all(descriptor: RawFd, bytes: &[u8]) {
        let mut written = 0;
        while written < bytes.len() {
            let amount = unsafe {
                libc::write(
                    descriptor,
                    bytes[written..].as_ptr().cast(),
                    bytes.len() - written,
                )
            };
            if amount > 0 {
                written += amount as usize;
                continue;
            }
            if amount < 0 && unsafe { *libc::__error() } == libc::EINTR {
                continue;
            }
            break;
        }
    }

    fn read_exec_confirmation(
        reader: &mut File,
        timeout: Duration,
    ) -> io::Result<Option<ChildSetupFailure>> {
        let timeout_ms = timeout.as_millis().min(i32::MAX as u128) as i32;
        let mut descriptor = libc::pollfd {
            fd: reader.as_raw_fd(),
            events: libc::POLLIN | libc::POLLHUP | libc::POLLERR,
            revents: 0,
        };
        loop {
            let count = unsafe { libc::poll(&mut descriptor, 1, timeout_ms) };
            if count > 0 {
                break;
            }
            if count == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "target exec confirmation timed out",
                ));
            }
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
            }
        }

        let mut record = [0_u8; EXEC_STATUS_BYTES];
        let mut read = 0;
        while read < record.len() {
            match reader.read(&mut record[read..]) {
                Ok(0) if read == 0 => return Ok(None),
                Ok(0) => {
                    return Err(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        "truncated target exec-status record",
                    ))
                }
                Ok(amount) => read += amount,
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(error),
            }
        }
        Ok(Some(ChildSetupFailure {
            stage: u32::from_le_bytes(record[..4].try_into().expect("fixed stage bytes")),
            errno: i32::from_le_bytes(record[4..].try_into().expect("fixed errno bytes")),
        }))
    }

    fn read_child_identity(
        pid: i32,
        anchor: ProcessIdentity,
        timeout: Duration,
    ) -> io::Result<ProcessIdentity> {
        let deadline = Instant::now() + timeout;
        loop {
            match read_process_identity(pid) {
                Ok(identity) if identity.pid != anchor.pid && identity.pgid == anchor.pgid => {
                    return Ok(identity)
                }
                Ok(identity) => {
                    return Err(io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        format!(
                            "target child escaped supervisor group before release: {identity:?}"
                        ),
                    ))
                }
                Err(error)
                    if error.raw_os_error() == Some(libc::ESRCH) && Instant::now() < deadline =>
                {
                    std::thread::yield_now();
                }
                Err(error) => return Err(error),
            }
        }
    }

    fn validate_spec(spec: &LauncherSpec) -> io::Result<()> {
        if spec.sandbox_executable != Path::new(SANDBOX_EXECUTABLE) {
            return Err(invalid("run supervisor requires /usr/bin/sandbox-exec"));
        }
        for (path, label) in [
            (&spec.sandbox_executable, "sandbox executable"),
            (&spec.sandbox_profile, "sandbox profile"),
            (&spec.target_executable, "target executable"),
            (&spec.cwd, "working directory"),
            (&spec.stdin, "stdin"),
            (&spec.stdout, "stdout"),
            (&spec.stderr, "stderr"),
        ] {
            if !path.is_absolute() {
                return Err(invalid(format!("{label} path is not absolute")));
            }
        }
        if !spec.sandbox_executable.is_file()
            || !spec.sandbox_profile.is_file()
            || !spec.target_executable.is_file()
            || !spec.cwd.is_dir()
        {
            return Err(invalid("run supervisor input paths are unavailable"));
        }
        if spec.stdout == spec.stderr || spec.stdin == spec.stdout || spec.stdin == spec.stderr {
            return Err(invalid(
                "run supervisor stdin, stdout, and stderr paths must be distinct",
            ));
        }
        if spec.arguments.len() > MAX_ARGUMENTS || spec.environment.len() > MAX_ENVIRONMENT_ENTRIES
        {
            return Err(invalid(
                "run supervisor argument or environment count is too large",
            ));
        }
        let text_bytes = spec
            .arguments
            .iter()
            .map(String::len)
            .chain(
                spec.environment
                    .iter()
                    .map(|(key, value)| key.len().saturating_add(value.len())),
            )
            .fold(0_usize, usize::saturating_add);
        if text_bytes > MAX_LAUNCH_TEXT_BYTES {
            return Err(invalid("run supervisor launch text is too large"));
        }
        validate_environment(&spec.environment).map_err(invalid)?;
        validate_target_environment_again(&spec.environment)?;
        if spec.limits.file_size_bytes == 0
            || !(3..=MAX_OPEN_FILES).contains(&spec.limits.open_files)
            || spec.limits.nproc_ceiling == 0
            || spec.limits.address_space_bytes == Some(0)
        {
            return Err(invalid("run supervisor resource limits are invalid"));
        }
        let monitor = &spec.monitor_limits;
        if monitor.wall_time_ms == 0
            || monitor.wall_time_ms > 300_000
            || monitor.memory_bytes < 8 * 1024 * 1024
            || monitor.memory_bytes > 16 * 1024 * 1024 * 1024
            || monitor.process_count == 0
            || monitor.process_count > 32
            || monitor.thread_count == 0
            || monitor.thread_count > 256
            || monitor.output_bytes == 0
            || monitor.total_write_bytes < monitor.output_bytes
            || monitor.created_files == 0
            || monitor.created_files > 4096
        {
            return Err(invalid("run supervisor monitor limits are invalid"));
        }
        Ok(())
    }

    fn validate_target_environment_again(
        environment: &std::collections::BTreeMap<String, String>,
    ) -> io::Result<()> {
        for key in environment.keys() {
            let normalized = key.to_ascii_uppercase();
            let loader_control = normalized.starts_with("DYLD_")
                || normalized.starts_with("__XPC_DYLD_")
                || normalized.starts_with("LD_")
                || normalized.starts_with("MALLOC")
                || matches!(
                    normalized.as_str(),
                    "LIBGMALLOC" | "_RLD_ROOT" | "LIBPATH" | "SHLIB_PATH"
                );
            let internal_control = normalized.starts_with("JUDGEDESK_TREE_GUARD_")
                || normalized.starts_with("JUDGEDESK_RUN_GUARDIAN_")
                || normalized.starts_with("JUDGEDESK_RUN_SUPERVISOR_")
                || normalized.starts_with("JUDGEDESK_RUN_LAUNCHER_")
                || normalized.starts_with("JUDGEDESK_EXECUTOR_")
                || normalized.starts_with("JUDGEDESK_BOOTSTRAP_")
                || normalized.starts_with("JUDGEDESK_PROBE_")
                || normalized == "JUDGEDESK_SENTINEL"
                || normalized == "JUDGEDESK_START";
            if loader_control || internal_control {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    format!("environment variable {key} is reserved by the run supervisor"),
                ));
            }
        }
        Ok(())
    }

    fn open_regular_input(path: &Path) -> io::Result<File> {
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
            .open(path)?;
        if path == Path::new("/dev/null") {
            let metadata = file.metadata()?;
            if !metadata.file_type().is_char_device() {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "trusted empty stdin is not the /dev/null character device",
                ));
            }
        } else {
            validate_regular_io_file(&file, "stdin")?;
        }
        Ok(file)
    }

    fn open_regular_output(path: &Path) -> io::Result<File> {
        // Do not request O_TRUNC until fstat has rejected hard links and non-regular files.
        // This makes validation occur before any attacker-controlled inode can be damaged.
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .mode(0o600)
            .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
            .open(path)?;
        validate_regular_io_file(&file, "output")?;
        if unsafe { libc::fchmod(file.as_raw_fd(), 0o600) } != 0 {
            return Err(io::Error::last_os_error());
        }
        if unsafe { libc::ftruncate(file.as_raw_fd(), 0) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(file)
    }

    fn validate_regular_io_file(file: &File, label: &str) -> io::Result<()> {
        let metadata = file.metadata()?;
        if !metadata.file_type().is_file()
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.nlink() != 1
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!("{label} must be a single-link regular file owned by the current user"),
            ));
        }
        Ok(())
    }

    fn supervisor_identity_from_environment() -> io::Result<FrameIdentity> {
        let token = required_environment(SUPERVISOR_TOKEN_ENV, "run supervisor token is missing")?;
        let generation = required_environment(
            SUPERVISOR_GENERATION_ENV,
            "run supervisor generation is missing",
        )?;
        let run_id =
            required_environment(SUPERVISOR_RUN_ID_ENV, "run supervisor run ID is missing")?;
        FrameIdentity::new(token, generation, run_id)
    }

    fn required_environment(name: &str, message: &str) -> io::Result<String> {
        std::env::var(name).map_err(|_| io::Error::new(io::ErrorKind::PermissionDenied, message))
    }

    fn positive_i32_environment(name: &str, message: &str) -> io::Result<i32> {
        let value = required_environment(name, message)?;
        if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(io::Error::new(io::ErrorKind::PermissionDenied, message));
        }
        value
            .parse::<i32>()
            .ok()
            .filter(|value| *value > 0)
            .ok_or_else(|| io::Error::new(io::ErrorKind::PermissionDenied, message))
    }

    fn inherited_fd_from_environment(name: &str, message: &str) -> io::Result<RawFd> {
        let descriptor = positive_i32_environment(name, message)?;
        if descriptor < FIRST_AMBIENT_FD {
            Err(io::Error::new(io::ErrorKind::PermissionDenied, message))
        } else {
            Ok(descriptor)
        }
    }

    fn inherited_unix_stream(descriptor: RawFd) -> io::Result<UnixStream> {
        let mut stat: libc::stat = unsafe { std::mem::zeroed() };
        if unsafe { libc::fstat(descriptor, &mut stat) } != 0 {
            return Err(io::Error::last_os_error());
        }
        if stat.st_mode & libc::S_IFMT != libc::S_IFSOCK {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "run supervisor inherited control descriptor is not a socket",
            ));
        }
        set_close_on_exec(descriptor)?;
        // SAFETY: the dedicated inherited descriptor is transferred to this process exactly
        // once by its guardian. This function assumes ownership only after fstat validation.
        Ok(unsafe { UnixStream::from_raw_fd(descriptor) })
    }

    fn validate_guardian_parent(expected: i32, actual: i32) -> io::Result<()> {
        if expected > 1 && actual == expected {
            Ok(())
        } else {
            Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "run supervisor parent does not match its guardian",
            ))
        }
    }

    fn become_process_group_anchor() -> io::Result<ProcessIdentity> {
        let pid = i32::try_from(std::process::id())
            .map_err(|_| invalid("run supervisor PID does not fit in pid_t"))?;
        if unsafe { libc::setpgid(0, 0) } != 0 {
            let error = io::Error::last_os_error();
            if unsafe { libc::getpgrp() } != pid {
                return Err(error);
            }
        }
        let identity = read_process_identity(pid)?;
        if identity.pid != pid || identity.pgid != pid {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "run supervisor did not become its process-group anchor",
            ));
        }
        Ok(identity)
    }

    fn install_supervisor_signal_policy() -> io::Result<()> {
        for signal in [libc::SIGPIPE, libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
            set_signal_disposition(signal, libc::SIG_IGN)?;
        }
        Ok(())
    }

    fn reset_child_signal_policy() -> io::Result<()> {
        for signal in [libc::SIGPIPE, libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
            set_signal_disposition(signal, libc::SIG_DFL)?;
        }
        Ok(())
    }

    fn set_signal_disposition(signal: libc::c_int, handler: libc::sighandler_t) -> io::Result<()> {
        let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
        action.sa_sigaction = handler;
        if unsafe { libc::sigemptyset(&mut action.sa_mask) } != 0 {
            return Err(io::Error::last_os_error());
        }
        action.sa_flags = 0;
        if unsafe { libc::sigaction(signal, &action, std::ptr::null_mut()) } == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }

    fn set_limits(limits: &LauncherRlimits) -> io::Result<()> {
        set_limit(libc::RLIMIT_CORE, limits.core_bytes)?;
        set_limit(libc::RLIMIT_FSIZE, limits.file_size_bytes)?;
        set_limit(libc::RLIMIT_NOFILE, limits.open_files)?;
        set_limit(libc::RLIMIT_NPROC, limits.nproc_ceiling)?;
        if let Some(address_space) = limits.address_space_bytes {
            set_limit(libc::RLIMIT_AS, address_space)?;
        }
        Ok(())
    }

    fn set_limit(resource: libc::c_int, value: u64) -> io::Result<()> {
        let limit = libc::rlimit {
            rlim_cur: value,
            rlim_max: value,
        };
        if unsafe { libc::setrlimit(resource, &limit) } == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }

    fn duplicate(source: RawFd, destination: RawFd) -> io::Result<()> {
        if unsafe { libc::dup2(source, destination) } == destination {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }

    fn close_ambient_file_descriptors(scan_limit: RawFd, preserved: RawFd) {
        for descriptor in FIRST_AMBIENT_FD..scan_limit {
            if descriptor != preserved {
                unsafe {
                    libc::close(descriptor);
                }
            }
        }
    }

    fn cloexec_pipe() -> io::Result<[RawFd; 2]> {
        let mut descriptors = [-1; 2];
        if unsafe { libc::pipe(descriptors.as_mut_ptr()) } != 0 {
            return Err(io::Error::last_os_error());
        }
        if let Err(error) =
            set_close_on_exec(descriptors[0]).and_then(|_| set_close_on_exec(descriptors[1]))
        {
            close_pipe(descriptors);
            return Err(error);
        }
        Ok(descriptors)
    }

    fn close_pipe(descriptors: [RawFd; 2]) {
        for descriptor in descriptors {
            if descriptor >= 0 {
                unsafe {
                    libc::close(descriptor);
                }
            }
        }
    }

    fn set_close_on_exec(descriptor: RawFd) -> io::Result<()> {
        let flags = unsafe { libc::fcntl(descriptor, libc::F_GETFD) };
        if flags < 0 {
            return Err(io::Error::last_os_error());
        }
        if unsafe { libc::fcntl(descriptor, libc::F_SETFD, flags | libc::FD_CLOEXEC) } == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }

    fn path_cstring(path: &Path, label: &str) -> io::Result<CString> {
        CString::new(path.as_os_str().as_bytes())
            .map_err(|_| invalid(format!("{label} contains a NUL")))
    }

    fn text_cstring(value: &str, label: &str) -> io::Result<CString> {
        CString::new(value).map_err(|_| invalid(format!("{label} contains a NUL")))
    }

    fn verify_descendants_stopped(
        anchor: ProcessIdentity,
        authenticated_channel: &UnixStream,
    ) -> io::Result<()> {
        let liveness = LiveAnchorProtocolLiveness::after_authenticated_handshake(
            anchor,
            authenticated_channel,
        )?;
        verify_live_anchor_descendants_stopped(&anchor, &liveness)?;
        Ok(())
    }

    fn kill_direct_target(target: ProcessIdentity) -> io::Result<()> {
        // This is the supervisor's exact, unreaped direct child, not an inventoried arbitrary
        // descendant. External cleanup has already frozen every untrusted group member.
        match verify_process_identity(&target)? {
            IdentityVerification::Matches => {
                if unsafe { libc::kill(target.pid, libc::SIGKILL) } == 0 {
                    Ok(())
                } else {
                    let error = io::Error::last_os_error();
                    if error.raw_os_error() == Some(libc::ESRCH) {
                        Ok(())
                    } else {
                        Err(error)
                    }
                }
            }
            // An exited unreaped direct child can disappear from live libproc lookup while
            // remaining safely waitable; wait4 below is the ownership proof in that state.
            IdentityVerification::Missing => Ok(()),
            IdentityVerification::Mismatch(actual) => Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!(
                    "direct target identity changed before cleanup: expected {target:?}, observed {actual:?}"
                ),
            )),
        }
    }

    fn wait4_target(pid: i32, options: i32) -> io::Result<Option<WaitOutcome>> {
        loop {
            let mut status = 0_i32;
            let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
            let waited = unsafe { libc::wait4(pid, &mut status, options, &mut usage) };
            if waited == pid {
                return Ok(Some(WaitOutcome {
                    status: ExitStatus::from_raw(status),
                    usage,
                }));
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

    fn pre_reap_exited_direct_target(
        identity: ProcessIdentity,
        reaped: &mut Option<WaitOutcome>,
    ) -> io::Result<()> {
        if reaped.is_none() {
            *reaped = wait4_target(identity.pid, libc::WNOHANG).map_err(|error| {
                io::Error::new(
                    error.kind(),
                    format!("pre-reap exited exact direct target: {error}"),
                )
            })?;
        }
        Ok(())
    }

    fn build_target_result(
        run_id: &str,
        cause: CleanupCause,
        target: SpawnedTarget,
        diagnostic: Option<String>,
        collection_started: Instant,
    ) -> RunResult {
        let outcome = target
            .reaped
            .expect("target result is built only after direct-child wait4");
        let mut reason = reason_for_cleanup(cause);
        if !target.exec_confirmed {
            reason = RunReason::LaunchError;
        }
        let (workspace_bytes, workspace_files) = inspect_workspace(&target.cwd_path);
        let stdout_bytes = file_size(&target.stdout_path);
        let stderr_bytes = file_size(&target.stderr_path);
        let peak_memory = target
            .peak_memory_bytes
            .max(outcome.usage.ru_maxrss.max(0) as u64);
        let diagnostic = diagnostic.or_else(|| cleanup_diagnostic(cause));
        let signal = outcome.status.signal();
        let _workspace_delta = workspace_bytes.saturating_sub(target.baseline_workspace_bytes);
        let _created_delta = workspace_files.saturating_sub(target.baseline_workspace_files);
        let peak_memory_bytes = nonzero(if matches!(reason, RunReason::MemoryLimit) {
            peak_memory.min(target.monitor_limits.memory_bytes)
        } else {
            peak_memory
        });
        RunResult {
            run_id: run_id.into(),
            reason,
            exit_code: outcome.status.code(),
            signal_or_status: signal.map(|value| format!("signal {value}")),
            security_setup_time_us: target.security_setup_time_us,
            wall_time_us: elapsed_us(
                target.started_at,
                target
                    .finished_at
                    .expect("cleanup request records the target finish boundary"),
            ),
            result_collection_time_us: collection_started
                .elapsed()
                .as_micros()
                .min(u64::MAX as u128) as u64,
            user_cpu_time_us: nonzero(timeval_us(outcome.usage.ru_utime))
                .or_else(|| nonzero(target.last_usage.user_time_ns / 1000)),
            kernel_cpu_time_us: nonzero(timeval_us(outcome.usage.ru_stime))
                .or_else(|| nonzero(target.last_usage.system_time_ns / 1000)),
            peak_memory_bytes,
            stdout_bytes,
            stderr_bytes,
            created_files: Some(workspace_files),
            diagnostic,
        }
    }

    fn build_no_target_result(
        run_id: &str,
        cause: CleanupCause,
        prepared: Option<&PreparedLaunch>,
        diagnostic: Option<String>,
        setup_started: Instant,
        collection_started: Instant,
    ) -> RunResult {
        let (stdout_bytes, stderr_bytes, created_files) = prepared
            .map(|prepared| {
                (
                    file_size(&prepared.stdout_path),
                    file_size(&prepared.stderr_path),
                    inspect_workspace(&prepared.cwd_path).1,
                )
            })
            .unwrap_or((0, 0, 0));
        RunResult {
            run_id: run_id.into(),
            reason: reason_for_cleanup(cause),
            exit_code: None,
            signal_or_status: None,
            security_setup_time_us: setup_started.elapsed().as_micros().min(u64::MAX as u128)
                as u64,
            wall_time_us: 0,
            result_collection_time_us: collection_started
                .elapsed()
                .as_micros()
                .min(u64::MAX as u128) as u64,
            user_cpu_time_us: None,
            kernel_cpu_time_us: None,
            peak_memory_bytes: None,
            stdout_bytes,
            stderr_bytes,
            created_files: Some(created_files),
            diagnostic: diagnostic.or_else(|| cleanup_diagnostic(cause)),
        }
    }

    fn classify_live_target(target: &SpawnedTarget) -> (Option<CleanupCause>, Option<String>) {
        let limits = &target.monitor_limits;
        if target.started_at.elapsed() >= Duration::from_millis(limits.wall_time_ms) {
            (Some(CleanupCause::WallTimeLimit), None)
        } else if target.peak_memory_bytes > limits.memory_bytes {
            (Some(CleanupCause::MemoryLimit), None)
        } else if target.last_usage.processes > limits.process_count {
            (Some(CleanupCause::ProcessLimit), None)
        } else if target.last_usage.threads > limits.thread_count {
            (Some(CleanupCause::ThreadLimit), None)
        } else if redirected_output_bytes(target) > limits.output_bytes {
            (Some(CleanupCause::OutputLimit), None)
        } else {
            let (workspace_bytes, workspace_files) = inspect_workspace(&target.cwd_path);
            if workspace_bytes.saturating_sub(target.baseline_workspace_bytes)
                > limits.total_write_bytes
            {
                (Some(CleanupCause::WriteLimit), None)
            } else if workspace_files.saturating_sub(target.baseline_workspace_files)
                > limits.created_files
            {
                (
                    Some(CleanupCause::WriteLimit),
                    Some("created-file limit exceeded".into()),
                )
            } else {
                (None, None)
            }
        }
    }

    fn classify_exited_target(target: &SpawnedTarget) -> (Option<CleanupCause>, Option<String>) {
        let limits = &target.monitor_limits;
        let outcome = target
            .reaped
            .as_ref()
            .expect("exited-target classification requires wait4 ownership");
        let output_bytes = redirected_output_bytes(target);
        let (workspace_bytes, workspace_files) = inspect_workspace(&target.cwd_path);
        let created_delta = workspace_files.saturating_sub(target.baseline_workspace_files);
        let write_delta = workspace_bytes.saturating_sub(target.baseline_workspace_bytes);
        let exited_leader_processes = target.last_usage.processes.saturating_add(1);
        let exited_leader_threads = target.last_usage.threads.saturating_add(1);

        if target
            .peak_memory_bytes
            .max(outcome.usage.ru_maxrss.max(0) as u64)
            > limits.memory_bytes
        {
            (Some(CleanupCause::MemoryLimit), None)
        } else if exited_leader_processes > limits.process_count {
            (Some(CleanupCause::ProcessLimit), None)
        } else if exited_leader_threads > limits.thread_count {
            (Some(CleanupCause::ThreadLimit), None)
        } else if output_bytes > limits.output_bytes
            || (outcome.status.signal() == Some(libc::SIGXFSZ)
                && output_bytes >= limits.output_bytes)
        {
            (Some(CleanupCause::OutputLimit), None)
        } else if outcome.status.signal() == Some(libc::SIGXFSZ)
            || write_delta > limits.total_write_bytes
        {
            (Some(CleanupCause::WriteLimit), None)
        } else if created_delta > limits.created_files {
            (
                Some(CleanupCause::WriteLimit),
                Some("created-file limit exceeded".into()),
            )
        } else {
            (Some(CleanupCause::TargetExited), None)
        }
    }

    fn redirected_output_bytes(target: &SpawnedTarget) -> u64 {
        file_size(&target.stdout_path).saturating_add(file_size(&target.stderr_path))
    }

    fn reason_for_cleanup(cause: CleanupCause) -> RunReason {
        match cause {
            CleanupCause::Cancelled | CleanupCause::Shutdown => RunReason::Cancelled,
            CleanupCause::WallTimeLimit => RunReason::WallTimeLimit,
            CleanupCause::MemoryLimit => RunReason::MemoryLimit,
            CleanupCause::ProcessLimit => RunReason::ProcessLimit,
            CleanupCause::ThreadLimit => RunReason::ThreadLimit,
            CleanupCause::OutputLimit => RunReason::OutputLimit,
            CleanupCause::WriteLimit => RunReason::WriteLimit,
            CleanupCause::SandboxDenied => RunReason::SandboxDenied,
            CleanupCause::TargetExited => RunReason::Exited,
            CleanupCause::LaunchFailed => RunReason::LaunchError,
            CleanupCause::ExecutorDisconnected
            | CleanupCause::GuardianDisconnected
            | CleanupCause::ProtocolViolation
            | CleanupCause::InternalError => RunReason::InternalError,
        }
    }

    fn cleanup_diagnostic(cause: CleanupCause) -> Option<String> {
        match cause {
            CleanupCause::ExecutorDisconnected => {
                Some("executor disconnected while the run supervisor was active".into())
            }
            CleanupCause::GuardianDisconnected => {
                Some("guardian disconnected while the run supervisor was active".into())
            }
            CleanupCause::ProtocolViolation => {
                Some("run supervisor control protocol was violated".into())
            }
            CleanupCause::InternalError => Some("run supervisor failed closed".into()),
            CleanupCause::LaunchFailed => Some("target launch did not complete".into()),
            _ => None,
        }
    }

    fn nonzero(value: u64) -> Option<u64> {
        (value > 0).then_some(value)
    }

    fn elapsed_us(started_at: Instant, finished_at: Instant) -> u64 {
        finished_at
            .checked_duration_since(started_at)
            .unwrap_or_default()
            .as_micros()
            .min(u64::MAX as u128) as u64
    }

    fn timeval_us(value: libc::timeval) -> u64 {
        (value.tv_sec.max(0) as u64)
            .saturating_mul(1_000_000)
            .saturating_add(value.tv_usec.max(0) as u64)
    }

    fn observe_group_usage(anchor: ProcessIdentity) -> io::Result<GroupUsage> {
        let snapshot = inventory_live_process_group(anchor.pgid)?;
        let observed_anchor = snapshot
            .members
            .iter()
            .find(|member| member.pid == anchor.pid)
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "live supervisor anchor is missing from its process-group inventory",
                )
            })?;
        authenticate_process_identity(observed_anchor, &anchor)?;
        let zombie_count = snapshot.zombie_pids.len().min(u32::MAX as usize) as u32;
        let mut usage = GroupUsage {
            processes: zombie_count,
            threads: zombie_count,
            ..GroupUsage::default()
        };
        for member in snapshot
            .members
            .iter()
            .filter(|member| member.pid != anchor.pid)
        {
            usage.processes = usage.processes.saturating_add(1);
            let Some(process) = process_usage(member)? else {
                // A short-lived member may exit after the authenticated group inventory but
                // before libproc samples it. Only an exact ESRCH followed by an identity-aware
                // Missing result reaches this branch; live-but-unmeasurable and PID-reuse cases
                // remain fail-closed.
                usage.threads = usage.threads.saturating_add(1);
                continue;
            };
            usage.memory_bytes = usage.memory_bytes.saturating_add(process.memory_bytes);
            usage.user_time_ns = usage.user_time_ns.saturating_add(process.user_time_ns);
            usage.system_time_ns = usage.system_time_ns.saturating_add(process.system_time_ns);
            usage.threads = usage.threads.saturating_add(process.threads);
        }
        Ok(usage)
    }

    #[repr(C)]
    #[derive(Default)]
    struct RusageInfoV2 {
        uuid: [u8; 16],
        user_time: u64,
        system_time: u64,
        pkg_idle_wkups: u64,
        interrupt_wkups: u64,
        pageins: u64,
        wired_size: u64,
        resident_size: u64,
        phys_footprint: u64,
        proc_start_abstime: u64,
        proc_exit_abstime: u64,
        child_user_time: u64,
        child_system_time: u64,
        child_pkg_idle_wkups: u64,
        child_interrupt_wkups: u64,
        child_pageins: u64,
        child_elapsed_abstime: u64,
    }

    #[repr(C)]
    #[derive(Default)]
    struct ProcTaskInfo {
        virtual_size: u64,
        resident_size: u64,
        total_user: u64,
        total_system: u64,
        threads_user: u64,
        threads_system: u64,
        policy: i32,
        faults: i32,
        pageins: i32,
        cow_faults: i32,
        messages_sent: i32,
        messages_received: i32,
        syscalls_mach: i32,
        syscalls_unix: i32,
        context_switches: i32,
        thread_count: i32,
        running_threads: i32,
        priority: i32,
    }

    #[derive(Debug, Default)]
    struct ProcessUsage {
        memory_bytes: u64,
        user_time_ns: u64,
        system_time_ns: u64,
        threads: u32,
    }

    #[link(name = "proc")]
    extern "C" {
        fn proc_pid_rusage(pid: i32, flavor: i32, buffer: *mut RusageInfoV2) -> i32;
        fn proc_pidinfo(
            pid: i32,
            flavor: i32,
            arg: u64,
            buffer: *mut libc::c_void,
            size: i32,
        ) -> i32;
    }

    fn process_usage(expected: &ProcessIdentity) -> io::Result<Option<ProcessUsage>> {
        const RUSAGE_INFO_V2: i32 = 2;
        const PROC_PIDTASKINFO: i32 = 4;
        let mut info = RusageInfoV2::default();
        if unsafe { proc_pid_rusage(expected.pid, RUSAGE_INFO_V2, &mut info) } != 0 {
            return process_usage_error(expected, "proc_pid_rusage", io::Error::last_os_error());
        }
        let mut task = ProcTaskInfo::default();
        let task_size = std::mem::size_of::<ProcTaskInfo>() as i32;
        let returned = unsafe {
            proc_pidinfo(
                expected.pid,
                PROC_PIDTASKINFO,
                0,
                (&mut task as *mut ProcTaskInfo).cast(),
                task_size,
            )
        };
        if returned != task_size {
            let error = if returned <= 0 {
                io::Error::last_os_error()
            } else {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("proc_pidinfo returned {returned} bytes; expected exactly {task_size}"),
                )
            };
            return process_usage_error(expected, "proc_pidinfo", error);
        }
        match verify_process_identity(expected)? {
            IdentityVerification::Matches => Ok(Some(ProcessUsage {
                memory_bytes: info
                    .phys_footprint
                    .max(info.resident_size)
                    .max(task.resident_size),
                user_time_ns: info.user_time,
                system_time_ns: info.system_time,
                threads: task.thread_count.max(1) as u32,
            })),
            IdentityVerification::Missing => Ok(None),
            IdentityVerification::Mismatch(actual) => Err(process_usage_identity_mismatch(
                expected,
                &actual,
                "after libproc sampling",
            )),
        }
    }

    fn process_usage_error(
        expected: &ProcessIdentity,
        operation: &str,
        error: io::Error,
    ) -> io::Result<Option<ProcessUsage>> {
        if error.raw_os_error() != Some(libc::ESRCH) {
            return Err(io::Error::new(
                error.kind(),
                format!("{operation} failed for authenticated process {expected:?}: {error}"),
            ));
        }
        match verify_process_identity(expected)? {
            IdentityVerification::Missing => Ok(None),
            IdentityVerification::Matches => Err(io::Error::new(
                error.kind(),
                format!(
                    "{operation} reported ESRCH while authenticated process {expected:?} is still live"
                ),
            )),
            IdentityVerification::Mismatch(actual) => Err(process_usage_identity_mismatch(
                expected, &actual, operation,
            )),
        }
    }

    fn process_usage_identity_mismatch(
        expected: &ProcessIdentity,
        actual: &ProcessIdentity,
        operation: &str,
    ) -> io::Error {
        io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "process identity changed {operation}: expected {expected:?}, observed {actual:?}"
            ),
        )
    }

    fn hold_generation_guard_forever() -> ! {
        loop {
            unsafe {
                libc::pause();
            }
        }
    }

    fn invalid(message: impl Into<String>) -> io::Error {
        io::Error::new(io::ErrorKind::InvalidInput, message.into())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::collections::BTreeMap;
        use std::fs;
        use std::sync::atomic::{AtomicU64, Ordering};

        static NEXT_TEST_DIRECTORY: AtomicU64 = AtomicU64::new(0);

        struct TestDirectory(PathBuf);

        impl TestDirectory {
            fn new(label: &str) -> Self {
                let suffix = NEXT_TEST_DIRECTORY.fetch_add(1, Ordering::Relaxed);
                let path = std::env::temp_dir().join(format!(
                    "judgedesk-supervisor-{label}-{}-{suffix}",
                    std::process::id()
                ));
                fs::create_dir(&path).expect("create supervisor test directory");
                Self(path)
            }
        }

        impl Drop for TestDirectory {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }

        #[test]
        fn guardian_parent_must_match_exactly() {
            validate_guardian_parent(41, 41).expect("matching guardian parent");
            assert_eq!(
                validate_guardian_parent(41, 42)
                    .expect_err("mismatched guardian must fail")
                    .kind(),
                io::ErrorKind::PermissionDenied
            );
            assert!(validate_guardian_parent(1, 1).is_err());
        }

        #[test]
        fn supervisor_rechecks_loader_and_internal_environment_keys() {
            for key in [
                "DYLD_INSERT_LIBRARIES",
                "dyld_print_to_file",
                "LD_PRELOAD",
                "MallocStackLogging",
                "JUDGEDESK_RUN_SUPERVISOR_DIRECT_FD",
                "judgedesk_tree_guard_path",
            ] {
                let values = BTreeMap::from([(key.to_string(), "attacker-controlled".to_string())]);
                assert!(
                    validate_target_environment_again(&values).is_err(),
                    "accepted reserved key {key}"
                );
            }
        }

        #[test]
        fn exact_commit_and_go_are_both_required_before_fork() {
            let anchor = ProcessIdentity {
                pid: 41,
                pgid: 41,
                start_abstime: 99,
            };
            let target = ProcessIdentity {
                pid: 42,
                pgid: 41,
                start_abstime: 100,
            };
            let mut state = SupervisorLaunchState::default();
            state.record_registered(anchor).unwrap();
            state.record_ready(anchor).unwrap();
            state.record_direct_commit(anchor).unwrap();
            assert!(!state.may_fork_target());
            state.record_guardian_go(anchor).unwrap();
            assert!(state.may_fork_target());
            state.record_target_started(target).unwrap();
            assert!(!state.may_fork_target());
        }

        #[test]
        fn exact_dev_null_is_accepted_as_trusted_empty_stdin() {
            let input = open_regular_input(Path::new("/dev/null"))
                .expect("open exact /dev/null as empty stdin");
            assert!(input
                .metadata()
                .expect("inspect /dev/null")
                .file_type()
                .is_char_device());
        }

        #[test]
        fn control_stream_descriptor_is_close_on_exec() {
            let (stream, _peer) = UnixStream::pair().expect("socket pair");
            set_close_on_exec(stream.as_raw_fd()).expect("set CLOEXEC");
            let flags = unsafe { libc::fcntl(stream.as_raw_fd(), libc::F_GETFD) };
            assert!(flags >= 0);
            assert_ne!(flags & libc::FD_CLOEXEC, 0);
        }

        #[test]
        fn prepared_reaches_the_direct_executor_before_the_guardian_kill_authority() {
            assert_eq!(
                PREPARED_BROADCAST_ORDER,
                [Controller::Direct, Controller::Guardian]
            );
        }

        #[test]
        fn exec_status_pipe_is_close_on_exec() {
            let descriptors = cloexec_pipe().expect("CLOEXEC pipe");
            for descriptor in descriptors {
                let flags = unsafe { libc::fcntl(descriptor, libc::F_GETFD) };
                assert!(flags >= 0);
                assert_ne!(flags & libc::FD_CLOEXEC, 0);
                unsafe {
                    libc::close(descriptor);
                }
            }
        }

        #[test]
        fn cleanup_reason_mapping_is_explicit() {
            assert!(matches!(
                reason_for_cleanup(CleanupCause::TargetExited),
                RunReason::Exited
            ));
            assert!(matches!(
                reason_for_cleanup(CleanupCause::LaunchFailed),
                RunReason::LaunchError
            ));
            assert!(matches!(
                reason_for_cleanup(CleanupCause::GuardianDisconnected),
                RunReason::InternalError
            ));
        }

        #[test]
        fn reported_wall_time_uses_the_terminal_snapshot() {
            let started_at = Instant::now();
            let finished_at = started_at + Duration::from_millis(7);
            assert_eq!(elapsed_us(started_at, finished_at), 7_000);
            assert_eq!(elapsed_us(finished_at, started_at), 0);
        }

        #[test]
        fn sandbox_exec_target_remains_a_waitable_direct_child() {
            let directory = TestDirectory::new("sandbox-direct-child");
            let prepared = prepared_test_launch(&directory);
            run_anchor_harness(&prepared, HarnessExpectation::ExecSuccess);
        }

        #[test]
        fn cleanup_pre_reaps_an_exited_exact_direct_child() {
            let mut child = std::process::Command::new("/bin/sleep")
                .arg("10")
                .spawn()
                .expect("spawn exact direct child");
            let identity =
                read_process_identity(child.id() as i32).expect("read direct child identity");
            assert_eq!(unsafe { libc::kill(identity.pid, libc::SIGKILL) }, 0);

            let deadline = Instant::now() + Duration::from_secs(1);
            let mut reaped = None;
            while reaped.is_none() && Instant::now() < deadline {
                pre_reap_exited_direct_target(identity, &mut reaped)
                    .expect("pre-reap exact direct child");
                if reaped.is_none() {
                    std::thread::sleep(Duration::from_millis(2));
                }
            }

            let outcome = reaped.expect("exact killed child remained unreaped");
            assert_eq!(outcome.status.signal(), Some(libc::SIGKILL));
            assert_eq!(
                child
                    .wait()
                    .expect_err("raw wait4 must own the exact child reap")
                    .raw_os_error(),
                Some(libc::ECHILD)
            );
        }

        #[test]
        fn target_exec_has_expected_group_environment_and_no_ambient_fd() {
            let directory = TestDirectory::new("exec-boundaries");
            let mut prepared = prepared_test_launch(&directory);
            prepared.sandbox_executable = CString::new("/bin/sh").unwrap();
            prepared.arguments = vec![
                CString::new("/bin/sh").unwrap(),
                CString::new("-c").unwrap(),
                CString::new(
                    r#"printf 'PID=%s\n' "$$"; printf 'PGID=%s\n' "$(/bin/ps -o pgid= -p "$$" | /usr/bin/tr -d ' ')"; /usr/bin/env; if [ -e /dev/fd/99 ]; then echo FD99=leaked; else echo FD99=closed; fi"#,
                )
                .unwrap(),
            ];
            prepared.environment = vec![CString::new("JUDGEDESK_TEST_VISIBLE=1").unwrap()];

            let anchor_pid = run_anchor_harness(&prepared, HarnessExpectation::ExecSuccess);
            let output =
                fs::read_to_string(directory.0.join("stdout.txt")).expect("read target stdout");
            assert!(output.contains("JUDGEDESK_TEST_VISIBLE=1"));
            assert!(output.contains("FD99=closed"), "{output}");
            assert!(!output.contains("FD99=leaked"), "{output}");
            assert!(
                output.contains(&format!("PGID={anchor_pid}\n")),
                "target did not inherit supervisor PGID {anchor_pid}: {output}"
            );
            assert!(
                !output.contains("JUDGEDESK_RUN_SUPERVISOR_TOKEN="),
                "internal supervisor environment leaked: {output}"
            );
        }

        #[test]
        fn exec_failure_uses_status_pipe_and_never_contaminates_target_stdout() {
            let directory = TestDirectory::new("exec-failure");
            let mut prepared = prepared_test_launch(&directory);
            prepared.sandbox_executable =
                CString::new("/definitely/missing/judgedesk-sandbox-exec").unwrap();
            prepared.arguments =
                vec![CString::new("/definitely/missing/judgedesk-sandbox-exec").unwrap()];
            prepared.environment.clear();

            run_anchor_harness(&prepared, HarnessExpectation::ExecFailure);
            assert_eq!(
                fs::metadata(directory.0.join("stdout.txt"))
                    .expect("stat target stdout")
                    .len(),
                0,
                "trusted child setup failure was written to contestant stdout"
            );
        }

        #[derive(Clone, Copy)]
        enum HarnessExpectation {
            ExecSuccess,
            ExecFailure,
        }

        fn prepared_test_launch(directory: &TestDirectory) -> PreparedLaunch {
            let stdin = directory.0.join("stdin.txt");
            let stdout = directory.0.join("stdout.txt");
            let stderr = directory.0.join("stderr.txt");
            let profile = directory.0.join("profile.sb");
            fs::write(&stdin, b"").expect("write stdin");
            fs::write(&profile, b"(version 1)\n(allow default)\n").expect("write profile");
            let mut limit: libc::rlimit = unsafe { std::mem::zeroed() };
            assert_eq!(
                unsafe { libc::getrlimit(libc::RLIMIT_NPROC, &mut limit) },
                0
            );
            PreparedLaunch::new(LauncherSpec {
                sandbox_executable: PathBuf::from(SANDBOX_EXECUTABLE),
                sandbox_profile: profile,
                target_executable: PathBuf::from("/usr/bin/true"),
                arguments: Vec::new(),
                cwd: directory.0.clone(),
                stdin,
                stdout,
                stderr,
                environment: BTreeMap::new(),
                monitor_limits: LauncherMonitorLimits {
                    wall_time_ms: 10_000,
                    memory_bytes: 256 * 1024 * 1024,
                    process_count: 16,
                    thread_count: 64,
                    output_bytes: 1024 * 1024,
                    total_write_bytes: 2 * 1024 * 1024,
                    created_files: 64,
                },
                limits: LauncherRlimits {
                    core_bytes: 0,
                    file_size_bytes: 1024 * 1024,
                    open_files: 256,
                    nproc_ceiling: limit.rlim_max,
                    address_space_bytes: None,
                },
            })
            .expect("prepare test launch")
        }

        fn run_anchor_harness(prepared: &PreparedLaunch, expectation: HarnessExpectation) -> i32 {
            let harness = unsafe { libc::fork() };
            assert!(
                harness >= 0,
                "fork supervisor harness: {}",
                io::Error::last_os_error()
            );
            if harness == 0 {
                if unsafe { libc::setpgid(0, 0) } != 0 {
                    unsafe { libc::_exit(101) };
                }
                let anchor = match read_process_identity(unsafe { libc::getpid() }) {
                    Ok(anchor) => anchor,
                    Err(_) => unsafe { libc::_exit(102) },
                };
                let sentinel = match File::open(prepared.cwd_path.join("stdin.txt")) {
                    Ok(file) => file,
                    Err(_) => unsafe { libc::_exit(103) },
                };
                if unsafe { libc::dup2(sentinel.as_raw_fd(), 99) } != 99 {
                    unsafe { libc::_exit(104) };
                }
                let target = match prepared.spawn(anchor, 0) {
                    Ok(target) => target,
                    Err(_) => unsafe { libc::_exit(105) },
                };
                let expectation_met = match expectation {
                    HarnessExpectation::ExecSuccess => {
                        target.exec_confirmed && target.setup_failure.is_none()
                    }
                    HarnessExpectation::ExecFailure => {
                        !target.exec_confirmed
                            && target.setup_failure.is_some_and(|failure| {
                                failure.stage == ChildSetupStage::Exec as u32
                                    && failure.errno == libc::ENOENT
                            })
                    }
                };
                if !expectation_met
                    || target.identity.pgid != anchor.pgid
                    || target.identity.pid == anchor.pid
                {
                    unsafe { libc::_exit(106) };
                }
                match wait4_target(target.identity.pid, 0) {
                    Ok(Some(_)) => unsafe { libc::_exit(0) },
                    _ => unsafe { libc::_exit(107) },
                }
            }

            let mut status = 0_i32;
            assert_eq!(unsafe { libc::waitpid(harness, &mut status, 0) }, harness);
            let status = ExitStatus::from_raw(status);
            assert!(
                status.success(),
                "supervisor harness failed with {status:?}"
            );
            harness
        }
    }
}

#[cfg(target_os = "macos")]
pub use macos::try_run_internal_mode;

#[cfg(not(target_os = "macos"))]
pub fn try_run_internal_mode() -> Option<i32> {
    None
}
