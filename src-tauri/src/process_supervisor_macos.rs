use super::INTERNAL_SUPERVISOR_ARGUMENT;
use fs4::{FileExt, TryLockError};
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::os::fd::{AsRawFd, RawFd};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const OWNER_LOCK_FILE: &str = "process-tree.owner.lock";
const GENERATION_FILE: &str = "process-tree.generation";
const GENERATION_HEADER: &str = "JUDGEDESK_PROCESS_TREE/1";
const SUPERVISOR_TOKEN_ENV: &str = "JUDGEDESK_SUPERVISOR_TOKEN";
const SUPERVISOR_DIRECTORY_ENV: &str = "JUDGEDESK_SUPERVISOR_DIRECTORY";
const SUPERVISOR_GENERATION_ENV: &str = "JUDGEDESK_SUPERVISOR_GENERATION";
const MAX_FRAME_BYTES: u64 = 256;
const MAX_GENERATION_BYTES: u64 = 160;
const START_TIMEOUT: Duration = Duration::from_secs(10);
const TREE_RECOVERY_TIMEOUT: Duration = Duration::from_secs(20);
const DRAIN_TIMEOUT: Duration = Duration::from_secs(10);
const BACKEND_TERM_TIMEOUT: Duration = Duration::from_secs(2);
const POLL_INTERVAL: Duration = Duration::from_millis(10);

#[derive(Debug)]
struct BackendProcess {
    pid: i32,
    monitor: ProcessMonitor,
}

#[derive(Debug)]
struct SupervisorProcess {
    child: Arc<Mutex<Child>>,
    stdin: Option<ChildStdin>,
    frames: mpsc::Receiver<io::Result<Vec<u8>>>,
    reader_thread: Option<JoinHandle<()>>,
    monitor_thread: Option<JoinHandle<()>>,
    expected_exit: Arc<AtomicBool>,
    failed: Arc<AtomicBool>,
    token: String,
}

#[derive(Debug)]
pub(super) struct BackendTreeGuard {
    generation_path: Option<PathBuf>,
    generation: Option<String>,
    backend: Arc<Mutex<Option<BackendProcess>>>,
    supervisor: Mutex<Option<SupervisorProcess>>,
    failed: Arc<AtomicBool>,
    recovery_lock: Arc<Mutex<Option<ProvisionalTreeLock>>>,
}

#[derive(Debug)]
struct ProvisionalTreeLock {
    owner: File,
    generation: File,
}

#[derive(Debug)]
struct ProcessMonitor {
    descriptor: RawFd,
    pid: i32,
    observed_exit: bool,
}

impl BackendTreeGuard {
    pub(super) fn start(
        directory: &Path,
        generation: &str,
        startup_token: &str,
    ) -> io::Result<Self> {
        validate_nonce(generation, "process-tree generation")?;
        validate_nonce(startup_token, "supervisor startup token")?;
        let mut provisional = ProvisionalTreeLock::acquire(directory, TREE_RECOVERY_TIMEOUT)?;
        provisional.write_generation(generation)?;

        let backend = Arc::new(Mutex::new(None));
        let failed = Arc::new(AtomicBool::new(false));
        let recovery_lock = Arc::new(Mutex::new(None));
        let supervisor = SupervisorProcess::spawn(
            directory,
            generation,
            startup_token,
            Arc::clone(&backend),
            Arc::clone(&failed),
            Arc::clone(&recovery_lock),
            provisional,
        )?;
        Ok(Self {
            generation_path: Some(directory.join(GENERATION_FILE)),
            generation: Some(generation.to_owned()),
            backend,
            supervisor: Mutex::new(Some(supervisor)),
            failed,
            recovery_lock,
        })
    }

    #[cfg(test)]
    pub(super) fn for_tests(_generation: &str) -> io::Result<Self> {
        Ok(Self {
            generation_path: None,
            generation: None,
            backend: Arc::new(Mutex::new(None)),
            supervisor: Mutex::new(None),
            failed: Arc::new(AtomicBool::new(false)),
            recovery_lock: Arc::new(Mutex::new(None)),
        })
    }

    pub(super) fn runtime_environment(&self) -> Option<(PathBuf, String)> {
        Some((
            self.generation_path.as_ref()?.clone(),
            self.generation.as_ref()?.clone(),
        ))
    }

    pub(super) fn assign_backend(&self, process_id: u32) -> io::Result<()> {
        if self.failed.load(Ordering::Acquire) {
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "JudgeDesk process supervisor is unavailable",
            ));
        }
        let pid = i32::try_from(process_id)
            .ok()
            .filter(|pid| *pid > 0)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid backend PID"))?;
        let process = BackendProcess {
            pid,
            monitor: ProcessMonitor::new(pid)?,
        };
        let mut backend = self
            .backend
            .lock()
            .map_err(|_| io::Error::other("backend process state is unavailable"))?;
        if backend.is_some() {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "backend process is already registered",
            ));
        }
        let mut supervisor = self
            .supervisor
            .lock()
            .map_err(|_| io::Error::other("process supervisor state is unavailable"))?;
        let Some(supervisor) = supervisor.as_mut() else {
            // Unit tests intentionally use an in-process guard without a helper.
            if self.generation_path.is_none() {
                *backend = Some(process);
                return Ok(());
            }
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "process supervisor is unavailable",
            ));
        };
        supervisor.assign_backend(pid)?;
        // The helper can acknowledge ASSIGNED and exit before this thread resumes.
        // Its monitor sets `failed` before waiting for the backend mutex, so recheck
        // while still holding that mutex; returning an error makes the caller kill
        // the just-spawned backend instead of publishing it without an owner.
        if self.failed.load(Ordering::Acquire) {
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "JudgeDesk process supervisor exited during backend assignment",
            ));
        }
        *backend = Some(process);
        Ok(())
    }

    pub(super) fn wait_for_empty(&self, timeout: Duration) -> io::Result<()> {
        let deadline = Instant::now() + timeout;
        loop {
            if self.failed.load(Ordering::Acquire) {
                return self
                    .wait_for_recovery_barrier(deadline.saturating_duration_since(Instant::now()));
            }
            let empty = {
                let mut backend = self
                    .backend
                    .lock()
                    .map_err(|_| io::Error::other("backend process state is unavailable"))?;
                match backend.as_mut() {
                    Some(process) => {
                        if process.monitor.exited()? {
                            backend.take();
                            true
                        } else {
                            false
                        }
                    }
                    None => true,
                }
            };
            if empty {
                // Recovery removes the backend from this slot before terminating it so a
                // persistent kernel error cannot monopolize the mutex. Never interpret that
                // transient None as an empty tree.
                if self.failed.load(Ordering::Acquire) {
                    return self.wait_for_recovery_barrier(
                        deadline.saturating_duration_since(Instant::now()),
                    );
                }
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "backend process did not exit before the handoff deadline",
                ));
            }
            thread::sleep(POLL_INTERVAL);
        }
    }

    pub(super) fn terminate_and_wait(&self, timeout: Duration) -> io::Result<()> {
        let deadline = Instant::now() + timeout;
        if self.failed.load(Ordering::Acquire) {
            return self
                .wait_for_recovery_barrier(deadline.saturating_duration_since(Instant::now()));
        }
        {
            let mut backend = self
                .backend
                .lock()
                .map_err(|_| io::Error::other("backend process state is unavailable"))?;
            if let Some(process) = backend.as_mut() {
                process.terminate(deadline.saturating_duration_since(Instant::now()))?;
                backend.take();
            }
        }
        if self.failed.load(Ordering::Acquire) {
            self.wait_for_recovery_barrier(deadline.saturating_duration_since(Instant::now()))
        } else {
            Ok(())
        }
    }

    pub(super) fn shutdown(&self, timeout: Duration) -> io::Result<()> {
        let deadline = Instant::now() + timeout;
        self.terminate_and_wait(deadline.saturating_duration_since(Instant::now()))?;
        if self.failed.load(Ordering::Acquire) {
            self.wait_for_recovery_barrier(deadline.saturating_duration_since(Instant::now()))?;
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "JudgeDesk process supervisor exited unexpectedly",
            ));
        }
        let mut supervisor = self
            .supervisor
            .lock()
            .map_err(|_| io::Error::other("process supervisor state is unavailable"))?;
        let Some(process) = supervisor.as_mut() else {
            return Ok(());
        };
        process.shutdown(deadline.saturating_duration_since(Instant::now()))?;
        supervisor.take();
        Ok(())
    }

    fn wait_for_recovery_barrier(&self, timeout: Duration) -> io::Result<()> {
        let deadline = Instant::now() + timeout;
        loop {
            if self
                .recovery_lock
                .lock()
                .map_err(|_| io::Error::other("process-tree recovery state is unavailable"))?
                .is_some()
            {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "process-tree recovery barrier was not established",
                ));
            }
            thread::sleep(POLL_INTERVAL);
        }
    }
}

impl SupervisorProcess {
    #[allow(clippy::too_many_arguments)]
    fn spawn(
        directory: &Path,
        generation: &str,
        token: &str,
        backend: Arc<Mutex<Option<BackendProcess>>>,
        failed: Arc<AtomicBool>,
        recovery_lock: Arc<Mutex<Option<ProvisionalTreeLock>>>,
        provisional: ProvisionalTreeLock,
    ) -> io::Result<Self> {
        let mut command = Command::new(std::env::current_exe()?);
        command
            .arg(INTERNAL_SUPERVISOR_ARGUMENT)
            .env(SUPERVISOR_TOKEN_ENV, token)
            .env(SUPERVISOR_DIRECTORY_ENV, directory)
            .env(SUPERVISOR_GENERATION_ENV, generation)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .process_group(0);
        let mut child = command.spawn()?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| io::Error::other("supervisor stdin pipe is unavailable"))?;
        make_fd_close_on_exec(stdin.as_raw_fd())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| io::Error::other("supervisor stdout pipe is unavailable"))?;
        let (frames, reader_thread) = spawn_frame_reader(stdout);
        let child = Arc::new(Mutex::new(child));
        let expected_exit = Arc::new(AtomicBool::new(false));

        provisional.release()?;
        let expected_ready = ready_frame(token);
        match frames.recv_timeout(START_TIMEOUT) {
            Ok(Ok(frame)) if frame == expected_ready => {}
            Ok(Ok(frame)) => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!(
                        "process supervisor returned an invalid READY frame: {}",
                        String::from_utf8_lossy(&frame)
                    ),
                ));
            }
            Ok(Err(error)) => return Err(error),
            Err(error) => {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    format!("process supervisor READY timed out: {error}"),
                ));
            }
        }

        let monitor_thread = spawn_supervisor_monitor(
            Arc::clone(&child),
            Arc::clone(&expected_exit),
            Arc::clone(&failed),
            directory.to_owned(),
            backend,
            recovery_lock,
        );
        Ok(Self {
            child,
            stdin: Some(stdin),
            frames,
            reader_thread: Some(reader_thread),
            monitor_thread: Some(monitor_thread),
            expected_exit,
            failed,
            token: token.to_owned(),
        })
    }

    fn assign_backend(&mut self, pid: i32) -> io::Result<()> {
        if self.failed.load(Ordering::Acquire) {
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "JudgeDesk process supervisor is unavailable",
            ));
        }
        let frame = assign_frame(&self.token, pid);
        let stdin = self
            .stdin
            .as_mut()
            .ok_or_else(|| io::Error::new(io::ErrorKind::BrokenPipe, "supervisor stdin closed"))?;
        stdin.write_all(&frame)?;
        stdin.flush()?;
        let expected = assigned_frame(&self.token, pid);
        match self.frames.recv_timeout(START_TIMEOUT) {
            Ok(Ok(frame)) if frame == expected => Ok(()),
            Ok(Ok(frame)) => Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "process supervisor returned an invalid ASSIGNED frame: {}",
                    String::from_utf8_lossy(&frame)
                ),
            )),
            Ok(Err(error)) => Err(error),
            Err(error) => Err(io::Error::new(
                io::ErrorKind::TimedOut,
                format!("process supervisor ASSIGNED timed out: {error}"),
            )),
        }
    }

    fn shutdown(&mut self, timeout: Duration) -> io::Result<()> {
        if self.failed.load(Ordering::Acquire) {
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "JudgeDesk process supervisor exited unexpectedly",
            ));
        }
        let frame = drain_frame(&self.token);
        {
            let stdin = self.stdin.as_mut().ok_or_else(|| {
                io::Error::new(io::ErrorKind::BrokenPipe, "supervisor stdin closed")
            })?;
            stdin.write_all(&frame)?;
            stdin.flush()?;
        }

        let expected = drained_frame(&self.token);
        match self.frames.recv_timeout(timeout) {
            Ok(Ok(frame)) if frame == expected => {}
            Ok(Ok(frame)) => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!(
                        "process supervisor returned an invalid DRAINED frame: {}",
                        String::from_utf8_lossy(&frame)
                    ),
                ));
            }
            Ok(Err(error)) => return Err(error),
            Err(error) => {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    format!("process supervisor drain timed out: {error}"),
                ));
            }
        }
        // The helper holds both tree locks until it receives this final acknowledgement. Mark
        // its subsequent exit expected before sending the acknowledgement, eliminating the race
        // where the monitor could observe a clean helper exit first.
        self.expected_exit.store(true, Ordering::Release);
        if let Some(stdin) = self.stdin.as_mut() {
            stdin.write_all(&exit_ack_frame(&self.token))?;
            stdin.flush()?;
        }
        self.stdin.take();
        wait_for_child_exit(&self.child, timeout)?;
        if let Some(thread) = self.monitor_thread.take() {
            let _ = thread.join();
        }
        if let Some(thread) = self.reader_thread.take() {
            let _ = thread.join();
        }
        Ok(())
    }
}

impl BackendProcess {
    fn terminate(&mut self, timeout: Duration) -> io::Result<()> {
        if self.monitor.exited()? {
            return Ok(());
        }
        signal_process(self.pid, libc::SIGTERM)?;
        if self
            .monitor
            .wait_for_exit(timeout.min(BACKEND_TERM_TIMEOUT))?
        {
            return Ok(());
        }
        signal_process(self.pid, libc::SIGKILL)?;
        if self.monitor.wait_for_exit(timeout)? {
            Ok(())
        } else {
            Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "backend process did not terminate",
            ))
        }
    }
}

impl ProcessMonitor {
    fn new(pid: i32) -> io::Result<Self> {
        let descriptor = unsafe { libc::kqueue() };
        if descriptor < 0 {
            return Err(io::Error::last_os_error());
        }
        if let Err(error) = make_fd_close_on_exec(descriptor) {
            unsafe {
                libc::close(descriptor);
            }
            return Err(error);
        }
        let change = libc::kevent {
            ident: pid as libc::uintptr_t,
            filter: libc::EVFILT_PROC,
            flags: libc::EV_ADD | libc::EV_ENABLE | libc::EV_ONESHOT,
            fflags: libc::NOTE_EXIT,
            data: 0,
            udata: std::ptr::null_mut(),
        };
        if unsafe {
            libc::kevent(
                descriptor,
                &change,
                1,
                std::ptr::null_mut(),
                0,
                std::ptr::null(),
            )
        } < 0
        {
            let error = io::Error::last_os_error();
            unsafe {
                libc::close(descriptor);
            }
            return Err(error);
        }
        Ok(Self {
            descriptor,
            pid,
            observed_exit: false,
        })
    }

    fn exited(&mut self) -> io::Result<bool> {
        if self.observed_exit {
            return Ok(true);
        }
        let mut event: libc::kevent = unsafe { std::mem::zeroed() };
        let timeout = libc::timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        let count = unsafe {
            libc::kevent(
                self.descriptor,
                std::ptr::null(),
                0,
                &mut event,
                1,
                &timeout,
            )
        };
        if count < 0 {
            return Err(io::Error::last_os_error());
        }
        if count > 0 {
            self.observed_exit = true;
            Ok(true)
        } else {
            let missing = unsafe { libc::kill(self.pid, 0) } != 0
                && io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH);
            self.observed_exit = missing;
            Ok(missing)
        }
    }

    fn wait_for_exit(&mut self, timeout: Duration) -> io::Result<bool> {
        let deadline = Instant::now() + timeout;
        loop {
            if self.exited()? {
                return Ok(true);
            }
            if Instant::now() >= deadline {
                return Ok(false);
            }
            thread::sleep(POLL_INTERVAL);
        }
    }
}

impl Drop for ProcessMonitor {
    fn drop(&mut self) {
        if self.descriptor >= 0 {
            unsafe {
                libc::close(self.descriptor);
            }
            self.descriptor = -1;
        }
    }
}

impl ProvisionalTreeLock {
    fn acquire(directory: &Path, timeout: Duration) -> io::Result<Self> {
        fs::create_dir_all(directory)?;
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700))?;
        let owner = open_lock_file(&directory.join(OWNER_LOCK_FILE))?;
        acquire_exclusive(&owner, timeout, "process-tree owner")?;
        let generation = open_lock_file(&directory.join(GENERATION_FILE))?;
        if let Err(error) = acquire_exclusive(&generation, timeout, "process-tree generation") {
            let _ = FileExt::unlock(&owner);
            return Err(error);
        }
        Ok(Self { owner, generation })
    }

    fn write_generation(&mut self, generation: &str) -> io::Result<()> {
        validate_nonce(generation, "process-tree generation")?;
        let contents = generation_contents(generation);
        if contents.len() as u64 > MAX_GENERATION_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "process-tree generation metadata is too large",
            ));
        }
        self.generation.set_len(0)?;
        self.generation.seek(SeekFrom::Start(0))?;
        self.generation.write_all(contents.as_bytes())?;
        self.generation.sync_all()
    }

    fn release(self) -> io::Result<()> {
        FileExt::unlock(&self.generation)?;
        FileExt::unlock(&self.owner)
    }
}

fn spawn_frame_reader(
    stdout: ChildStdout,
) -> (mpsc::Receiver<io::Result<Vec<u8>>>, JoinHandle<()>) {
    let (sender, receiver) = mpsc::channel();
    let thread = thread::Builder::new()
        .name("judgedesk-supervisor-frames".into())
        .spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut frame = Vec::new();
                let result = reader
                    .by_ref()
                    .take(MAX_FRAME_BYTES + 1)
                    .read_until(b'\n', &mut frame);
                match result {
                    Ok(0) => break,
                    Ok(_) if frame.len() as u64 <= MAX_FRAME_BYTES => {
                        if sender.send(Ok(frame)).is_err() {
                            break;
                        }
                    }
                    Ok(_) => {
                        let _ = sender.send(Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            "process supervisor frame exceeds its size limit",
                        )));
                        break;
                    }
                    Err(error) => {
                        let _ = sender.send(Err(error));
                        break;
                    }
                }
            }
        })
        .expect("spawn process supervisor frame reader");
    (receiver, thread)
}

fn spawn_supervisor_monitor(
    child: Arc<Mutex<Child>>,
    expected_exit: Arc<AtomicBool>,
    failed: Arc<AtomicBool>,
    directory: PathBuf,
    backend: Arc<Mutex<Option<BackendProcess>>>,
    recovery_lock: Arc<Mutex<Option<ProvisionalTreeLock>>>,
) -> JoinHandle<()> {
    thread::Builder::new()
        .name("judgedesk-supervisor-monitor".into())
        .spawn(move || loop {
            let status = match child.lock() {
                Ok(mut child) => child.try_wait(),
                Err(_) => Err(io::Error::other(
                    "process supervisor child state was poisoned",
                )),
            };
            match status {
                Ok(None) => {}
                Ok(Some(_)) if expected_exit.load(Ordering::Acquire) => break,
                Ok(Some(_)) | Err(_) => {
                    failed.store(true, Ordering::Release);
                    recover_after_supervisor_exit(&directory, &backend, &recovery_lock);
                    break;
                }
            }
            thread::sleep(Duration::from_millis(25));
        })
        .expect("spawn process supervisor monitor")
}

fn recover_after_supervisor_exit(
    directory: &Path,
    backend: &Arc<Mutex<Option<BackendProcess>>>,
    recovery_lock: &Arc<Mutex<Option<ProvisionalTreeLock>>>,
) {
    let mut process = backend
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take();
    if let Some(process) = process.as_mut() {
        while process.terminate(DRAIN_TIMEOUT).is_err() {
            thread::sleep(Duration::from_millis(100));
        }
    }
    let barrier = loop {
        match ProvisionalTreeLock::acquire(directory, TREE_RECOVERY_TIMEOUT) {
            Ok(barrier) => break barrier,
            Err(error) => {
                eprintln!(
                    "JudgeDesk is retaining process-tree recovery after supervisor failure: {error}"
                );
                thread::sleep(Duration::from_millis(100));
            }
        }
    };
    *recovery_lock
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(barrier);
}

fn wait_for_child_exit(child: &Arc<Mutex<Child>>, timeout: Duration) -> io::Result<()> {
    let deadline = Instant::now() + timeout;
    loop {
        let status = child
            .lock()
            .map_err(|_| io::Error::other("process supervisor child state is unavailable"))?
            .try_wait()?;
        if status.is_some() {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "process supervisor did not exit after draining",
            ));
        }
        thread::sleep(POLL_INTERVAL);
    }
}

fn supervisor_main() -> io::Result<()> {
    if unsafe { libc::setpgid(0, 0) } != 0 {
        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::EPERM) {
            return Err(error);
        }
    }
    let token = std::env::var(SUPERVISOR_TOKEN_ENV).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "process supervisor token is missing",
        )
    })?;
    validate_nonce(&token, "process supervisor token")?;
    let generation = std::env::var(SUPERVISOR_GENERATION_ENV).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "process supervisor generation is missing",
        )
    })?;
    validate_nonce(&generation, "process supervisor generation")?;
    let directory = PathBuf::from(std::env::var_os(SUPERVISOR_DIRECTORY_ENV).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "process supervisor directory is missing",
        )
    })?);
    let owner = open_lock_file(&directory.join(OWNER_LOCK_FILE))?;
    let generation_file = open_lock_file(&directory.join(GENERATION_FILE))?;
    let requests = spawn_request_reader();
    acquire_owner_for_helper(&owner, &requests)?;
    validate_generation_file(&generation_file, &generation)?;

    let mut output = io::stdout().lock();
    output.write_all(&ready_frame(&token))?;
    output.flush()?;

    let mut backend: Option<BackendProcess> = None;
    let clean_drain = loop {
        match requests.recv_timeout(POLL_INTERVAL) {
            Ok(Ok(frame)) if frame == drain_frame(&token) => break true,
            Ok(Ok(frame)) if backend.is_none() => {
                let pid = parse_assign_frame(&frame, &token)?;
                let process = BackendProcess {
                    pid,
                    monitor: ProcessMonitor::new(pid)?,
                };
                output.write_all(&assigned_frame(&token, pid))?;
                output.flush()?;
                backend = Some(process);
            }
            Ok(Ok(_)) | Ok(Err(_)) | Err(mpsc::RecvTimeoutError::Disconnected) => break false,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let backend_exited = match backend.as_mut() {
                    Some(process) => match process.monitor.exited() {
                        Ok(exited) => exited,
                        Err(_) => break false,
                    },
                    None => false,
                };
                if backend_exited {
                    backend.take();
                }
            }
        }
    };

    if let Some(process) = backend.as_mut() {
        while process.terminate(DRAIN_TIMEOUT).is_err() {
            thread::sleep(Duration::from_millis(100));
        }
    }
    acquire_exclusive(&generation_file, DRAIN_TIMEOUT, "executor generation drain")?;
    if clean_drain {
        let _ = output.write_all(&drained_frame(&token));
        let _ = output.flush();
        // Do not release the ownership locks or exit before the primary has observed DRAINED and
        // marked this helper exit as expected.
        let _ = requests
            .recv_timeout(START_TIMEOUT)
            .is_ok_and(|frame| matches!(frame, Ok(frame) if frame == exit_ack_frame(&token)));
    }
    FileExt::unlock(&generation_file)?;
    FileExt::unlock(&owner)?;
    Ok(())
}

fn spawn_request_reader() -> mpsc::Receiver<io::Result<Vec<u8>>> {
    let (sender, receiver) = mpsc::channel();
    thread::Builder::new()
        .name("judgedesk-supervisor-control".into())
        .spawn(move || {
            let mut input = BufReader::new(io::stdin().lock());
            loop {
                let mut request = Vec::new();
                let result = input
                    .by_ref()
                    .take(MAX_FRAME_BYTES + 1)
                    .read_until(b'\n', &mut request);
                let frame = match result {
                    Ok(0) => Err(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        "process supervisor control pipe closed",
                    )),
                    Ok(_) if request.len() as u64 <= MAX_FRAME_BYTES => Ok(request),
                    Ok(_) => Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "process supervisor request exceeds its size limit",
                    )),
                    Err(error) => Err(error),
                };
                let terminal = frame.is_err();
                if sender.send(frame).is_err() || terminal {
                    break;
                }
            }
        })
        .expect("spawn process supervisor control reader");
    receiver
}

fn acquire_owner_for_helper(
    owner: &File,
    requests: &mpsc::Receiver<io::Result<Vec<u8>>>,
) -> io::Result<()> {
    loop {
        match FileExt::try_lock(owner) {
            Ok(()) => return Ok(()),
            Err(TryLockError::WouldBlock) => match requests.try_recv() {
                Ok(_) | Err(mpsc::TryRecvError::Disconnected) => {
                    return Err(io::Error::new(
                        io::ErrorKind::BrokenPipe,
                        "process supervisor parent exited before handoff",
                    ));
                }
                Err(mpsc::TryRecvError::Empty) => thread::sleep(POLL_INTERVAL),
            },
            Err(TryLockError::Error(error)) => return Err(error),
        }
    }
}

fn validate_generation_file(file: &File, generation: &str) -> io::Result<()> {
    if file.metadata()?.len() > MAX_GENERATION_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "process-tree generation metadata is too large",
        ));
    }
    let mut file = file.try_clone()?;
    file.seek(SeekFrom::Start(0))?;
    let mut contents = String::new();
    file.take(MAX_GENERATION_BYTES + 1)
        .read_to_string(&mut contents)?;
    if contents == generation_contents(generation) {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "process-tree generation metadata does not match",
        ))
    }
}

fn acquire_exclusive(file: &File, timeout: Duration, label: &str) -> io::Result<()> {
    let deadline = Instant::now() + timeout;
    loop {
        match FileExt::try_lock(file) {
            Ok(()) => return Ok(()),
            Err(TryLockError::WouldBlock) if Instant::now() < deadline => {
                thread::sleep(POLL_INTERVAL);
            }
            Err(TryLockError::WouldBlock) => {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    format!("{label} did not drain before the handoff deadline"),
                ));
            }
            Err(TryLockError::Error(error)) => return Err(error),
        }
    }
}

fn open_lock_file(path: &Path) -> io::Result<File> {
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .mode(0o600)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
        .open(path)?;
    file.set_permissions(fs::Permissions::from_mode(0o600))?;
    Ok(file)
}

fn signal_process(pid: i32, signal: i32) -> io::Result<()> {
    if unsafe { libc::kill(pid, signal) } == 0 {
        return Ok(());
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err(error)
    }
}

fn make_fd_close_on_exec(descriptor: RawFd) -> io::Result<()> {
    let flags = unsafe { libc::fcntl(descriptor, libc::F_GETFD) };
    if flags < 0 || unsafe { libc::fcntl(descriptor, libc::F_SETFD, flags | libc::FD_CLOEXEC) } < 0
    {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn validate_nonce(value: &str, label: &str) -> io::Result<()> {
    if value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{label} is invalid"),
        ))
    }
}

fn generation_contents(generation: &str) -> String {
    format!("{GENERATION_HEADER}\ngeneration={generation}\n")
}

fn ready_frame(token: &str) -> Vec<u8> {
    format!("JUDGEDESK_SUPERVISOR/1 READY {token}\n").into_bytes()
}

fn assign_frame(token: &str, pid: i32) -> Vec<u8> {
    format!("JUDGEDESK_SUPERVISOR/1 ASSIGN {token} {pid}\n").into_bytes()
}

fn assigned_frame(token: &str, pid: i32) -> Vec<u8> {
    format!("JUDGEDESK_SUPERVISOR/1 ASSIGNED {token} {pid}\n").into_bytes()
}

fn parse_assign_frame(frame: &[u8], token: &str) -> io::Result<i32> {
    let prefix = format!("JUDGEDESK_SUPERVISOR/1 ASSIGN {token} ");
    let text = std::str::from_utf8(frame)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid ASSIGN frame"))?;
    let pid = text
        .strip_prefix(&prefix)
        .and_then(|value| value.strip_suffix('\n'))
        .and_then(|value| value.parse::<i32>().ok())
        .filter(|pid| *pid > 0)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "invalid ASSIGN frame"))?;
    Ok(pid)
}

fn drain_frame(token: &str) -> Vec<u8> {
    format!("JUDGEDESK_SUPERVISOR/1 DRAIN {token}\n").into_bytes()
}

fn drained_frame(token: &str) -> Vec<u8> {
    format!("JUDGEDESK_SUPERVISOR/1 DRAINED {token}\n").into_bytes()
}

fn exit_ack_frame(token: &str) -> Vec<u8> {
    format!("JUDGEDESK_SUPERVISOR/1 EXIT_ACK {token}\n").into_bytes()
}

pub(super) fn try_run_internal_mode() -> Option<i32> {
    if std::env::args_os().nth(1).as_deref()
        != Some(std::ffi::OsStr::new(INTERNAL_SUPERVISOR_ARGUMENT))
    {
        return None;
    }
    if std::env::args_os().nth(2).is_some() {
        return Some(64);
    }
    Some(if supervisor_main().is_ok() { 0 } else { 70 })
}
