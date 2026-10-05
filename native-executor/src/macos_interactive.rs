//! Pair admission and trusted relay accounting for macOS interactive runs.

use crate::guardian_protocol::CleanupCause;
use std::io;
use std::sync::Mutex;

#[derive(Default)]
struct PairState {
    ready: [bool; 2],
    cleanup: [Option<CleanupCause>; 2],
    user_cancelled: bool,
    stdout_bytes: [u64; 2],
    enrollment_pause: Option<std::time::Duration>,
    pause_until: Option<std::time::Instant>,
}

#[derive(Default)]
pub(crate) struct PairControl {
    state: Mutex<PairState>,
}

impl PairControl {
    #[cfg(any(target_os = "macos", test))]
    fn with_enrollment_pause(pause: Option<std::time::Duration>) -> Self {
        Self {
            state: Mutex::new(PairState {
                enrollment_pause: pause,
                ..PairState::default()
            }),
        }
    }
    pub(crate) fn mark_ready(&self, side: usize) -> io::Result<bool> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if side >= 2 || state.ready[side] || state.cleanup.iter().any(Option::is_some) {
            return Err(io::Error::other(
                "interactive participant cannot become ready",
            ));
        }
        state.ready[side] = true;
        if state.ready.iter().all(|ready| *ready) {
            state.pause_until = state
                .enrollment_pause
                .map(|pause| std::time::Instant::now() + pause);
        }
        Ok(state.ready.iter().all(|ready| *ready))
    }

    pub(crate) fn may_release(&self) -> bool {
        let state = self
            .state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        state.ready.iter().all(|ready| *ready)
            && state.cleanup.iter().all(Option::is_none)
            && state
                .pause_until
                .is_none_or(|until| std::time::Instant::now() >= until)
    }

    pub(crate) fn abort(&self, side: usize, cause: CleanupCause) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if side < 2 {
            state.cleanup[side].get_or_insert(cause);
            state.cleanup[1 - side].get_or_insert(CleanupCause::Cancelled);
        } else {
            state.cleanup.iter_mut().for_each(|value| {
                value.get_or_insert(CleanupCause::InternalError);
            });
        }
    }

    pub(crate) fn cancel(&self) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        state.user_cancelled = true;
        state.cleanup.iter_mut().for_each(|value| {
            value.get_or_insert(CleanupCause::Cancelled);
        });
    }

    pub(crate) fn user_cancelled(&self) -> bool {
        self.state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .user_cancelled
    }

    pub(crate) fn record_stdout(&self, side: usize, bytes: u64) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if let Some(counter) = state.stdout_bytes.get_mut(side) {
            *counter = (*counter).max(bytes);
        }
    }

    pub(crate) fn stdout_bytes(&self, side: usize) -> u64 {
        self.state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .stdout_bytes
            .get(side)
            .copied()
            .unwrap_or(0)
    }

    pub(crate) fn cleanup_cause(&self, side: usize) -> Option<CleanupCause> {
        let state = self
            .state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        state.cleanup.get(side).copied().flatten()
    }
}

impl crate::platform::Cancellation for PairControl {
    fn cancel(&self) {
        PairControl::cancel(self);
    }
}

pub(crate) struct RelayBuffer {
    bytes: Vec<u8>,
    capacity: usize,
    quota: u64,
    total_read: u64,
}

impl RelayBuffer {
    pub(crate) fn new(capacity: usize, quota: u64) -> Self {
        Self {
            bytes: Vec::with_capacity(capacity),
            capacity,
            quota,
            total_read: 0,
        }
    }

    pub(crate) fn available(&self) -> usize {
        self.capacity - self.bytes.len()
    }
    pub(crate) fn pending(&self) -> &[u8] {
        &self.bytes
    }
    pub(crate) fn total_read(&self) -> u64 {
        self.total_read
    }

    pub(crate) fn push(&mut self, bytes: &[u8]) -> io::Result<()> {
        if bytes.len() > self.available() {
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "interactive relay buffer is full",
            ));
        }
        self.total_read = self
            .total_read
            .checked_add(bytes.len() as u64)
            .ok_or_else(|| io::Error::other("interactive output counter overflow"))?;
        if self.total_read > self.quota {
            return Err(io::Error::other("interactive output quota exceeded"));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(())
    }

    pub(crate) fn consume(&mut self, count: usize) -> io::Result<()> {
        if count > self.bytes.len() {
            return Err(io::Error::other("invalid interactive relay write count"));
        }
        self.bytes.drain(..count);
        Ok(())
    }
}

fn interaction_verdict(
    submission: &crate::protocol::RunReason,
    submission_exit: Option<i32>,
    interactor: &crate::protocol::RunReason,
    interactor_exit: Option<i32>,
    user_cancelled: bool,
) -> (&'static str, Option<f64>) {
    use crate::protocol::RunReason;
    if user_cancelled {
        return ("CANCELLED", Some(0.0));
    }
    match submission {
        RunReason::MemoryLimit => return ("MLE", Some(0.0)),
        RunReason::WallTimeLimit => return ("TLE", Some(0.0)),
        RunReason::OutputLimit | RunReason::WriteLimit => return ("OLE", Some(0.0)),
        RunReason::ProcessLimit | RunReason::ThreadLimit => return ("RTE", Some(0.0)),
        RunReason::SandboxDenied | RunReason::LaunchError | RunReason::InternalError => {
            return ("JE", Some(0.0))
        }
        _ => {}
    }
    if !matches!(interactor, RunReason::Exited) {
        return ("JE", Some(0.0));
    }
    match interactor_exit {
        Some(0) => ("AC", Some(1.0)),
        Some(1) => ("WA", Some(0.0)),
        Some(2) => ("PE", Some(0.0)),
        Some(3) => ("JE", Some(0.0)),
        Some(7) => ("PARTIAL", None),
        Some(code) if code >= 16 => (
            "PARTIAL",
            Some(((code - 16) as f64 / 100.0).clamp(0.0, 1.0)),
        ),
        _ if submission_exit.is_some_and(|code| code != 0) => ("RTE", Some(0.0)),
        _ => ("JE", Some(0.0)),
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use super::{interaction_verdict, PairControl, RelayBuffer};
    use crate::guardian_protocol::CleanupCause;
    use crate::macos_run_controller::{run_with_guardian_paired, PairedRun};
    use crate::macos_stdio::PipePair;
    use crate::platform::{ActiveRuns, Cancellation};
    use crate::protocol::{
        InteractiveRunResult, InteractiveRunSpec, RunReason, RunResult, RunSpec,
    };
    use crate::request_validation::{validate_interactive_pair, validate_run};
    use std::fs::{File, OpenOptions};
    use std::io::{self, Read, Write};
    use std::os::unix::fs::OpenOptionsExt;
    use std::path::Path;
    use std::sync::{mpsc, Arc};
    use std::time::{Duration, Instant};

    struct Relay {
        reader: Option<File>,
        writer: Option<File>,
        log: File,
        buffer: RelayBuffer,
        error: Option<RunReason>,
    }

    #[derive(Default)]
    struct SpoolPaths(Vec<(std::path::PathBuf, u64, u64)>);

    impl SpoolPaths {
        fn cleanup(&mut self) -> io::Result<()> {
            use std::os::unix::fs::MetadataExt;
            let mut failure = None;
            for (path, device, inode) in &self.0 {
                let result = match std::fs::symlink_metadata(path) {
                    Ok(metadata)
                        if metadata.is_file()
                            && metadata.dev() == *device
                            && metadata.ino() == *inode =>
                    {
                        std::fs::remove_file(path)
                    }
                    Ok(_) => Err(io::Error::other("interactive spool ownership changed")),
                    Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
                    Err(error) => Err(error),
                };
                if let Err(error) = result {
                    failure.get_or_insert(error);
                }
            }
            if let Some(error) = failure {
                Err(error)
            } else {
                self.0.clear();
                Ok(())
            }
        }
    }

    impl Drop for SpoolPaths {
        fn drop(&mut self) {
            if let Err(error) = self.cleanup() {
                eprintln!("interactive spool cleanup failed: {error}");
            }
        }
    }

    impl Relay {
        fn advance(&mut self) -> io::Result<()> {
            if let Some(reader) = &mut self.reader {
                let mut bytes = [0_u8; 8192];
                let available = bytes.len().min(self.buffer.available());
                if available > 0 {
                    match reader.read(&mut bytes[..available]) {
                        Ok(0) => self.reader = None,
                        Ok(count) => {
                            self.buffer.push(&bytes[..count])?;
                            // Mirror only bytes accepted by the bounded output counter. The
                            // existing supervisor sees stdout/stderr and workspace write totals.
                            self.log.write_all(&bytes[..count])?;
                        }
                        Err(error)
                            if matches!(
                                error.kind(),
                                io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                            ) => {}
                        Err(error) => return Err(error),
                    }
                }
            }
            if let Some(writer) = &mut self.writer {
                if !self.buffer.pending().is_empty() {
                    match writer.write(self.buffer.pending()) {
                        Ok(0) => {
                            return Err(io::Error::new(
                                io::ErrorKind::WriteZero,
                                "interactive pipe write made no progress",
                            ))
                        }
                        Ok(count) => self.buffer.consume(count)?,
                        Err(error)
                            if matches!(
                                error.kind(),
                                io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                            ) => {}
                        Err(error) if error.kind() == io::ErrorKind::BrokenPipe => {
                            self.writer = None;
                            self.buffer.consume(self.buffer.pending().len())?;
                        }
                        Err(error) => return Err(error),
                    }
                }
            } else {
                // A closed peer still counts every emitted byte, but no longer holds
                // unread relay capacity that could suppress output-limit detection.
                self.buffer.consume(self.buffer.pending().len())?;
            }
            if self.reader.is_none() && self.buffer.pending().is_empty() {
                self.writer = None;
            }
            Ok(())
        }
    }

    fn output_log(path: &Path) -> io::Result<File> {
        let file = OpenOptions::new()
            .write(true)
            .create(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
            .open(path)?;
        use std::os::unix::fs::MetadataExt;
        let metadata = file.metadata()?;
        if !metadata.is_file()
            || metadata.nlink() != 1
            || metadata.uid() != unsafe { libc::getuid() }
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "interactive output must be an owned regular file",
            ));
        }
        file.set_len(0)?;
        Ok(file)
    }

    pub(crate) fn run(
        root: &Path,
        spec: &InteractiveRunSpec,
        active: &ActiveRuns,
    ) -> InteractiveRunResult {
        match run_inner(root, spec, active) {
            Ok(result) => result,
            Err(error) => crate::platform::interactive_failure(spec, error),
        }
    }

    fn run_inner(
        root: &Path,
        spec: &InteractiveRunSpec,
        active: &ActiveRuns,
    ) -> Result<InteractiveRunResult, String> {
        let submission = validate_run(root, &spec.submission)?;
        let interactor = validate_run(root, &spec.interactor)?;
        validate_interactive_pair(spec, &submission, &interactor)?;
        let generation = std::env::var(crate::tree_guard::GENERATION_ENV)
            .map_err(|_| "interactive generation is missing".to_string())?;
        let trace = crate::fault_trace::FaultTrace::from_environment(&generation)?;
        let pause = crate::fault_trace::InteractiveFaultPause::from_environment(trace.is_some())?;
        let sub = PipePair::new().map_err(|error| error.to_string())?;
        let inter = PipePair::new().map_err(|error| error.to_string())?;
        // Output remains in trusted storage while either target is alive. Target-owned
        // workspace names cannot erase the native counter or duplicate its write charge.
        let profiles = crate::platform::macos::trusted_profile_directory(root)?;
        let nonce =
            crate::guardian_protocol::generate_nonce().map_err(|error| error.to_string())?;
        let mut spool_paths = SpoolPaths::default();
        let mut spool = |id: &str| -> Result<File, String> {
            let path = profiles.join(format!("{id}-{nonce}.interactive"));
            let file = OpenOptions::new()
                .read(true)
                .write(true)
                .create_new(true)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .open(&path)
                .map_err(|error| error.to_string())?;
            use std::os::unix::fs::MetadataExt;
            let metadata = file.metadata().map_err(|error| error.to_string())?;
            spool_paths.0.push((path, metadata.dev(), metadata.ino()));
            if spool_paths.0.len() == 1
                && pause == Some(crate::fault_trace::InteractiveFaultPause::FirstSpool)
            {
                if let Some(trace) = &trace {
                    trace.emit(
                        crate::fault_trace::FaultTraceEvent::InteractiveSpoolCreated,
                        &spec.run_id,
                        None,
                        None,
                        None,
                    )?;
                }
                std::thread::sleep(Duration::from_secs(2));
            }
            Ok(file)
        };
        let mut relays = [
            Relay {
                reader: Some(sub.output),
                writer: Some(inter.input),
                log: spool(&spec.submission.run_id)?,
                buffer: RelayBuffer::new(64 * 1024, spec.submission.limits.output_bytes),
                error: None,
            },
            Relay {
                reader: Some(inter.output),
                writer: Some(sub.input),
                log: spool(&spec.interactor.run_id)?,
                buffer: RelayBuffer::new(64 * 1024, spec.interactor.limits.output_bytes),
                error: None,
            },
        ];
        // Keep the captures through their open descriptors. Remove their private
        // names before any participant starts so executor death cannot strand a
        // named capture after containment has been enrolled.
        spool_paths.cleanup().map_err(|error| error.to_string())?;
        let paths = [&submission, &interactor];
        for path in paths {
            output_log(&path.stdout).map_err(|error| error.to_string())?;
        }
        let baselines = paths.map(|path| {
            crate::workspace::inspect_workspace(&path.workspace)
                .0
                .saturating_sub(crate::workspace::file_size(&path.stderr))
        });
        let pair = Arc::new(PairControl::with_enrollment_pause(
            (pause == Some(crate::fault_trace::InteractiveFaultPause::PairCommit))
                .then_some(Duration::from_secs(2)),
        ));
        let handle: Arc<dyn Cancellation> = pair.clone();
        {
            let mut runs = active.lock().unwrap_or_else(|poison| poison.into_inner());
            if runs.contains_key(&spec.run_id) {
                return Err("duplicate interactive active runId".into());
            }
            runs.insert(spec.run_id.clone(), handle.clone());
        }
        // Scope retains the outer record and pipes until both controllers have supplied
        // authenticated terminal containment proof. An uncertain controller retains it.
        let (sender, receiver) = mpsc::channel();
        let mut results: [Option<Result<RunResult, String>>; 2] = [None, None];
        std::thread::scope(|scope| {
            for (side, target, participant, peer_budget) in [
                (
                    0,
                    sub.target,
                    &spec.submission,
                    spec.interactor.limits.process_count,
                ),
                (
                    1,
                    inter.target,
                    &spec.interactor,
                    spec.submission.limits.process_count,
                ),
            ] {
                let control = Arc::clone(&pair);
                let result_sender = sender.clone();
                if let Err(error) = std::thread::Builder::new()
                    .name(format!("interactive-{}-{side}", spec.run_id))
                    .spawn_scoped(scope, move || {
                        let result = run_with_guardian_paired(
                            root,
                            participant,
                            active,
                            PairedRun {
                                control,
                                side,
                                stdio: Some(target),
                                peer_process_count: peer_budget,
                            },
                        );
                        let _ = result_sender.send((side, result));
                    })
                {
                    pair.abort(side, CleanupCause::LaunchFailed);
                    results[side] =
                        Some(Err(format!("cannot start interactive controller: {error}")));
                }
            }
            drop(sender);
            let mut checker_finished = None;
            while results.iter().any(Option::is_none) {
                for (side, result) in receiver.try_iter() {
                    if side == 1 {
                        checker_finished = Some(Instant::now());
                    }
                    if result.is_err() {
                        pair.abort(side, CleanupCause::InternalError);
                    }
                    results[side] = Some(result);
                }
                for (side, relay) in relays.iter_mut().enumerate() {
                    if let Err(error) = relay.advance() {
                        let cause = if relay.buffer.total_read()
                            > if side == 0 {
                                spec.submission.limits.output_bytes
                            } else {
                                spec.interactor.limits.output_bytes
                            } {
                            CleanupCause::OutputLimit
                        } else {
                            CleanupCause::InternalError
                        };
                        pair.abort(side, cause);
                        relay
                            .error
                            .get_or_insert(if cause == CleanupCause::OutputLimit {
                                RunReason::OutputLimit
                            } else {
                                RunReason::InternalError
                            });
                        relay.reader = None;
                        relay.writer = None;
                        eprintln!("interactive relay failed: {error}");
                    }
                    pair.record_stdout(side, relay.buffer.total_read());
                }
                if checker_finished.is_some_and(|when| when.elapsed() >= Duration::from_millis(50))
                    && results[0].is_none()
                {
                    pair.abort(1, CleanupCause::TargetExited);
                }
                std::thread::sleep(Duration::from_millis(2));
            }
            // Both groups are dead; require observable EOF, rather than assuming a pipe
            // capacity or discarding a tail after a fixed number of reads.
            let deadline = Instant::now() + Duration::from_secs(2);
            while relays.iter().any(|relay| relay.reader.is_some()) && Instant::now() < deadline {
                for (side, relay) in relays.iter_mut().enumerate() {
                    if relay.advance().is_err() {
                        let quota = if side == 0 {
                            spec.submission.limits.output_bytes
                        } else {
                            spec.interactor.limits.output_bytes
                        };
                        let output_limit = relay.buffer.total_read() > quota;
                        pair.abort(
                            side,
                            if output_limit {
                                CleanupCause::OutputLimit
                            } else {
                                CleanupCause::InternalError
                            },
                        );
                        relay.error.get_or_insert(if output_limit {
                            RunReason::OutputLimit
                        } else {
                            RunReason::InternalError
                        });
                        relay.reader = None;
                        relay.writer = None;
                    }
                    pair.record_stdout(side, relay.buffer.total_read());
                }
                std::thread::sleep(Duration::from_millis(2));
            }
            for relay in &mut relays {
                if relay.reader.is_some() {
                    relay.error.get_or_insert(RunReason::InternalError);
                }
            }
        });
        {
            let mut runs = active.lock().unwrap_or_else(|poison| poison.into_inner());
            if !runs
                .get(&spec.run_id)
                .is_some_and(|actual| Arc::ptr_eq(actual, &handle))
            {
                return Err("interactive cancellation ownership changed".into());
            }
            runs.remove(&spec.run_id);
        }
        let mut finished = Vec::with_capacity(2);
        for (side, value) in results.into_iter().enumerate() {
            let mut result = value.ok_or("interactive participant result missing")??;
            result.stdout_bytes = relays[side].buffer.total_read();
            let participant: &RunSpec = if side == 0 {
                &spec.submission
            } else {
                &spec.interactor
            };
            let workspace_bytes = crate::workspace::inspect_workspace(&paths[side].workspace)
                .0
                .saturating_sub(baselines[side]);
            if workspace_bytes.saturating_add(result.stdout_bytes)
                > participant.limits.total_write_bytes
            {
                result.reason = RunReason::WriteLimit;
            }
            if result.stdout_bytes.saturating_add(result.stderr_bytes)
                > participant.limits.output_bytes
            {
                result.reason = RunReason::OutputLimit;
            }
            if let Some(error) = &relays[side].error {
                result.reason = error.clone();
            }
            // Interactive stdout belongs to the peer pipe, as on Windows.
            // Keep its independent relay counters and private capture, but do
            // not publish protocol traffic as a checker diagnostic.
            output_log(&paths[side].stdout).map_err(|error| error.to_string())?;
            finished.push(result);
        }
        spool_paths.cleanup().map_err(|error| error.to_string())?;
        let inter_result = finished.pop().ok_or("interactor result missing")?;
        let sub_result = finished.pop().ok_or("submission result missing")?;
        let (verdict, score_multiplier) = interaction_verdict(
            &sub_result.reason,
            sub_result.exit_code,
            &inter_result.reason,
            inter_result.exit_code,
            pair.user_cancelled(),
        );
        let message = (|| -> io::Result<String> {
            let file = OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
                .open(&interactor.stderr)?;
            if !file.metadata()?.is_file() {
                return Err(io::Error::other(
                    "interactor diagnostics are not a regular file",
                ));
            }
            let mut bytes = Vec::new();
            file.take(4096).read_to_end(&mut bytes)?;
            Ok(String::from_utf8_lossy(&bytes).into_owned())
        })()
        .ok();
        Ok(InteractiveRunResult {
            run_id: spec.run_id.clone(),
            verdict: verdict.into(),
            score_multiplier,
            execution_time_ms: sub_result
                .user_cpu_time_us
                .unwrap_or(0)
                .saturating_add(sub_result.kernel_cpu_time_us.unwrap_or(0))
                / 1000,
            peak_memory_bytes: sub_result.peak_memory_bytes,
            message,
            transcript: None,
            submission_result: sub_result,
            interactor_result: inter_result,
        })
    }
}

#[cfg(target_os = "macos")]
pub(crate) use imp::run;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::guardian_protocol::CleanupCause;

    #[test]
    fn neither_participant_releases_until_both_stdio_and_anchor_proofs_are_ready() {
        let pair = PairControl::default();
        assert!(!pair.may_release());
        pair.mark_ready(0).unwrap();
        assert!(!pair.may_release());
        pair.mark_ready(1).unwrap();
        assert!(pair.may_release());
        assert!(pair.mark_ready(1).is_err());
    }

    #[test]
    fn native_pipe_progress_never_decreases_and_peer_cleanup_is_not_user_cancel() {
        let pair = PairControl::default();
        pair.record_stdout(0, 12);
        pair.record_stdout(0, 3);
        pair.record_stdout(1, 7);
        assert_eq!(pair.stdout_bytes(0), 12);
        assert_eq!(pair.stdout_bytes(1), 7);
        pair.abort(1, CleanupCause::TargetExited);
        assert!(!pair.user_cancelled());
        pair.cancel();
        assert!(pair.user_cancelled());
    }

    #[test]
    fn failed_second_start_cancels_both_and_prevents_first_release() {
        let pair = PairControl::default();
        pair.mark_ready(0).unwrap();
        pair.abort(1, CleanupCause::LaunchFailed);
        assert!(!pair.may_release());
        assert_eq!(pair.cleanup_cause(0), Some(CleanupCause::Cancelled));
        assert_eq!(pair.cleanup_cause(1), Some(CleanupCause::LaunchFailed));
        assert!(pair.mark_ready(1).is_err());
    }

    #[test]
    fn repeated_cancel_and_peer_failure_preserve_the_first_terminal_cause() {
        let pair = PairControl::default();
        pair.abort(0, CleanupCause::OutputLimit);
        pair.cancel();
        pair.abort(1, CleanupCause::LaunchFailed);
        assert_eq!(pair.cleanup_cause(0), Some(CleanupCause::OutputLimit));
        assert_eq!(pair.cleanup_cause(1), Some(CleanupCause::Cancelled));
        assert!(!pair.may_release());
    }

    #[test]
    fn relay_counts_read_bytes_before_forwarding_and_never_reuses_freed_capacity() {
        let mut relay = RelayBuffer::new(8, 6);
        relay.push(b"abc").unwrap();
        assert_eq!(relay.pending(), b"abc");
        relay.consume(2).unwrap();
        assert_eq!(relay.pending(), b"c");
        relay.push(b"def").unwrap();
        assert_eq!(relay.total_read(), 6);
        assert_eq!(relay.pending(), b"cdef");
        assert!(relay.push(b"g").is_err());
        assert_eq!(relay.total_read(), 7);
        assert!(relay.consume(20).is_err());
    }

    #[test]
    fn relay_capacity_provides_backpressure_independent_of_output_quota() {
        let mut relay = RelayBuffer::new(4, 100);
        relay.push(b"abcd").unwrap();
        assert_eq!(relay.available(), 0);
        assert!(relay.push(b"e").is_err());
        assert_eq!(relay.total_read(), 4);
        relay.consume(3).unwrap();
        assert_eq!(relay.available(), 3);
        relay.push(b"xyz").unwrap();
        assert_eq!(relay.pending(), b"dxyz");
        assert_eq!(relay.total_read(), 7);
    }

    #[test]
    fn submission_output_and_write_limits_preserve_canonical_ole_priority() {
        use crate::protocol::RunReason;
        for reason in [RunReason::OutputLimit, RunReason::WriteLimit] {
            for checker_exit in [0, 1, 7, 41] {
                assert_eq!(
                    interaction_verdict(
                        &reason,
                        None,
                        &RunReason::Exited,
                        Some(checker_exit),
                        false
                    ),
                    ("OLE", Some(0.0))
                );
            }
            assert_eq!(
                interaction_verdict(&RunReason::Cancelled, None, &reason, None, false),
                ("JE", Some(0.0))
            );
        }
    }

    #[test]
    fn interactive_result_prioritizes_resource_failures_and_checker_health() {
        use crate::protocol::RunReason;
        assert_eq!(
            interaction_verdict(
                &RunReason::MemoryLimit,
                Some(0),
                &RunReason::Exited,
                Some(0),
                false
            )
            .0,
            "MLE"
        );
        assert_eq!(
            interaction_verdict(
                &RunReason::WallTimeLimit,
                Some(0),
                &RunReason::Exited,
                Some(1),
                false
            )
            .0,
            "TLE"
        );
        assert_eq!(
            interaction_verdict(
                &RunReason::OutputLimit,
                None,
                &RunReason::Exited,
                Some(0),
                false
            )
            .0,
            "OLE"
        );
        assert_eq!(
            interaction_verdict(
                &RunReason::Exited,
                Some(0),
                &RunReason::MemoryLimit,
                Some(0),
                false
            )
            .0,
            "JE"
        );
        assert_eq!(
            interaction_verdict(
                &RunReason::LaunchError,
                None,
                &RunReason::Exited,
                Some(0),
                false
            )
            .0,
            "JE"
        );
        assert_eq!(
            interaction_verdict(
                &RunReason::Cancelled,
                None,
                &RunReason::Exited,
                Some(0),
                false
            )
            .0,
            "AC"
        );
        assert_eq!(
            interaction_verdict(
                &RunReason::Exited,
                Some(0),
                &RunReason::Exited,
                Some(0),
                true
            )
            .0,
            "CANCELLED"
        );
        for (exit, verdict, score) in [
            (0, "AC", Some(1.0)),
            (1, "WA", Some(0.0)),
            (2, "PE", Some(0.0)),
            (3, "JE", Some(0.0)),
            (7, "PARTIAL", None),
            (41, "PARTIAL", Some(0.25)),
        ] {
            assert_eq!(
                interaction_verdict(
                    &RunReason::Exited,
                    Some(0),
                    &RunReason::Exited,
                    Some(exit),
                    false
                ),
                (verdict, score)
            );
        }
    }
}
#[cfg(test)]
#[test]
fn enrollment_pause_starts_after_both_participants_are_ready() {
    let pair = PairControl::with_enrollment_pause(Some(std::time::Duration::from_millis(10)));
    pair.mark_ready(0).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(20));
    assert!(!pair.may_release());
    pair.mark_ready(1).unwrap();
    assert!(
        !pair.may_release(),
        "startup delay cannot consume the enrolled hold"
    );
    std::thread::sleep(std::time::Duration::from_millis(15));
    assert!(pair.may_release());
    pair.cancel();
    assert!(
        !pair.may_release(),
        "expired test pause must not bypass cancellation"
    );
}
