use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

const INTERNAL_SUPERVISOR_ARGUMENT: &str = "--judgedesk-internal-job-supervisor-v1";

#[cfg(windows)]
#[cfg_attr(
    test,
    allow(
        dead_code,
        reason = "unit-test binaries cannot enter the app helper mode"
    )
)]
mod windows {
    use super::INTERNAL_SUPERVISOR_ARGUMENT;
    use fs4::{FileExt, TryLockError};
    use std::ffi::OsStr;
    use std::fs::{File, OpenOptions};
    use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write};
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::AsRawHandle;
    use std::path::{Path, PathBuf};
    use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{mpsc, Arc, Mutex};
    use std::thread::{self, JoinHandle};
    use std::time::{Duration, Instant};
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, SetHandleInformation, SetLastError, ERROR_ALREADY_EXISTS,
        ERROR_SUCCESS, HANDLE_FLAG_INHERIT,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
        JobObjectExtendedLimitInformation, OpenJobObjectW, QueryInformationJobObject,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::SystemServices::{JOB_OBJECT_QUERY, JOB_OBJECT_TERMINATE};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
    };

    const TREE_LOCK_FILE: &str = "process-tree.owner.lock";
    const TREE_GUARD_FILE: &str = "process-tree.guard";
    const SUPERVISOR_TOKEN_ENV: &str = "JUDGEDESK_SUPERVISOR_TOKEN";
    const SUPERVISOR_DIRECTORY_ENV: &str = "JUDGEDESK_SUPERVISOR_DIRECTORY";
    const SUPERVISOR_JOB_NONCE_ENV: &str = "JUDGEDESK_SUPERVISOR_JOB_NONCE";
    const MAX_FRAME_BYTES: u64 = 192;
    const START_TIMEOUT: Duration = Duration::from_secs(5);
    const TREE_RECOVERY_TIMEOUT: Duration = Duration::from_secs(20);
    const DRAIN_TIMEOUT: Duration = Duration::from_secs(10);
    const POLL_INTERVAL: Duration = Duration::from_millis(5);
    const HANDOFF_EXIT_CODE: u32 = 0x4A44_0010;

    #[derive(Clone, Debug)]
    struct BackendJob {
        inner: Arc<BackendJobHandle>,
    }

    #[derive(Debug)]
    struct BackendJobHandle {
        handle: isize,
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
        job: BackendJob,
        supervisor: Mutex<Option<SupervisorProcess>>,
        failed: Arc<AtomicBool>,
        generation_path: Option<PathBuf>,
        generation: Option<String>,
    }

    struct ProvisionalTreeLock {
        _file: File,
        guard_path: PathBuf,
    }

    impl BackendJob {
        fn create(nonce: &str) -> io::Result<Self> {
            use std::mem::size_of;

            validate_nonce(nonce, "backend Job nonce")?;
            let name = backend_job_name(nonce);
            unsafe {
                SetLastError(ERROR_SUCCESS);
            }
            let handle = unsafe { CreateJobObjectW(std::ptr::null(), name.as_ptr()) };
            if handle.is_null() {
                return Err(io::Error::last_os_error());
            }
            if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
                unsafe {
                    CloseHandle(handle);
                }
                return Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    "backend Job nonce unexpectedly already exists",
                ));
            }

            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let configured = unsafe {
                SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    std::ptr::addr_of!(limits).cast(),
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            };
            if configured == 0 {
                let error = io::Error::last_os_error();
                unsafe {
                    CloseHandle(handle);
                }
                return Err(error);
            }

            Ok(Self {
                inner: Arc::new(BackendJobHandle {
                    handle: handle as isize,
                }),
            })
        }

        fn open(nonce: &str) -> io::Result<Self> {
            validate_nonce(nonce, "backend Job nonce")?;
            let name = backend_job_name(nonce);
            let handle = unsafe {
                OpenJobObjectW(JOB_OBJECT_QUERY | JOB_OBJECT_TERMINATE, 0, name.as_ptr())
            };
            if handle.is_null() {
                Err(io::Error::last_os_error())
            } else {
                Ok(Self {
                    inner: Arc::new(BackendJobHandle {
                        handle: handle as isize,
                    }),
                })
            }
        }

        fn handle(&self) -> windows_sys::Win32::Foundation::HANDLE {
            self.inner.handle as _
        }

        fn assign(&self, process_id: u32) -> io::Result<()> {
            let process =
                unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, process_id) };
            if process.is_null() {
                return Err(io::Error::last_os_error());
            }
            let assigned = unsafe { AssignProcessToJobObject(self.handle(), process) };
            let assignment_error = (assigned == 0).then(io::Error::last_os_error);
            unsafe {
                CloseHandle(process);
            }
            assignment_error.map_or(Ok(()), Err)
        }

        fn active_process_count(&self) -> io::Result<u32> {
            use std::mem::size_of;

            let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
            let queried = unsafe {
                QueryInformationJobObject(
                    self.handle(),
                    JobObjectBasicAccountingInformation,
                    std::ptr::addr_of_mut!(accounting).cast(),
                    size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                    std::ptr::null_mut(),
                )
            };
            if queried == 0 {
                Err(io::Error::last_os_error())
            } else {
                Ok(accounting.ActiveProcesses)
            }
        }

        fn wait_for_empty(&self, timeout: Duration) -> io::Result<()> {
            let deadline = Instant::now() + timeout;
            loop {
                if self.active_process_count()? == 0 {
                    return Ok(());
                }
                if Instant::now() >= deadline {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "backend Job did not become empty before the handoff deadline",
                    ));
                }
                thread::sleep(POLL_INTERVAL);
            }
        }

        fn terminate_and_wait(&self, timeout: Duration) -> io::Result<()> {
            if self.active_process_count()? == 0 {
                return Ok(());
            }
            if unsafe { TerminateJobObject(self.handle(), HANDOFF_EXIT_CODE) } == 0 {
                return Err(io::Error::last_os_error());
            }
            self.wait_for_empty(timeout)
        }
    }

    impl Drop for BackendJobHandle {
        fn drop(&mut self) {
            if self.handle != 0 {
                unsafe {
                    CloseHandle(self.handle as _);
                }
                self.handle = 0;
            }
        }
    }

    impl ProvisionalTreeLock {
        fn acquire(directory: &Path, timeout: Duration) -> io::Result<Self> {
            let path = directory.join(TREE_LOCK_FILE);
            let file = OpenOptions::new()
                .create(true)
                .truncate(false)
                .read(true)
                .write(true)
                .open(&path)?;
            let deadline = Instant::now() + timeout;
            loop {
                match FileExt::try_lock(&file) {
                    Ok(()) => {
                        return Ok(Self {
                            _file: file,
                            guard_path: directory.join(TREE_GUARD_FILE),
                        });
                    }
                    Err(TryLockError::WouldBlock) if Instant::now() < deadline => {
                        thread::sleep(Duration::from_millis(10));
                    }
                    Err(TryLockError::WouldBlock) => {
                        return Err(io::Error::new(
                            io::ErrorKind::TimedOut,
                            format!(
                                "previous JudgeDesk process tree did not drain before {}",
                                path.display()
                            ),
                        ));
                    }
                    Err(TryLockError::Error(error)) => return Err(error),
                }
            }
        }

        fn release(self) {
            drop(self);
        }

        fn write_generation(&mut self, generation: &str) -> io::Result<()> {
            validate_nonce(generation, "process-tree generation")?;
            let contents = judgedesk_native_executor::tree_guard::generation_contents(generation);
            let mut guard = OpenOptions::new()
                .create(true)
                .truncate(true)
                .write(true)
                .open(&self.guard_path)?;
            guard.seek(SeekFrom::Start(0))?;
            guard.write_all(contents.as_bytes())?;
            guard.sync_all()
        }
    }

    impl BackendTreeGuard {
        pub(super) fn start(
            directory: &Path,
            job_nonce: &str,
            startup_token: &str,
        ) -> io::Result<Self> {
            validate_nonce(startup_token, "supervisor startup token")?;
            let mut provisional = ProvisionalTreeLock::acquire(directory, TREE_RECOVERY_TIMEOUT)?;
            provisional.write_generation(job_nonce)?;
            let job = BackendJob::create(job_nonce)?;
            let failed = Arc::new(AtomicBool::new(false));
            let supervisor = SupervisorProcess::spawn(
                directory,
                job_nonce,
                startup_token,
                job.clone(),
                Arc::clone(&failed),
                provisional,
            )?;
            Ok(Self {
                job,
                supervisor: Mutex::new(Some(supervisor)),
                failed,
                generation_path: Some(directory.join(TREE_GUARD_FILE)),
                generation: Some(job_nonce.to_owned()),
            })
        }

        #[cfg(test)]
        pub(super) fn for_tests(job_nonce: &str) -> io::Result<Self> {
            let job = BackendJob::create(job_nonce)?;
            Ok(Self {
                job,
                supervisor: Mutex::new(None),
                failed: Arc::new(AtomicBool::new(false)),
                generation_path: None,
                generation: None,
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
            self.job.assign(process_id)
        }

        pub(super) fn wait_for_empty(&self, timeout: Duration) -> io::Result<()> {
            self.job.wait_for_empty(timeout)
        }

        pub(super) fn terminate_and_wait(&self, timeout: Duration) -> io::Result<()> {
            self.job.terminate_and_wait(timeout)
        }

        pub(super) fn shutdown(&self, timeout: Duration) -> io::Result<()> {
            self.job.terminate_and_wait(timeout)?;
            let mut supervisor = self
                .supervisor
                .lock()
                .map_err(|_| io::Error::other("process supervisor state is unavailable"))?;
            let Some(process) = supervisor.as_mut() else {
                return self.job.wait_for_empty(timeout);
            };
            process.shutdown(timeout)?;
            supervisor.take();
            Ok(())
        }
    }

    impl SupervisorProcess {
        fn spawn(
            directory: &Path,
            job_nonce: &str,
            token: &str,
            job: BackendJob,
            failed: Arc<AtomicBool>,
            provisional: ProvisionalTreeLock,
        ) -> io::Result<Self> {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            let mut child = Command::new(std::env::current_exe()?)
                .creation_flags(CREATE_NO_WINDOW)
                .arg(INTERNAL_SUPERVISOR_ARGUMENT)
                .env(SUPERVISOR_TOKEN_ENV, token)
                .env(SUPERVISOR_DIRECTORY_ENV, directory)
                .env(SUPERVISOR_JOB_NONCE_ENV, job_nonce)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()?;
            let stdin = child
                .stdin
                .take()
                .ok_or_else(|| io::Error::other("supervisor stdin pipe is unavailable"))?;
            make_handle_non_inheritable(&stdin)?;
            let stdout = child
                .stdout
                .take()
                .ok_or_else(|| io::Error::other("supervisor stdout pipe is unavailable"))?;
            let (frames, reader_thread) = spawn_frame_reader(stdout);
            let child = Arc::new(Mutex::new(child));
            let expected_exit = Arc::new(AtomicBool::new(false));

            provisional.release();
            let expected_ready = ready_frame(token);
            match frames.recv_timeout(START_TIMEOUT) {
                Ok(Ok(frame)) if frame == expected_ready => {}
                Ok(Ok(frame)) => {
                    let _ = job.terminate_and_wait(DRAIN_TIMEOUT);
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!(
                            "process supervisor returned an invalid READY frame: {}",
                            String::from_utf8_lossy(&frame)
                        ),
                    ));
                }
                Ok(Err(error)) => {
                    let _ = job.terminate_and_wait(DRAIN_TIMEOUT);
                    return Err(error);
                }
                Err(error) => {
                    let _ = job.terminate_and_wait(DRAIN_TIMEOUT);
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
                job,
                directory.to_owned(),
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

        fn shutdown(&mut self, timeout: Duration) -> io::Result<()> {
            if self.failed.load(Ordering::Acquire) {
                return Err(io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "JudgeDesk process supervisor exited unexpectedly",
                ));
            }
            self.expected_exit.store(true, Ordering::Release);
            let frame = drain_frame(&self.token);
            let stdin = self.stdin.as_mut().ok_or_else(|| {
                io::Error::new(io::ErrorKind::BrokenPipe, "supervisor stdin closed")
            })?;
            stdin.write_all(&frame)?;
            stdin.flush()?;

            let expected_drained = drained_frame(&self.token);
            match self.frames.recv_timeout(timeout) {
                Ok(Ok(frame)) if frame == expected_drained => {}
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
        job: BackendJob,
        directory: PathBuf,
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
                    Ok(Some(_)) => {
                        failed.store(true, Ordering::Release);
                        recover_after_supervisor_exit(&directory, &job);
                        break;
                    }
                    Err(error) => {
                        eprintln!("JudgeDesk process supervisor monitoring failed: {error}");
                        failed.store(true, Ordering::Release);
                        recover_after_supervisor_exit(&directory, &job);
                        break;
                    }
                }
                thread::sleep(Duration::from_millis(25));
            })
            .expect("spawn process supervisor monitor")
    }

    fn recover_after_supervisor_exit(directory: &Path, job: &BackendJob) {
        let recovery_lock = loop {
            match ProvisionalTreeLock::acquire(directory, TREE_RECOVERY_TIMEOUT) {
                Ok(tree_lock) => break tree_lock,
                Err(error) => {
                    eprintln!(
                        "JudgeDesk could not recover the process-tree barrier after its supervisor exited: {error}"
                    );
                    thread::sleep(Duration::from_millis(100));
                }
            }
        };
        loop {
            match job.terminate_and_wait(DRAIN_TIMEOUT) {
                Ok(()) => break,
                Err(error) => {
                    eprintln!(
                        "JudgeDesk is retaining the process-tree barrier after supervisor failure: {error}"
                    );
                    thread::sleep(Duration::from_millis(100));
                }
            }
        }
        recovery_lock.release();
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
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn make_handle_non_inheritable(stdin: &ChildStdin) -> io::Result<()> {
        let handle = stdin.as_raw_handle() as windows_sys::Win32::Foundation::HANDLE;
        if unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0) } == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    fn open_tree_lock(directory: &Path) -> io::Result<File> {
        OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(directory.join(TREE_LOCK_FILE))
    }

    fn supervisor_main() -> io::Result<()> {
        let token = std::env::var(SUPERVISOR_TOKEN_ENV).map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "process supervisor token is missing",
            )
        })?;
        validate_nonce(&token, "process supervisor token")?;
        let directory =
            PathBuf::from(std::env::var_os(SUPERVISOR_DIRECTORY_ENV).ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "process supervisor directory is missing",
                )
            })?);
        let job_nonce = std::env::var(SUPERVISOR_JOB_NONCE_ENV).map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "process supervisor Job nonce is missing",
            )
        })?;
        let job = BackendJob::open(&job_nonce)?;
        let tree_lock = open_tree_lock(&directory)?;
        let request_receiver = spawn_supervisor_request_reader();
        loop {
            match FileExt::try_lock(&tree_lock) {
                Ok(()) => break,
                Err(TryLockError::WouldBlock) => match request_receiver.try_recv() {
                    Ok(_) | Err(mpsc::TryRecvError::Disconnected) => {
                        drain_until_empty(&job);
                        return Ok(());
                    }
                    Err(mpsc::TryRecvError::Empty) => {
                        thread::sleep(Duration::from_millis(10));
                    }
                },
                Err(TryLockError::Error(error)) => return Err(error),
            }
        }
        match request_receiver.try_recv() {
            Ok(_) | Err(mpsc::TryRecvError::Disconnected) => {
                drain_until_empty(&job);
                FileExt::unlock(&tree_lock)?;
                return Ok(());
            }
            Err(mpsc::TryRecvError::Empty) => {}
        }

        let mut output = io::stdout().lock();
        if output.write_all(&ready_frame(&token)).is_err() || output.flush().is_err() {
            drain_until_empty(&job);
            return Ok(());
        }

        let expected_drain = drain_frame(&token);
        let clean_request =
            matches!(request_receiver.recv(), Ok(Ok(request)) if request == expected_drain);

        drain_until_empty(&job);
        if clean_request {
            let _ = output.write_all(&drained_frame(&token));
            let _ = output.flush();
        }
        FileExt::unlock(&tree_lock)?;
        Ok(())
    }

    fn spawn_supervisor_request_reader() -> mpsc::Receiver<io::Result<Vec<u8>>> {
        let (sender, receiver) = mpsc::sync_channel(1);
        thread::Builder::new()
            .name("judgedesk-supervisor-control".into())
            .spawn(move || {
                let mut request = Vec::new();
                let mut input = BufReader::new(io::stdin().lock());
                let read_result = input
                    .by_ref()
                    .take(MAX_FRAME_BYTES + 1)
                    .read_until(b'\n', &mut request);
                let result = match read_result {
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
                let _ = sender.send(result);
            })
            .expect("spawn process supervisor control reader");
        receiver
    }

    fn drain_until_empty(job: &BackendJob) {
        loop {
            if job.terminate_and_wait(DRAIN_TIMEOUT).is_ok() {
                return;
            }
            thread::sleep(Duration::from_millis(100));
        }
    }

    fn backend_job_name(nonce: &str) -> Vec<u16> {
        OsStr::new(&format!("Local\\JudgeDesk.Backend.{nonce}"))
            .encode_wide()
            .chain(Some(0))
            .collect()
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

    fn ready_frame(token: &str) -> Vec<u8> {
        format!("JUDGEDESK_SUPERVISOR/1 READY {token}\n").into_bytes()
    }

    fn drain_frame(token: &str) -> Vec<u8> {
        format!("JUDGEDESK_SUPERVISOR/1 DRAIN {token}\n").into_bytes()
    }

    fn drained_frame(token: &str) -> Vec<u8> {
        format!("JUDGEDESK_SUPERVISOR/1 DRAINED {token}\n").into_bytes()
    }

    pub(super) fn try_run_internal_mode() -> Option<i32> {
        if std::env::args_os().nth(1).as_deref() != Some(OsStr::new(INTERNAL_SUPERVISOR_ARGUMENT)) {
            return None;
        }
        if std::env::args_os().nth(2).is_some() {
            return Some(64);
        }
        Some(if supervisor_main().is_ok() { 0 } else { 70 })
    }

    #[cfg(test)]
    mod tests {
        use super::{ProvisionalTreeLock, TREE_GUARD_FILE, TREE_LOCK_FILE};
        use fs4::FileExt;
        use judgedesk_native_executor::tree_guard::generation_contents;
        use std::fs::{self, OpenOptions};
        use std::os::windows::io::AsRawHandle;
        use std::sync::atomic::{AtomicU64, Ordering};
        use std::time::Duration;
        use windows_sys::Win32::Storage::FileSystem::{
            LockFileEx, UnlockFileEx, LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY,
        };

        static NEXT_DIRECTORY: AtomicU64 = AtomicU64::new(0);
        const GENERATION: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

        #[test]
        fn provisional_tree_lock_publishes_the_runtime_guard_contract() {
            let suffix = NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed);
            let directory = std::env::temp_dir().join(format!(
                "judgedesk-process-supervisor-test-{}-{suffix}",
                std::process::id()
            ));
            fs::create_dir(&directory).expect("create test directory");
            let mut lock = ProvisionalTreeLock::acquire(&directory, Duration::from_secs(1))
                .expect("acquire provisional lock");
            lock.write_generation(GENERATION)
                .expect("write runtime guard contract");
            lock.release();

            assert_eq!(
                fs::read_to_string(directory.join(TREE_GUARD_FILE)).expect("read runtime guard"),
                generation_contents(GENERATION)
            );

            let owner = OpenOptions::new()
                .read(true)
                .write(true)
                .open(directory.join(TREE_LOCK_FILE))
                .expect("open supervisor owner lock");
            owner.try_lock().expect("lock supervisor owner barrier");
            let guard = OpenOptions::new()
                .read(true)
                .write(true)
                .open(directory.join(TREE_GUARD_FILE))
                .expect("open executor generation guard");
            // SAFETY: `guard` owns a valid handle for the complete synchronous byte-range lock.
            let mut overlapped = unsafe { std::mem::zeroed() };
            // SAFETY: the handle, one-byte range, and zeroed OVERLAPPED are valid for LockFileEx.
            let locked = unsafe {
                LockFileEx(
                    guard.as_raw_handle() as _,
                    LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
                    0,
                    1,
                    0,
                    &mut overlapped,
                )
            } != 0;
            assert!(
                locked,
                "executor guard must not conflict with supervisor owner barrier"
            );
            // SAFETY: unlock uses the identical live handle, byte range, and OVERLAPPED value.
            unsafe {
                UnlockFileEx(guard.as_raw_handle() as _, 0, 1, 0, &mut overlapped);
            }
            FileExt::unlock(&owner).expect("unlock supervisor owner barrier");

            fs::remove_dir_all(directory).expect("remove test directory");
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[path = "process_supervisor_macos.rs"]
mod macos;

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
mod portable {
    use std::io;
    use std::path::{Path, PathBuf};
    use std::time::Duration;

    #[derive(Debug)]
    pub(super) struct BackendTreeGuard;

    impl BackendTreeGuard {
        pub(super) fn start(
            _directory: &Path,
            _job_nonce: &str,
            _startup_token: &str,
        ) -> io::Result<Self> {
            Ok(Self)
        }

        #[cfg(test)]
        pub(super) fn for_tests(_job_nonce: &str) -> io::Result<Self> {
            Ok(Self)
        }

        pub(super) fn runtime_environment(&self) -> Option<(PathBuf, String)> {
            None
        }

        pub(super) fn assign_backend(&self, _process_id: u32) -> io::Result<()> {
            Ok(())
        }

        pub(super) fn wait_for_empty(&self, _timeout: Duration) -> io::Result<()> {
            Ok(())
        }

        pub(super) fn terminate_and_wait(&self, _timeout: Duration) -> io::Result<()> {
            Ok(())
        }

        pub(super) fn shutdown(&self, _timeout: Duration) -> io::Result<()> {
            Ok(())
        }
    }

    pub(super) fn try_run_internal_mode() -> Option<i32> {
        (std::env::args_os().nth(1).as_deref()
            == Some(std::ffi::OsStr::new(super::INTERNAL_SUPERVISOR_ARGUMENT)))
        .then_some(70)
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
use macos as platform;
#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
use portable as platform;
#[cfg(windows)]
use windows as platform;

#[derive(Debug)]
pub(crate) struct BackendTreeGuard(platform::BackendTreeGuard);

impl BackendTreeGuard {
    #[cfg_attr(
        test,
        allow(dead_code, reason = "unit tests use the in-process Job-only guard")
    )]
    pub(crate) fn start(
        directory: &Path,
        job_nonce: &str,
        startup_token: &str,
    ) -> io::Result<Self> {
        platform::BackendTreeGuard::start(directory, job_nonce, startup_token).map(Self)
    }

    #[cfg(test)]
    pub(crate) fn for_tests(job_nonce: &str) -> io::Result<Self> {
        platform::BackendTreeGuard::for_tests(job_nonce).map(Self)
    }

    pub(crate) fn assign_backend(&self, process_id: u32) -> io::Result<()> {
        self.0.assign_backend(process_id)
    }

    pub(crate) fn runtime_environment(&self) -> Option<(PathBuf, String)> {
        self.0.runtime_environment()
    }

    pub(crate) fn wait_for_empty(&self, timeout: Duration) -> io::Result<()> {
        self.0.wait_for_empty(timeout)
    }

    pub(crate) fn terminate_and_wait(&self, timeout: Duration) -> io::Result<()> {
        self.0.terminate_and_wait(timeout)
    }

    pub(crate) fn shutdown(&self, timeout: Duration) -> io::Result<()> {
        self.0.shutdown(timeout)
    }
}

pub fn try_run_internal_mode() -> Option<i32> {
    platform::try_run_internal_mode()
}
