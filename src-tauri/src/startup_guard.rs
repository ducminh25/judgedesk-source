use crate::process_supervisor::BackendTreeGuard;
use fs4::{FileExt, TryLockError};
use std::fmt::Write as _;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tauri::Manager;

const ACTIVATION_METADATA_FILE: &str = "activation";
const ACTIVATION_METADATA_HEADER: &str = "JUDGEDESK_ACTIVATION/2";
const ACTIVATION_REQUEST_PREFIX: &str = "JUDGEDESK_ACTIVATE/1 ";
const ACTIVATION_ACK: &[u8] = b"OK\n";
const MAX_ACTIVATION_BYTES: u64 = 4096;
const ACTIVATION_CLIENT_IO_TIMEOUT: Duration = Duration::from_secs(3);
const ACTIVATION_SERVER_IO_TIMEOUT: Duration = Duration::from_millis(500);
const ACTIVATION_FOCUS_TIMEOUT: Duration = Duration::from_secs(2);
const ACTIVATION_RETRY_INTERVAL: Duration = Duration::from_millis(25);
#[cfg(not(test))]
const ACTIVATION_RECOVERY_TIMEOUT: Duration = Duration::from_secs(30);
#[cfg(test)]
const ACTIVATION_RECOVERY_TIMEOUT: Duration = Duration::from_millis(250);
const ACTIVATION_WORKER_COUNT: usize = 4;
const ACTIVATION_QUEUE_CAPACITY: usize = 8;
const BACKEND_DRAIN_TIMEOUT: Duration = Duration::from_secs(10);
const ACTIVATION_STARTING: u8 = 0;
const ACTIVATION_READY: u8 = 1;
const ACTIVATION_DRAINING: u8 = 2;

type ActivationCallback = dyn Fn(Option<String>) -> io::Result<()> + Send + Sync + 'static;

struct ActivationTarget {
    callback: Mutex<Option<Arc<ActivationCallback>>>,
    acknowledgement: Mutex<()>,
    state: AtomicU8,
}

impl Default for ActivationTarget {
    fn default() -> Self {
        Self {
            callback: Mutex::new(None),
            acknowledgement: Mutex::new(()),
            state: AtomicU8::new(ACTIVATION_STARTING),
        }
    }
}

impl ActivationTarget {
    fn request(&self, file_path: Option<String>) -> io::Result<()> {
        if self.state.load(Ordering::Acquire) != ACTIVATION_READY {
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "primary window is not accepting activation requests",
            ));
        }
        let callback = self
            .callback
            .lock()
            .map_err(|_| io::Error::other("activation target state is unavailable"))?
            .clone()
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::WouldBlock,
                    "primary window is not ready for activation",
                )
            })?;
        callback(file_path)
    }

    fn acknowledge(&self, output: &mut impl Write) -> io::Result<()> {
        let _acknowledgement = self
            .acknowledgement
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if self.state.load(Ordering::Acquire) != ACTIVATION_READY {
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "primary started draining before activation was acknowledged",
            ));
        }
        output.write_all(ACTIVATION_ACK)
    }

    fn install(&self, callback: Arc<ActivationCallback>) -> io::Result<()> {
        let _acknowledgement = self
            .acknowledgement
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut installed = self
            .callback
            .lock()
            .map_err(|_| io::Error::other("activation target state is unavailable"))?;
        if self.state.load(Ordering::Acquire) != ACTIVATION_STARTING {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "primary activation target was already initialized",
            ));
        }
        *installed = Some(callback);
        self.state.store(ACTIVATION_READY, Ordering::Release);
        Ok(())
    }

    fn clear(&self) {
        let _acknowledgement = self
            .acknowledgement
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.state.store(ACTIVATION_DRAINING, Ordering::Release);
        if let Ok(mut callback) = self.callback.lock() {
            callback.take();
        }
    }
}

struct ActivationServer {
    metadata_path: PathBuf,
    nonce: String,
    target: Arc<ActivationTarget>,
    shutdown: Arc<AtomicBool>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

pub(crate) struct InstanceCoordinator {
    lease: Mutex<Option<File>>,
    activation: ActivationServer,
    backend_job_nonce: String,
    backend_tree: BackendTreeGuard,
}

#[derive(Debug)]
pub(crate) enum SecondaryOutcome {
    Activated,
    ActivationFailed(String),
}

// This one-shot startup result exists only until Tauri is built. Keeping the
// coordinator inline avoids boxing the exact state later managed by Tauri.
#[allow(clippy::large_enum_variant)]
pub(crate) enum AcquireOutcome {
    Primary(InstanceCoordinator),
    Secondary(SecondaryOutcome),
}

impl std::fmt::Debug for InstanceCoordinator {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("InstanceCoordinator")
            .field("activation_metadata", &self.activation.metadata_path)
            .finish_non_exhaustive()
    }
}

impl std::fmt::Debug for AcquireOutcome {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Primary(coordinator) => {
                formatter.debug_tuple("Primary").field(coordinator).finish()
            }
            Self::Secondary(outcome) => formatter.debug_tuple("Secondary").field(outcome).finish(),
        }
    }
}

#[derive(Debug)]
struct ActivationMetadata {
    owner_pid: u32,
    port: u16,
    nonce: String,
    backend_job_nonce: String,
}

fn open_lease(directory: &Path) -> io::Result<File> {
    OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(directory.join("instance.lock"))
}

fn create_nonce() -> io::Result<String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|error| {
        io::Error::other(format!("activation nonce generation failed: {error}"))
    })?;
    let mut nonce = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(&mut nonce, "{byte:02x}").expect("writing to a String cannot fail");
    }
    Ok(nonce)
}

pub(crate) fn create_backend_startup_token() -> io::Result<String> {
    create_nonce()
}

fn nonce_is_valid(nonce: &str) -> bool {
    nonce.len() == 64
        && nonce
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(windows)]
fn replace_metadata_file(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source_wide: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination_wide: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let moved = unsafe {
        MoveFileExW(
            source_wide.as_ptr(),
            destination_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_metadata_file(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)
}

fn write_activation_metadata(path: &Path, metadata: &ActivationMetadata) -> io::Result<()> {
    let contents = format!(
        "{ACTIVATION_METADATA_HEADER}\npid={}\nport={}\nnonce={}\nbackend_job_nonce={}\ntree_guard_protocol=1\n",
        metadata.owner_pid, metadata.port, metadata.nonce, metadata.backend_job_nonce
    );
    if contents.len() as u64 > MAX_ACTIVATION_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "activation metadata exceeds its size limit",
        ));
    }

    let temporary_path =
        path.with_file_name(format!("{ACTIVATION_METADATA_FILE}.{}.tmp", metadata.nonce));
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary_path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    file.write_all(contents.as_bytes())?;
    file.sync_all()?;
    drop(file);

    let replace_result = replace_metadata_file(&temporary_path, path);
    if replace_result.is_err() {
        let _ = fs::remove_file(&temporary_path);
    }
    replace_result
}

fn parse_key_value<'a>(line: &'a str, key: &str) -> io::Result<&'a str> {
    line.strip_prefix(key).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("activation metadata is missing {key}"),
        )
    })
}

fn read_activation_metadata(path: &Path) -> io::Result<ActivationMetadata> {
    if fs::metadata(path)?.len() > MAX_ACTIVATION_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "activation metadata exceeds its size limit",
        ));
    }
    let contents = fs::read_to_string(path)?;
    let mut lines = contents.lines();
    if lines.next() != Some(ACTIVATION_METADATA_HEADER) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "activation metadata has an unsupported header",
        ));
    }
    let owner_pid = parse_key_value(lines.next().unwrap_or_default(), "pid=")?
        .parse::<u32>()
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid activation owner PID"))?;
    let port = parse_key_value(lines.next().unwrap_or_default(), "port=")?
        .parse::<u16>()
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid activation port"))?;
    let nonce = parse_key_value(lines.next().unwrap_or_default(), "nonce=")?.to_owned();
    let backend_job_nonce =
        parse_key_value(lines.next().unwrap_or_default(), "backend_job_nonce=")?.to_owned();
    let tree_guard_protocol =
        parse_key_value(lines.next().unwrap_or_default(), "tree_guard_protocol=")?;
    if owner_pid == 0
        || port == 0
        || !nonce_is_valid(&nonce)
        || !nonce_is_valid(&backend_job_nonce)
        || tree_guard_protocol != "1"
        || lines.next().is_some()
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "activation metadata fields are invalid",
        ));
    }
    Ok(ActivationMetadata {
        owner_pid,
        port,
        nonce,
        backend_job_nonce,
    })
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

fn handle_activation_connection(
    mut stream: TcpStream,
    nonce: &str,
    target: &ActivationTarget,
) -> io::Result<()> {
    stream.set_read_timeout(Some(ACTIVATION_SERVER_IO_TIMEOUT))?;
    stream.set_write_timeout(Some(ACTIVATION_SERVER_IO_TIMEOUT))?;
    let mut request = Vec::new();
    let mut reader = BufReader::new(stream.try_clone()?);
    reader
        .by_ref()
        .take(MAX_ACTIVATION_BYTES + 1)
        .read_until(b'\n', &mut request)?;
    if request.len() as u64 > MAX_ACTIVATION_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "invalid activation request: payload exceeds limit",
        ));
    }
    let request_str = String::from_utf8(request).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid UTF-8 in activation request",
        )
    })?;
    let trimmed = request_str.trim_end_matches(&['\r', '\n'][..]);
    let without_prefix = trimmed
        .strip_prefix(ACTIVATION_REQUEST_PREFIX)
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::PermissionDenied,
                "invalid activation request prefix",
            )
        })?;
    let (req_nonce, file_path) = match without_prefix.split_once(' ') {
        Some((n, p)) => {
            let clean_p = p.trim();
            let clean_p = clean_p
                .strip_prefix('"')
                .and_then(|s| s.strip_suffix('"'))
                .unwrap_or(clean_p);
            (
                n,
                if clean_p.is_empty() {
                    None
                } else {
                    Some(clean_p.to_string())
                },
            )
        }
        None => (without_prefix, None),
    };
    if !constant_time_eq(req_nonce.as_bytes(), nonce.as_bytes()) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "invalid activation request nonce",
        ));
    }
    target.request(file_path)?;
    target.acknowledge(&mut stream)
}

fn activation_listener_loop(
    listener: TcpListener,
    nonce: String,
    target: Arc<ActivationTarget>,
    shutdown: Arc<AtomicBool>,
) {
    let (sender, receiver) = mpsc::sync_channel::<TcpStream>(ACTIVATION_QUEUE_CAPACITY);
    let receiver = Arc::new(Mutex::new(receiver));
    let mut workers = Vec::with_capacity(ACTIVATION_WORKER_COUNT);
    for index in 0..ACTIVATION_WORKER_COUNT {
        let worker_receiver = Arc::clone(&receiver);
        let worker_nonce = nonce.clone();
        let worker_target = Arc::clone(&target);
        match thread::Builder::new()
            .name(format!("judgedesk-activation-{index}"))
            .spawn(move || loop {
                let stream = {
                    let Ok(receiver) = worker_receiver.lock() else {
                        return;
                    };
                    receiver.recv()
                };
                let Ok(stream) = stream else {
                    return;
                };
                let _ = handle_activation_connection(stream, &worker_nonce, &worker_target);
            }) {
            Ok(worker) => workers.push(worker),
            Err(error) => {
                eprintln!("JudgeDesk activation worker could not start: {error}");
            }
        }
    }
    if workers.is_empty() {
        eprintln!("JudgeDesk activation listener has no available workers");
        return;
    }

    while !shutdown.load(Ordering::Acquire) {
        match listener.accept() {
            Ok((stream, peer)) => {
                if peer.ip().is_loopback() {
                    let _ = sender.try_send(stream);
                }
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(10));
            }
            Err(error) => {
                eprintln!("JudgeDesk activation listener stopped: {error}");
                break;
            }
        }
    }
    drop(sender);
    for worker in workers {
        let _ = worker.join();
    }
}

fn start_primary(file: File, directory: &Path) -> io::Result<AcquireOutcome> {
    let backend_job_nonce = create_nonce()?;
    #[cfg(not(test))]
    let supervisor_token = create_nonce()?;
    #[cfg(not(test))]
    let backend_tree = BackendTreeGuard::start(directory, &backend_job_nonce, &supervisor_token)?;
    #[cfg(test)]
    let backend_tree = BackendTreeGuard::for_tests(&backend_job_nonce)?;

    let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))?;
    listener.set_nonblocking(true)?;
    let port = listener.local_addr()?.port();
    let nonce = create_nonce()?;
    let metadata_path = directory.join(ACTIVATION_METADATA_FILE);
    write_activation_metadata(
        &metadata_path,
        &ActivationMetadata {
            owner_pid: std::process::id(),
            port,
            nonce: nonce.clone(),
            backend_job_nonce: backend_job_nonce.clone(),
        },
    )?;

    let target = Arc::new(ActivationTarget::default());
    let shutdown = Arc::new(AtomicBool::new(false));
    let thread_target = Arc::clone(&target);
    let thread_shutdown = Arc::clone(&shutdown);
    let thread_nonce = nonce.clone();
    let activation_thread = thread::Builder::new()
        .name("judgedesk-activation".into())
        .spawn(move || {
            activation_listener_loop(listener, thread_nonce, thread_target, thread_shutdown)
        })?;

    Ok(AcquireOutcome::Primary(InstanceCoordinator {
        lease: Mutex::new(Some(file)),
        activation: ActivationServer {
            metadata_path,
            nonce,
            target,
            shutdown,
            thread: Mutex::new(Some(activation_thread)),
        },
        backend_job_nonce,
        backend_tree,
    }))
}

#[cfg(windows)]
fn allow_primary_foreground(owner_pid: u32) {
    use windows_sys::Win32::UI::WindowsAndMessaging::AllowSetForegroundWindow;

    unsafe {
        AllowSetForegroundWindow(owner_pid);
    }
}

#[cfg(not(windows))]
fn allow_primary_foreground(_owner_pid: u32) {}

fn notify_primary_once(metadata_path: &Path, file_path: Option<&str>) -> io::Result<()> {
    let metadata = read_activation_metadata(metadata_path)?;
    allow_primary_foreground(metadata.owner_pid);
    let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, metadata.port).into();
    let mut stream = TcpStream::connect_timeout(&address, ACTIVATION_CLIENT_IO_TIMEOUT)?;
    stream.set_read_timeout(Some(ACTIVATION_CLIENT_IO_TIMEOUT))?;
    stream.set_write_timeout(Some(ACTIVATION_CLIENT_IO_TIMEOUT))?;
    let message = match file_path {
        Some(path) => format!("{ACTIVATION_REQUEST_PREFIX}{} {}\n", metadata.nonce, path),
        None => format!("{ACTIVATION_REQUEST_PREFIX}{}\n", metadata.nonce),
    };
    stream.write_all(message.as_bytes())?;
    let mut acknowledgement = [0_u8; ACTIVATION_ACK.len()];
    stream.read_exact(&mut acknowledgement)?;
    if acknowledgement != ACTIVATION_ACK {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "primary returned an invalid activation acknowledgement",
        ));
    }
    Ok(())
}

fn acquire_in_directory_with_timeout(
    directory: &Path,
    recovery_timeout: Duration,
    file_path: Option<&str>,
) -> io::Result<AcquireOutcome> {
    fs::create_dir_all(directory)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700))?;
    }
    let file = open_lease(directory)?;
    let metadata_path = directory.join(ACTIVATION_METADATA_FILE);
    let deadline = Instant::now() + recovery_timeout;
    loop {
        match FileExt::try_lock(&file) {
            Ok(()) => return start_primary(file, directory),
            Err(TryLockError::WouldBlock) => match notify_primary_once(&metadata_path, file_path) {
                Ok(()) => {
                    return Ok(AcquireOutcome::Secondary(SecondaryOutcome::Activated));
                }
                Err(error) => {
                    if Instant::now() >= deadline {
                        return Ok(AcquireOutcome::Secondary(
                            SecondaryOutcome::ActivationFailed(error.to_string()),
                        ));
                    }
                }
            },
            Err(TryLockError::Error(error)) => return Err(error),
        }
        thread::sleep(ACTIVATION_RETRY_INTERVAL);
    }
}

fn acquire_in_directory(directory: &Path, file_path: Option<&str>) -> io::Result<AcquireOutcome> {
    acquire_in_directory_with_timeout(directory, ACTIVATION_RECOVERY_TIMEOUT, file_path)
}

pub(crate) fn acquire(identifier: &str, file_path: Option<&str>) -> io::Result<AcquireOutcome> {
    let base_directory = dirs::data_local_dir().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            "local application data directory is unavailable",
        )
    })?;
    acquire_in_directory(&base_directory.join(identifier), file_path)
}

impl InstanceCoordinator {
    pub(crate) fn attach(&self, app: tauri::AppHandle) -> io::Result<()> {
        use tauri::Emitter;

        self.activation
            .target
            .install(Arc::new(move |file_path: Option<String>| {
                let (result_sender, result_receiver) = mpsc::sync_channel(1);
                let focus_handle = app.clone();
                app.run_on_main_thread(move || {
                    let focus_result = focus_primary(&focus_handle);
                    if let Some(path) = file_path {
                        let _ = focus_handle.emit("open_contest_file", path);
                    }
                    let _ = result_sender.send(focus_result);
                })
                .map_err(|error| {
                    io::Error::other(format!("failed to schedule JudgeDesk activation: {error}"))
                })?;
                result_receiver
                    .recv_timeout(ACTIVATION_FOCUS_TIMEOUT)
                    .map_err(|error| match error {
                        mpsc::RecvTimeoutError::Timeout => io::Error::new(
                            io::ErrorKind::TimedOut,
                            "primary window focus timed out",
                        ),
                        mpsc::RecvTimeoutError::Disconnected => {
                            io::Error::other("primary window focus task was disconnected")
                        }
                    })?
            }))
    }

    pub(crate) fn begin_shutdown(&self) -> io::Result<()> {
        self.activation.target.clear();
        self.activation.shutdown.store(true, Ordering::Release);
        let thread = self
            .activation
            .thread
            .lock()
            .map_err(|_| io::Error::other("activation listener state is unavailable"))?
            .take();
        if thread.is_some_and(|thread| thread.join().is_err()) {
            return Err(io::Error::other(
                "JudgeDesk activation listener panicked during shutdown",
            ));
        }
        Ok(())
    }

    pub(crate) fn assign_backend(&self, process_id: u32) -> io::Result<()> {
        self.backend_tree.assign_backend(process_id)
    }

    pub(crate) fn backend_tree_environment(&self) -> Option<(PathBuf, String)> {
        self.backend_tree.runtime_environment()
    }

    pub(crate) fn wait_for_backend_tree(&self, timeout: Duration) -> io::Result<()> {
        self.backend_tree.wait_for_empty(timeout)
    }

    pub(crate) fn terminate_backend_tree(&self, timeout: Duration) -> io::Result<()> {
        self.backend_tree.terminate_and_wait(timeout)
    }

    pub(crate) fn shutdown_backend_tree(&self) -> io::Result<()> {
        self.backend_tree.shutdown(BACKEND_DRAIN_TIMEOUT)
    }

    pub(crate) fn release(&self) -> io::Result<()> {
        let mut release_error = self.begin_shutdown().err();
        if let Err(error) = self.shutdown_backend_tree() {
            return Err(io::Error::new(
                error.kind(),
                format!("backend process-tree supervisor did not drain: {error}"),
            ));
        }
        if read_activation_metadata(&self.activation.metadata_path).is_ok_and(|metadata| {
            metadata.nonce == self.activation.nonce
                && metadata.backend_job_nonce == self.backend_job_nonce
        }) {
            match fs::remove_file(&self.activation.metadata_path) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => release_error = Some(error),
            }
        }
        self.lease
            .lock()
            .map_err(|_| io::Error::other("JudgeDesk instance lease state is unavailable"))?
            .take();
        release_error.map_or(Ok(()), Err)
    }
}

impl Drop for InstanceCoordinator {
    fn drop(&mut self) {
        let _ = self.release();
    }
}

pub(crate) fn focus_primary(app: &tauri::AppHandle) -> io::Result<()> {
    #[cfg(target_os = "macos")]
    app.show()
        .map_err(|error| io::Error::other(format!("failed to show JudgeDesk: {error}")))?;
    let window = app.get_webview_window("main").ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            "JudgeDesk main window is unavailable",
        )
    })?;
    window
        .show()
        .map_err(|error| io::Error::other(format!("failed to show JudgeDesk window: {error}")))?;
    window.unminimize().map_err(|error| {
        io::Error::other(format!("failed to restore JudgeDesk window: {error}"))
    })?;
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::SetForegroundWindow;

        let window_handle = window.hwnd().map_err(|error| {
            io::Error::other(format!(
                "failed to resolve JudgeDesk window handle: {error}"
            ))
        })?;
        if unsafe { SetForegroundWindow(window_handle.0) } == 0 {
            let _ = window.request_user_attention(Some(tauri::UserAttentionType::Informational));
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "Windows refused to foreground the JudgeDesk window",
            ));
        }
    }
    #[cfg(not(windows))]
    window
        .set_focus()
        .map_err(|error| io::Error::other(format!("failed to focus JudgeDesk window: {error}")))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        acquire_in_directory, read_activation_metadata, AcquireOutcome, SecondaryOutcome,
        ACTIVATION_METADATA_FILE,
    };
    use std::fs;
    use std::io::{Read, Write};
    use std::net::{Ipv4Addr, SocketAddrV4, TcpStream};
    use std::path::{Path, PathBuf};
    use std::process::{Child, Command, Stdio};
    use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    static TEST_COUNTER: AtomicU64 = AtomicU64::new(0);

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(label: &str) -> Self {
            let suffix = TEST_COUNTER.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "judgedesk-startup-guard-{label}-{}-{suffix}",
                std::process::id()
            ));
            fs::create_dir(&path).expect("create startup guard test directory");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn spawn_guard_child(directory: &Path, result_path: &Path, release_path: &Path) -> Child {
        Command::new(std::env::current_exe().expect("resolve current test executable"))
            .args([
                "--exact",
                "startup_guard::tests::guard_child_process",
                "--ignored",
                "--nocapture",
            ])
            .env("JUDGEDESK_GUARD_TEST_DIRECTORY", directory)
            .env("JUDGEDESK_GUARD_TEST_RESULT", result_path)
            .env("JUDGEDESK_GUARD_TEST_RELEASE", release_path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn startup guard child")
    }

    #[cfg(windows)]
    fn spawn_job_owner(directory: &Path, result_path: &Path) -> Child {
        Command::new(std::env::current_exe().expect("resolve current test executable"))
            .args([
                "--exact",
                "startup_guard::tests::job_owner_process",
                "--ignored",
                "--nocapture",
            ])
            .env("JUDGEDESK_JOB_TEST_DIRECTORY", directory)
            .env("JUDGEDESK_JOB_TEST_RESULT", result_path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn process-tree job owner")
    }

    fn wait_for_result(path: &Path) -> String {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Ok(result) = fs::read_to_string(path) {
                return result;
            }
            assert!(
                Instant::now() < deadline,
                "timed out waiting for guard child result at {}",
                path.display()
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn wait_for_success(child: &mut Child) {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(status) = child.try_wait().expect("query guard child status") {
                assert!(status.success(), "guard child failed with {status}");
                return;
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                panic!("timed out waiting for guard child to exit");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn a_second_lease_is_contended_until_the_first_is_dropped() {
        let directory = TestDirectory::new("contention");
        let first = match acquire_in_directory(directory.path(), None).expect("first acquisition") {
            AcquireOutcome::Primary(lease) => lease,
            AcquireOutcome::Secondary(_) => panic!("first acquisition must not be contended"),
        };

        assert!(matches!(
            acquire_in_directory(directory.path(), None).expect("second acquisition"),
            AcquireOutcome::Secondary(_)
        ));

        drop(first);
        assert!(matches!(
            acquire_in_directory(directory.path(), None).expect("acquisition after drop"),
            AcquireOutcome::Primary(_)
        ));
    }

    #[test]
    fn a_secondary_request_activates_the_primary_and_the_listener_survives_bad_input() {
        let directory = TestDirectory::new("activation");
        let primary =
            match acquire_in_directory(directory.path(), None).expect("primary acquisition") {
                AcquireOutcome::Primary(coordinator) => coordinator,
                AcquireOutcome::Secondary(_) => panic!("first acquisition must be primary"),
            };
        let activations = Arc::new(AtomicUsize::new(0));
        let callback_activations = Arc::clone(&activations);
        primary
            .activation
            .target
            .install(Arc::new(move |_file_path| {
                callback_activations.fetch_add(1, Ordering::AcqRel);
                Ok(())
            }))
            .expect("install activation callback");

        let metadata = read_activation_metadata(&directory.path().join(ACTIVATION_METADATA_FILE))
            .expect("read primary activation metadata");
        let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, metadata.port).into();
        let mut invalid = TcpStream::connect_timeout(&address, Duration::from_secs(1))
            .expect("connect invalid activation client");
        invalid
            .write_all(b"JUDGEDESK_ACTIVATE/1 invalid\n")
            .expect("write invalid activation frame");
        invalid
            .set_read_timeout(Some(Duration::from_secs(1)))
            .expect("set invalid activation read timeout");
        let mut reply = [0_u8; 3];
        assert_ne!(invalid.read(&mut reply).unwrap_or_default(), reply.len());

        assert!(matches!(
            acquire_in_directory(directory.path(), None).expect("secondary acquisition"),
            AcquireOutcome::Secondary(SecondaryOutcome::Activated)
        ));
        let deadline = Instant::now() + Duration::from_secs(1);
        while activations.load(Ordering::Acquire) != 1 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(activations.load(Ordering::Acquire), 1);
    }

    #[test]
    fn a_secondary_request_forwards_the_contest_file_path() {
        let directory = TestDirectory::new("file-activation");
        let primary =
            match acquire_in_directory(directory.path(), None).expect("primary acquisition") {
                AcquireOutcome::Primary(coordinator) => coordinator,
                AcquireOutcome::Secondary(_) => panic!("first acquisition must be primary"),
            };
        let received_path = Arc::new(Mutex::new(None));
        let cb_path = Arc::clone(&received_path);
        primary
            .activation
            .target
            .install(Arc::new(move |file_path| {
                *cb_path.lock().unwrap() = file_path;
                Ok(())
            }))
            .expect("install activation callback");

        assert!(matches!(
            acquire_in_directory(directory.path(), Some(r"C:\Contests\sample.judgedesk"))
                .expect("secondary acquisition"),
            AcquireOutcome::Secondary(SecondaryOutcome::Activated)
        ));
        let deadline = Instant::now() + Duration::from_secs(1);
        while received_path.lock().unwrap().is_none() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(
            received_path.lock().unwrap().as_deref(),
            Some(r"C:\Contests\sample.judgedesk")
        );
    }

    #[test]
    fn activation_is_acknowledged_only_while_the_primary_is_ready() {
        let target = super::ActivationTarget::default();
        let activations = Arc::new(AtomicUsize::new(0));
        let callback_activations = Arc::clone(&activations);

        assert_eq!(
            target
                .request(None)
                .expect_err("starting must not acknowledge")
                .kind(),
            std::io::ErrorKind::WouldBlock
        );
        target
            .install(Arc::new(move |_| {
                callback_activations.fetch_add(1, Ordering::AcqRel);
                Ok(())
            }))
            .expect("install activation callback");
        target.request(None).expect("ready activation");
        let mut acknowledgement = Vec::new();
        target
            .acknowledge(&mut acknowledgement)
            .expect("acknowledge ready activation");
        assert_eq!(acknowledgement, super::ACTIVATION_ACK);
        assert_eq!(activations.load(Ordering::Acquire), 1);

        target.clear();
        assert_eq!(
            target
                .request(None)
                .expect_err("draining must not acknowledge")
                .kind(),
            std::io::ErrorKind::WouldBlock
        );
        let mut draining_acknowledgement = Vec::new();
        assert_eq!(
            target
                .acknowledge(&mut draining_acknowledgement)
                .expect_err("draining must not send an acknowledgement")
                .kind(),
            std::io::ErrorKind::WouldBlock
        );
        assert!(draining_acknowledgement.is_empty());
        assert_eq!(activations.load(Ordering::Acquire), 1);
    }

    #[test]
    fn an_io_failure_is_not_treated_as_lock_contention() {
        let directory = TestDirectory::new("io-error");
        let file_instead_of_directory = directory.path().join("not-a-directory");
        fs::write(&file_instead_of_directory, b"block create_dir_all")
            .expect("create path blocker");

        let error = acquire_in_directory(&file_instead_of_directory, None)
            .expect_err("unexpected I/O failures must fail closed");
        assert_ne!(error.kind(), std::io::ErrorKind::WouldBlock);
    }

    #[test]
    fn the_lease_excludes_other_processes_and_recovers_after_a_crash() {
        let directory = TestDirectory::new("subprocess");
        let first_result = directory.path().join("first.result");
        let second_result = directory.path().join("second.result");
        let recovery_result = directory.path().join("recovery.result");
        let release_path = directory.path().join("release");

        let mut first = spawn_guard_child(directory.path(), &first_result, &release_path);
        assert_eq!(wait_for_result(&first_result), "PRIMARY");

        let mut second = spawn_guard_child(directory.path(), &second_result, &release_path);
        assert_eq!(wait_for_result(&second_result), "SECONDARY");
        wait_for_success(&mut second);

        first.kill().expect("force-stop primary guard child");
        first.wait().expect("reap primary guard child");

        let mut recovery = spawn_guard_child(directory.path(), &recovery_result, &release_path);
        assert_eq!(wait_for_result(&recovery_result), "PRIMARY");
        fs::write(&release_path, b"release").expect("release recovery guard child");
        wait_for_success(&mut recovery);
    }

    #[test]
    #[cfg(windows)]
    fn the_windows_job_terminates_descendants_when_the_primary_crashes() {
        let directory = TestDirectory::new("windows-job");
        let descendant_directory = directory.path().join("descendant");
        let result_path = directory.path().join("descendant.result");
        let mut owner = spawn_job_owner(&descendant_directory, &result_path);
        assert_eq!(wait_for_result(&result_path), "READY");

        owner.kill().expect("force-stop process-tree owner");
        owner.wait().expect("reap process-tree owner");

        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match acquire_in_directory(&descendant_directory, None)
                .expect("probe descendant lifetime lock")
            {
                AcquireOutcome::Primary(_lease) => break,
                AcquireOutcome::Secondary(_) => {
                    assert!(
                        Instant::now() < deadline,
                        "descendant survived after the process-tree owner crashed"
                    );
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
        }
    }

    #[test]
    #[ignore = "subprocess helper invoked by the parent guard test"]
    fn guard_child_process() {
        let Ok(directory) = std::env::var("JUDGEDESK_GUARD_TEST_DIRECTORY") else {
            return;
        };
        let result_path = PathBuf::from(
            std::env::var("JUDGEDESK_GUARD_TEST_RESULT").expect("guard child result path"),
        );
        let release_path = PathBuf::from(
            std::env::var("JUDGEDESK_GUARD_TEST_RELEASE").expect("guard child release path"),
        );

        match acquire_in_directory(Path::new(&directory), None).expect("guard child acquisition") {
            AcquireOutcome::Secondary(_) => {
                fs::write(result_path, b"SECONDARY").expect("write secondary result");
            }
            AcquireOutcome::Primary(_lease) => {
                fs::write(result_path, b"PRIMARY").expect("write primary result");
                let deadline = Instant::now() + Duration::from_secs(15);
                while !release_path.exists() && Instant::now() < deadline {
                    std::thread::sleep(Duration::from_millis(10));
                }
                assert!(release_path.exists(), "guard child release timed out");
            }
        }
    }

    #[test]
    #[cfg(windows)]
    #[ignore = "subprocess helper invoked by the Windows process-tree test"]
    fn job_owner_process() {
        let directory = PathBuf::from(
            std::env::var("JUDGEDESK_JOB_TEST_DIRECTORY").expect("job descendant directory"),
        );
        let result_path = PathBuf::from(
            std::env::var("JUDGEDESK_JOB_TEST_RESULT").expect("job descendant result path"),
        );
        let backend_job = crate::process_supervisor::BackendTreeGuard::for_tests(
            &super::create_nonce().expect("create backend process-tree nonce"),
        )
        .expect("create backend process-tree job");
        let mut descendant =
            Command::new(std::env::current_exe().expect("resolve current test executable"))
                .args([
                    "--exact",
                    "startup_guard::tests::job_descendant_process",
                    "--ignored",
                    "--nocapture",
                ])
                .env("JUDGEDESK_JOB_TEST_DIRECTORY", &directory)
                .env("JUDGEDESK_JOB_TEST_RESULT", &result_path)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("spawn job descendant");
        backend_job
            .assign_backend(descendant.id())
            .expect("assign backend descendant to process-tree job");

        let deadline = Instant::now() + Duration::from_secs(15);
        while Instant::now() < deadline {
            if descendant
                .try_wait()
                .expect("query job descendant")
                .is_some()
            {
                panic!("job descendant exited before its owner");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let _ = descendant.kill();
        let _ = descendant.wait();
        panic!("job owner helper timed out");
    }

    #[test]
    #[cfg(windows)]
    #[ignore = "subprocess helper invoked by the Windows process-tree test"]
    fn job_descendant_process() {
        let directory = PathBuf::from(
            std::env::var("JUDGEDESK_JOB_TEST_DIRECTORY").expect("job descendant directory"),
        );
        let result_path = PathBuf::from(
            std::env::var("JUDGEDESK_JOB_TEST_RESULT").expect("job descendant result path"),
        );
        let _lease = match acquire_in_directory(&directory, None).expect("descendant lifetime lock")
        {
            AcquireOutcome::Primary(lease) => lease,
            AcquireOutcome::Secondary(_) => panic!("descendant lifetime lock was contended"),
        };
        fs::write(result_path, b"READY").expect("write job descendant readiness");
        std::thread::sleep(Duration::from_secs(15));
        panic!("job descendant was not terminated with its owner");
    }
}
