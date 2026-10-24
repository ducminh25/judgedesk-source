use judgedesk_native_executor::protocol::{
    read_frame, ExecutorHealth, ExecutorRequest, ExecutorResponse, InteractiveRunResult,
    InteractiveRunSpec, RunResult, RunSpec, EXECUTOR_VERSION, MAX_FRAME_BYTES,
};
use std::collections::{HashMap, HashSet};
use std::fs::{DirBuilder, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use uuid::Uuid;

const TREE_GUARD_REQUIRED_ENV: &str = "JUDGEDESK_TREE_GUARD_REQUIRED";
const TREE_GUARD_PATH_ENV: &str = "JUDGEDESK_TREE_GUARD_PATH";
const TREE_GUARD_GENERATION_ENV: &str = "JUDGEDESK_TREE_GUARD_GENERATION";
const PARENT_PID_ENV: &str = "JUDGEDESK_PARENT_PID";
const DROP_DRAIN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(25);

#[cfg(target_os = "linux")]
fn prepare_linux_full_executor_base(app_data: &Path) -> std::io::Result<PathBuf> {
    use crate::storage::{
        ensure_no_reparse_or_symlink_chain, validate_existing_directory_path, validate_path_syntax,
    };
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};

    let base = app_data.join("executor-state");
    if !app_data.is_absolute() {
        return Err(std::io::Error::other(
            "Full executor storage requires an absolute data directory",
        ));
    }
    validate_path_syntax(&base).map_err(std::io::Error::other)?;
    ensure_no_reparse_or_symlink_chain(&base, None).map_err(std::io::Error::other)?;
    DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&base)?;
    let base = validate_existing_directory_path(&base).map_err(std::io::Error::other)?;
    let metadata = std::fs::symlink_metadata(&base)?;
    // The executor's large immutable SDK cache must not consume /tmp tmpfs.
    // Use OS ownership/mode checks; never repair permissions on an unknown tree.
    if metadata.uid() != unsafe { libc::geteuid() }
        || metadata.permissions().mode() & 0o777 != 0o700
    {
        return Err(std::io::Error::other(
            "Full executor storage must be owned by the current user with mode 0700",
        ));
    }
    Ok(base)
}

#[cfg(test)]
#[cfg(target_os = "linux")]
mod full_storage_tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};

    #[test]
    fn full_executor_storage_uses_a_private_app_data_directory() {
        let app_data = std::env::temp_dir().join(format!("jd-storage-{}", Uuid::new_v4()));
        let base = prepare_linux_full_executor_base(&app_data).unwrap();
        assert_eq!(base, app_data.join("executor-state"));
        assert_eq!(
            std::fs::metadata(&base).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(prepare_linux_full_executor_base(&app_data).unwrap(), base);
        std::fs::set_permissions(&base, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(prepare_linux_full_executor_base(&app_data).is_err());
        std::fs::remove_dir_all(&app_data).unwrap();
    }

    #[test]
    fn full_executor_storage_rejects_links_and_relative_roots() {
        assert!(prepare_linux_full_executor_base(Path::new("relative")).is_err());
        let root = std::env::temp_dir().join(format!("jd-storage-link-{}", Uuid::new_v4()));
        std::fs::create_dir_all(root.join("data")).unwrap();
        std::fs::create_dir(root.join("outside")).unwrap();
        symlink(root.join("outside"), root.join("data/executor-state")).unwrap();
        assert!(prepare_linux_full_executor_base(&root.join("data")).is_err());
        assert_eq!(std::fs::read_dir(root.join("outside")).unwrap().count(), 0);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TreeGuardContract {
    path: PathBuf,
    generation: String,
}

impl TreeGuardContract {
    pub fn new(path: PathBuf, generation: String) -> std::io::Result<Self> {
        if !path.is_absolute() || !path.is_file() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "tree guard path must name an existing absolute file",
            ));
        }
        if generation.len() != 64 || !generation.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "tree guard generation must contain exactly 64 hexadecimal characters",
            ));
        }
        let expected = format!("JUDGEDESK_PROCESS_TREE/1\ngeneration={generation}\n");
        if std::fs::read(&path)? != expected.as_bytes() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "tree guard file does not match its generation contract",
            ));
        }
        Ok(Self { path, generation })
    }
}

struct PreparedTreeGuard {
    contract: TreeGuardContract,
    owned_dir: Option<PathBuf>,
}

fn create_owned_tree_guard() -> std::io::Result<PreparedTreeGuard> {
    let generation = format!(
        "{:032x}{:032x}",
        Uuid::new_v4().as_u128(),
        Uuid::new_v4().as_u128()
    );
    let guard_dir = std::env::temp_dir().join(format!(
        "judgedesk-guard-{}-{}",
        std::process::id(),
        Uuid::new_v4().simple()
    ));
    #[cfg(unix)]
    let directory = {
        use std::os::unix::fs::DirBuilderExt;
        let mut directory = DirBuilder::new();
        directory.mode(0o700);
        directory
    };
    #[cfg(not(unix))]
    let directory = DirBuilder::new();
    directory.create(&guard_dir)?;
    let guard_file = guard_dir.join("process-tree.guard");
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&guard_file)?;
        file.write_all(format!("JUDGEDESK_PROCESS_TREE/1\ngeneration={generation}\n").as_bytes())?;
        file.sync_all()?;
        let contract = TreeGuardContract::new(guard_file, generation)?;
        Ok(PreparedTreeGuard {
            contract,
            owned_dir: Some(guard_dir.clone()),
        })
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&guard_dir);
    }
    result
}

fn remove_owned_tree_guard(guard_dir: &Option<PathBuf>) {
    if let Some(path) = guard_dir {
        let _ = std::fs::remove_dir_all(path);
    }
}

fn close_child_input(stdin: &Arc<Mutex<Option<std::process::ChildStdin>>>) {
    if let Ok(mut input) = stdin.lock() {
        input.take();
    }
}

fn wait_for_child_exit(child: &Arc<Mutex<Option<Child>>>, timeout: std::time::Duration) -> bool {
    let Ok(mut child_slot) = child.lock() else {
        return false;
    };
    let Some(mut process) = child_slot.take() else {
        return true;
    };
    let started = std::time::Instant::now();
    while started.elapsed() < timeout {
        if matches!(process.try_wait(), Ok(Some(_))) {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    // Retain the OS handle and generation ownership when native drain cannot be proven.
    // Keeping it in the slot also makes later shutdown/drop calls retry the observation rather
    // than treating a prior timeout as an observed exit.
    *child_slot = Some(process);
    false
}

fn cleanup_failed_start(
    child: &Arc<Mutex<Option<Child>>>,
    stdin: &Arc<Mutex<Option<std::process::ChildStdin>>>,
    guard_dir: &Option<PathBuf>,
) {
    close_child_input(stdin);
    if wait_for_child_exit(child, DROP_DRAIN_TIMEOUT) {
        remove_owned_tree_guard(guard_dir);
    }
}

enum ResponseSender {
    Async(tokio::sync::oneshot::Sender<ExecutorResponse>),
    Sync(std::sync::mpsc::SyncSender<ExecutorResponse>),
}

impl ResponseSender {
    fn send(self, resp: ExecutorResponse) {
        match self {
            ResponseSender::Async(tx) => {
                let _ = tx.send(resp);
            }
            ResponseSender::Sync(tx) => {
                let _ = tx.send(resp);
            }
        }
    }
}

struct ActiveRunRegistration {
    run_id: String,
    active_run_ids: Arc<Mutex<HashSet<String>>>,
}

impl Drop for ActiveRunRegistration {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.active_run_ids.lock() {
            guard.remove(&self.run_id);
        }
    }
}

pub struct ExecutorClient {
    request_tx: std::sync::mpsc::SyncSender<(ExecutorRequest, ResponseSender)>,
    cached_health: ExecutorHealth,
    child: Arc<Mutex<Option<Child>>>,
    child_stdin: Arc<Mutex<Option<std::process::ChildStdin>>>,
    guard_dir: Option<PathBuf>,
    admission_closed: Arc<AtomicBool>,
    active_run_ids: Arc<Mutex<HashSet<String>>>,
}

impl std::fmt::Debug for ExecutorClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ExecutorClient")
            .field(
                "admission_closed",
                &self.admission_closed.load(Ordering::SeqCst),
            )
            .field("cached_health", &self.cached_health)
            .finish()
    }
}

impl ExecutorClient {
    pub fn unavailable(diagnostic: &str) -> Self {
        let (request_tx, _) = std::sync::mpsc::sync_channel(1);
        Self {
            request_tx,
            cached_health: ExecutorHealth {
                ready: false,
                mode: "unavailable".into(),
                executor_version: EXECUTOR_VERSION.into(),
                executor_root: String::new(),
                diagnostics: vec![diagnostic.into()],
                network_blocked: false,
                filesystem_isolated: false,
                process_tree_controlled: false,
                memory_limit_supported: false,
                startup_timings: None,
            },
            child: Arc::new(Mutex::new(None)),
            child_stdin: Arc::new(Mutex::new(None)),
            guard_dir: None,
            admission_closed: Arc::new(AtomicBool::new(true)),
            active_run_ids: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    #[cfg(feature = "test-server")]
    pub fn mock_contract_ready(executor_root: PathBuf) -> Self {
        let (request_tx, _) = std::sync::mpsc::sync_channel(1);
        Self {
            request_tx,
            cached_health: ExecutorHealth {
                ready: true,
                mode: "windows-lpac-job".into(),
                executor_version: "1.5.0".into(),
                executor_root: executor_root.to_string_lossy().into_owned(),
                diagnostics: Vec::new(),
                network_blocked: true,
                filesystem_isolated: true,
                process_tree_controlled: true,
                memory_limit_supported: true,
                startup_timings: None,
            },
            child: Arc::new(Mutex::new(None)),
            child_stdin: Arc::new(Mutex::new(None)),
            guard_dir: None,
            admission_closed: Arc::new(AtomicBool::new(true)),
            active_run_ids: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    pub fn is_admission_closed(&self) -> bool {
        self.admission_closed.load(Ordering::SeqCst)
    }

    pub fn process_id(&self) -> Option<u32> {
        self.child
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().map(std::process::Child::id))
    }

    pub fn spawn_sync(exe_path: &Path) -> std::io::Result<Self> {
        Self::spawn_sync_with_args(exe_path, &[])
    }

    pub fn spawn_sync_with_args(exe_path: &Path, args: &[&str]) -> std::io::Result<Self> {
        Self::spawn_sync_with_args_and_env(exe_path, args, &[])
    }

    pub fn spawn_sync_with_env(
        exe_path: &Path,
        envs: &[(&str, &std::ffi::OsStr)],
    ) -> std::io::Result<Self> {
        Self::spawn_sync_with_args_and_env(exe_path, &[], envs)
    }

    pub fn spawn_sync_with_args_and_env(
        exe_path: &Path,
        args: &[&str],
        envs: &[(&str, &std::ffi::OsStr)],
    ) -> std::io::Result<Self> {
        Self::spawn_sync_with_prepared_guard(exe_path, args, envs, create_owned_tree_guard()?)
    }

    pub fn spawn_sync_with_tree_guard(
        exe_path: &Path,
        guard: TreeGuardContract,
    ) -> std::io::Result<Self> {
        Self::spawn_sync_with_tree_guard_and_env(exe_path, guard, &[])
    }

    pub fn spawn_sync_with_tree_guard_and_env(
        exe_path: &Path,
        guard: TreeGuardContract,
        envs: &[(&str, &std::ffi::OsStr)],
    ) -> std::io::Result<Self> {
        let guard = TreeGuardContract::new(guard.path, guard.generation)?;
        Self::spawn_sync_with_prepared_guard(
            exe_path,
            &[],
            envs,
            PreparedTreeGuard {
                contract: guard,
                owned_dir: None,
            },
        )
    }

    fn spawn_sync_with_prepared_guard(
        exe_path: &Path,
        args: &[&str],
        envs: &[(&str, &std::ffi::OsStr)],
        guard: PreparedTreeGuard,
    ) -> std::io::Result<Self> {
        if !exe_path.is_file() {
            remove_owned_tree_guard(&guard.owned_dir);
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("executor binary not found at {}", exe_path.display()),
            ));
        }

        let mut cmd = Command::new(exe_path);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        for (k, v) in envs {
            cmd.env(k, v);
        }
        #[cfg(target_os = "linux")]
        if crate::toolchains::package_trust::is_linux_full_build() {
            let app_data = crate::toolchains::discovery::app_data_dir_from_env(|name| {
                match cmd.get_envs().find(|(key, _)| *key == name) {
                    Some((_, value)) => value.and_then(|value| value.to_str().map(str::to_owned)),
                    None => std::env::var(name).ok(),
                }
            });
            let base = prepare_linux_full_executor_base(&app_data)
                .inspect_err(|_| remove_owned_tree_guard(&guard.owned_dir))?;
            // This override belongs to this child only; host helpers and the UI
            // retain the user's environment. Native root validation still applies.
            cmd.env("TMPDIR", base);
        }
        // AppImage libraries belong to the GUI. The native executor and its
        // system helpers (busctl/bwrap) must load the host's matching libraries.
        #[cfg(target_os = "linux")]
        cmd.env_remove("LD_LIBRARY_PATH").env_remove("LD_PRELOAD");
        cmd.args(args)
            .env(PARENT_PID_ENV, std::process::id().to_string())
            .env(TREE_GUARD_REQUIRED_ENV, "1")
            .env(TREE_GUARD_PATH_ENV, &guard.contract.path)
            .env(TREE_GUARD_GENERATION_ENV, &guard.contract.generation);
        let mut child = cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .inspect_err(|_| {
                remove_owned_tree_guard(&guard.owned_dir);
            })?;

        let stdin = match child.stdin.take() {
            Some(stdin) => stdin,
            None => {
                // We cannot signal ordered EOF without this pipe. Keep both the child
                // handle and owned guard alive rather than falsely releasing generation
                // ownership while the executor may still be running.
                std::mem::forget(child);
                return Err(std::io::Error::other("failed to open child stdin"));
            }
        };
        let mut stdout = match child.stdout.take() {
            Some(stdout) => stdout,
            None => {
                drop(stdin);
                let child = Arc::new(Mutex::new(Some(child)));
                let closed_stdin = Arc::new(Mutex::new(None));
                cleanup_failed_start(&child, &closed_stdin, &guard.owned_dir);
                return Err(std::io::Error::other("failed to open child stdout"));
            }
        };
        let stdin_shared = Arc::new(Mutex::new(Some(stdin)));

        let (request_tx, request_rx) =
            std::sync::mpsc::sync_channel::<(ExecutorRequest, ResponseSender)>(128);
        let pending_requests: Arc<Mutex<HashMap<String, ResponseSender>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let admission_closed = Arc::new(AtomicBool::new(false));

        let child_shared = Arc::new(Mutex::new(Some(child)));

        let pending_writer = Arc::clone(&pending_requests);
        let admission_closed_writer = Arc::clone(&admission_closed);
        let stdin_writer = Arc::clone(&stdin_shared);
        thread::Builder::new()
            .name("executor-client-writer".into())
            .spawn(move || {
                while let Ok((req, reply_tx)) = request_rx.recv() {
                    let id = req.id().to_string();
                    if admission_closed_writer.load(Ordering::SeqCst)
                        && !matches!(req, ExecutorRequest::Shutdown { .. })
                    {
                        reply_tx.send(ExecutorResponse::Error {
                            id,
                            code: "SECURE_RUNNER_UNAVAILABLE".into(),
                            message: "executor admission closed".into(),
                        });
                        continue;
                    }
                    pending_writer
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .insert(id.clone(), reply_tx);
                    let payload = match serde_json::to_vec(&req) {
                        Ok(p) => p,
                        Err(e) => {
                            if let Some(sender) = pending_writer
                                .lock()
                                .unwrap_or_else(|p| p.into_inner())
                                .remove(&id)
                            {
                                sender.send(ExecutorResponse::Error {
                                    id,
                                    code: "SERIALIZATION_ERROR".into(),
                                    message: e.to_string(),
                                });
                            }
                            continue;
                        }
                    };
                    if payload.len() > MAX_FRAME_BYTES {
                        if let Some(sender) = pending_writer
                            .lock()
                            .unwrap_or_else(|p| p.into_inner())
                            .remove(&id)
                        {
                            sender.send(ExecutorResponse::Error {
                                id,
                                code: "FRAME_TOO_LARGE".into(),
                                message: "Request frame exceeds limit".into(),
                            });
                        }
                        continue;
                    }
                    let write_failed = match stdin_writer.lock() {
                        Ok(mut input) => match input.as_mut() {
                            Some(input) => {
                                input
                                    .write_all(&(payload.len() as u32).to_le_bytes())
                                    .is_err()
                                    || input.write_all(&payload).is_err()
                                    || input.flush().is_err()
                            }
                            None => true,
                        },
                        Err(_) => true,
                    };
                    if write_failed {
                        admission_closed_writer.store(true, Ordering::SeqCst);
                        close_child_input(&stdin_writer);
                        let mut pending = pending_writer.lock().unwrap_or_else(|p| p.into_inner());
                        for (request_id, sender) in pending.drain() {
                            sender.send(ExecutorResponse::Error {
                                id: request_id,
                                code: "SECURE_RUNNER_UNAVAILABLE".into(),
                                message: "executor input closed before request submission".into(),
                            });
                        }
                        break;
                    }
                }
            })?;

        let pending_reader = Arc::clone(&pending_requests);
        let admission_closed_reader = Arc::clone(&admission_closed);
        let stdin_reader = Arc::clone(&stdin_shared);
        thread::Builder::new()
            .name("executor-client-reader".into())
            .spawn(move || {
                loop {
                    let frame_result = read_frame(&mut stdout);
                    match frame_result {
                        Ok(Some(payload)) => {
                            let parse_result = serde_json::from_slice::<ExecutorResponse>(&payload);
                            match parse_result {
                                Ok(resp) => {
                                    let id = match &resp {
                                        ExecutorResponse::Health { id, .. }
                                        | ExecutorResponse::RunResult { id, .. }
                                        | ExecutorResponse::InteractiveRunResult { id, .. }
                                        | ExecutorResponse::CancelResult { id, .. }
                                        | ExecutorResponse::ShutdownResult { id } => id.clone(),
                                        ExecutorResponse::Error { id, .. } => id.clone(),
                                    };
                                    let mut map =
                                        pending_reader.lock().unwrap_or_else(|p| p.into_inner());
                                    if let Some(sender) = map.remove(&id) {
                                        sender.send(resp);
                                    } else {
                                        // Protocol violation (F3): unknown correlation ID
                                        admission_closed_reader.store(true, Ordering::SeqCst);
                                        for (req_id, s) in map.drain() {
                                            s.send(ExecutorResponse::Error {
                                                id: req_id,
                                                code: "SECURE_RUNNER_PROTOCOL_ERROR".into(),
                                                message: format!(
                                                    "unknown correlation ID '{id}' received"
                                                ),
                                            });
                                        }
                                        drop(map);
                                        close_child_input(&stdin_reader);
                                        break;
                                    }
                                }
                                Err(e) => {
                                    // Protocol violation (F3): malformed payload
                                    admission_closed_reader.store(true, Ordering::SeqCst);
                                    let mut map =
                                        pending_reader.lock().unwrap_or_else(|p| p.into_inner());
                                    for (req_id, s) in map.drain() {
                                        s.send(ExecutorResponse::Error {
                                            id: req_id,
                                            code: "SECURE_RUNNER_PROTOCOL_ERROR".into(),
                                            message: format!("malformed executor response: {e}"),
                                        });
                                    }
                                    drop(map);
                                    close_child_input(&stdin_reader);
                                    break;
                                }
                            }
                        }
                        Ok(None) => {
                            // Clean EOF on stdout
                            admission_closed_reader.store(true, Ordering::SeqCst);
                            break;
                        }
                        Err(e) => {
                            // Protocol framing error (truncated or oversized > 1MB)
                            admission_closed_reader.store(true, Ordering::SeqCst);
                            let mut map = pending_reader.lock().unwrap_or_else(|p| p.into_inner());
                            for (req_id, s) in map.drain() {
                                s.send(ExecutorResponse::Error {
                                    id: req_id,
                                    code: "SECURE_RUNNER_PROTOCOL_ERROR".into(),
                                    message: format!("protocol framing error: {e}"),
                                });
                            }
                            drop(map);
                            close_child_input(&stdin_reader);
                            break;
                        }
                    }
                }
                let mut map = pending_reader.lock().unwrap_or_else(|p| p.into_inner());
                for (id, sender) in map.drain() {
                    sender.send(ExecutorResponse::Error {
                        id,
                        code: "EXECUTOR_DISCONNECTED".into(),
                        message: "Executor process terminated unexpectedly".into(),
                    });
                }
            })?;

        let (reply_tx, reply_rx) = std::sync::mpsc::sync_channel(1);
        let req = ExecutorRequest::Health {
            id: Uuid::new_v4().to_string(),
        };
        request_tx
            .send((req, ResponseSender::Sync(reply_tx)))
            .map_err(|_| {
                cleanup_failed_start(&child_shared, &stdin_shared, &guard.owned_dir);
                std::io::Error::new(std::io::ErrorKind::BrokenPipe, "executor closed")
            })?;

        let cached_health = match reply_rx.recv() {
            Ok(ExecutorResponse::Health { health, .. }) => health,
            Ok(ExecutorResponse::Error { message, .. }) => {
                cleanup_failed_start(&child_shared, &stdin_shared, &guard.owned_dir);
                return Err(std::io::Error::other(message));
            }
            _ => {
                cleanup_failed_start(&child_shared, &stdin_shared, &guard.owned_dir);
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "invalid health response",
                ));
            }
        };

        // Strict verification of executor compatibility and security capabilities (F2)
        if !cached_health.ready {
            cleanup_failed_start(&child_shared, &stdin_shared, &guard.owned_dir);
            return Err(std::io::Error::other(format!(
                "EXECUTOR_NOT_READY: {}",
                cached_health.diagnostics.join("; ")
            )));
        }
        if cached_health.executor_version != EXECUTOR_VERSION {
            cleanup_failed_start(&child_shared, &stdin_shared, &guard.owned_dir);
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!(
                    "EXECUTOR_VERSION_MISMATCH: expected {}, got {}",
                    EXECUTOR_VERSION, cached_health.executor_version
                ),
            ));
        }
        if !cached_health.network_blocked
            || !cached_health.filesystem_isolated
            || !cached_health.process_tree_controlled
            || !cached_health.memory_limit_supported
        {
            cleanup_failed_start(&child_shared, &stdin_shared, &guard.owned_dir);
            return Err(std::io::Error::other(
                "EXECUTOR_INSECURE_CAPABILITIES: executor is missing required isolation capabilities",
            ));
        }

        Ok(Self {
            request_tx,
            cached_health,
            child: child_shared,
            child_stdin: stdin_shared,
            guard_dir: guard.owned_dir,
            admission_closed,
            active_run_ids: Arc::new(Mutex::new(HashSet::new())),
        })
    }

    pub async fn spawn(exe_path: &Path) -> std::io::Result<Self> {
        Self::spawn_sync(exe_path)
    }

    pub async fn spawn_with_env(
        exe_path: &Path,
        envs: &[(&str, &std::ffi::OsStr)],
    ) -> std::io::Result<Self> {
        Self::spawn_sync_with_env(exe_path, envs)
    }

    pub fn health(&self) -> ExecutorHealth {
        self.cached_health.clone()
    }

    pub fn root(&self) -> PathBuf {
        PathBuf::from(&self.cached_health.executor_root)
    }

    pub fn has_active_runs(&self) -> bool {
        self.active_run_ids
            .lock()
            .map(|guard| !guard.is_empty())
            .unwrap_or(false)
    }

    pub fn active_run_ids(&self) -> Vec<String> {
        self.active_run_ids
            .lock()
            .map(|guard| guard.iter().cloned().collect())
            .unwrap_or_default()
    }

    pub fn cancel_all_active_runs(&self) -> usize {
        let ids = self.active_run_ids();
        let mut cancelled_count = 0usize;
        for run_id in ids {
            if matches!(self.cancel_sync(&run_id), Ok(true)) {
                cancelled_count += 1;
            }
        }
        cancelled_count
    }

    fn register_active_run(&self, run_id: &str) -> ActiveRunRegistration {
        if let Ok(mut guard) = self.active_run_ids.lock() {
            guard.insert(run_id.to_string());
        }
        ActiveRunRegistration {
            run_id: run_id.to_string(),
            active_run_ids: Arc::clone(&self.active_run_ids),
        }
    }

    pub async fn run_async(&self, spec: Box<RunSpec>) -> std::io::Result<RunResult> {
        if self.admission_closed.load(Ordering::SeqCst) {
            let reason = if !self.cached_health.ready {
                format!(
                    "SECURE_RUNNER_UNAVAILABLE: {}",
                    self.cached_health.diagnostics.join("; ")
                )
            } else {
                "EXECUTOR_TERMINAL_PROTOCOL_ERROR: admission closed".into()
            };
            return Err(std::io::Error::new(std::io::ErrorKind::BrokenPipe, reason));
        }
        let _reg = self.register_active_run(&spec.run_id);
        let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
        let req = ExecutorRequest::Run {
            id: Uuid::new_v4().to_string(),
            spec,
        };
        self.request_tx
            .send((req, ResponseSender::Async(reply_tx)))
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::BrokenPipe, "executor closed"))?;
        match reply_rx.await {
            Ok(ExecutorResponse::RunResult { result, .. }) => Ok(result),
            Ok(ExecutorResponse::Error { message, .. }) => Err(std::io::Error::other(message)),
            Ok(_) => Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "invalid run response",
            )),
            Err(_) => Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "executor closed",
            )),
        }
    }

    pub fn run_sync(&self, spec: Box<RunSpec>) -> std::io::Result<RunResult> {
        if self.admission_closed.load(Ordering::SeqCst) {
            let reason = if !self.cached_health.ready {
                format!(
                    "SECURE_RUNNER_UNAVAILABLE: {}",
                    self.cached_health.diagnostics.join("; ")
                )
            } else {
                "EXECUTOR_TERMINAL_PROTOCOL_ERROR: admission closed".into()
            };
            return Err(std::io::Error::new(std::io::ErrorKind::BrokenPipe, reason));
        }
        let _reg = self.register_active_run(&spec.run_id);
        let (reply_tx, reply_rx) = std::sync::mpsc::sync_channel(1);
        let req = ExecutorRequest::Run {
            id: Uuid::new_v4().to_string(),
            spec,
        };
        self.request_tx
            .send((req, ResponseSender::Sync(reply_tx)))
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::BrokenPipe, "executor closed"))?;
        match reply_rx.recv() {
            Ok(ExecutorResponse::RunResult { result, .. }) => Ok(result),
            Ok(ExecutorResponse::Error { message, .. }) => Err(std::io::Error::other(message)),
            Ok(_) => Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "invalid run response",
            )),
            Err(_) => Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "executor closed",
            )),
        }
    }

    pub async fn run_interactive_async(
        &self,
        spec: Box<InteractiveRunSpec>,
    ) -> std::io::Result<InteractiveRunResult> {
        if self.admission_closed.load(Ordering::SeqCst) {
            let reason = if !self.cached_health.ready {
                format!(
                    "SECURE_RUNNER_UNAVAILABLE: {}",
                    self.cached_health.diagnostics.join("; ")
                )
            } else {
                "EXECUTOR_TERMINAL_PROTOCOL_ERROR: admission closed".into()
            };
            return Err(std::io::Error::new(std::io::ErrorKind::BrokenPipe, reason));
        }
        let _reg = self.register_active_run(&spec.run_id);
        let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
        let req = ExecutorRequest::InteractiveRun {
            id: Uuid::new_v4().to_string(),
            spec,
        };
        self.request_tx
            .send((req, ResponseSender::Async(reply_tx)))
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::BrokenPipe, "executor closed"))?;
        match reply_rx.await {
            Ok(ExecutorResponse::InteractiveRunResult { result, .. }) => Ok(*result),
            Ok(ExecutorResponse::Error { message, .. }) => Err(std::io::Error::other(message)),
            Ok(_) => Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "invalid interactive run response",
            )),
            Err(_) => Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "executor closed",
            )),
        }
    }

    pub fn run_interactive_sync(
        &self,
        spec: Box<InteractiveRunSpec>,
    ) -> std::io::Result<InteractiveRunResult> {
        if self.admission_closed.load(Ordering::SeqCst) {
            let reason = if !self.cached_health.ready {
                format!(
                    "SECURE_RUNNER_UNAVAILABLE: {}",
                    self.cached_health.diagnostics.join("; ")
                )
            } else {
                "EXECUTOR_TERMINAL_PROTOCOL_ERROR: admission closed".into()
            };
            return Err(std::io::Error::new(std::io::ErrorKind::BrokenPipe, reason));
        }
        let _reg = self.register_active_run(&spec.run_id);
        let (reply_tx, reply_rx) = std::sync::mpsc::sync_channel(1);
        let req = ExecutorRequest::InteractiveRun {
            id: Uuid::new_v4().to_string(),
            spec,
        };
        self.request_tx
            .send((req, ResponseSender::Sync(reply_tx)))
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::BrokenPipe, "executor closed"))?;
        match reply_rx.recv() {
            Ok(ExecutorResponse::InteractiveRunResult { result, .. }) => Ok(*result),
            Ok(ExecutorResponse::Error { message, .. }) => Err(std::io::Error::other(message)),
            Ok(_) => Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "invalid interactive run response",
            )),
            Err(_) => Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "executor closed",
            )),
        }
    }

    pub async fn cancel(&self, run_id: &str) -> std::io::Result<bool> {
        if self.admission_closed.load(Ordering::SeqCst) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "EXECUTOR_TERMINAL_PROTOCOL_ERROR: admission closed",
            ));
        }
        let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
        let req = ExecutorRequest::Cancel {
            id: Uuid::new_v4().to_string(),
            run_id: run_id.to_string(),
        };
        self.request_tx
            .send((req, ResponseSender::Async(reply_tx)))
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::BrokenPipe, "executor closed"))?;
        match reply_rx.await {
            Ok(ExecutorResponse::CancelResult { cancelled, .. }) => Ok(cancelled),
            Ok(ExecutorResponse::Error { message, .. }) => Err(std::io::Error::other(message)),
            _ => Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "invalid cancel response",
            )),
        }
    }

    pub fn cancel_sync(&self, run_id: &str) -> std::io::Result<bool> {
        if self.admission_closed.load(Ordering::SeqCst) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "EXECUTOR_TERMINAL_PROTOCOL_ERROR: admission closed",
            ));
        }
        let (reply_tx, reply_rx) = std::sync::mpsc::sync_channel(1);
        let req = ExecutorRequest::Cancel {
            id: Uuid::new_v4().to_string(),
            run_id: run_id.to_string(),
        };
        self.request_tx
            .send((req, ResponseSender::Sync(reply_tx)))
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::BrokenPipe, "executor closed"))?;
        match reply_rx.recv() {
            Ok(ExecutorResponse::CancelResult { cancelled, .. }) => Ok(cancelled),
            Ok(ExecutorResponse::Error { message, .. }) => Err(std::io::Error::other(message)),
            _ => Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "invalid cancel response",
            )),
        }
    }

    pub async fn shutdown(&self) -> std::io::Result<()> {
        if self.admission_closed.swap(true, Ordering::SeqCst) {
            return self.wait_for_child_exit_after_input_close().await;
        }
        let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
        let req = ExecutorRequest::Shutdown {
            id: Uuid::new_v4().to_string(),
        };
        let response = if self
            .request_tx
            .send((req, ResponseSender::Async(reply_tx)))
            .is_err()
        {
            Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "executor closed",
            ))
        } else {
            tokio::time::timeout(DROP_DRAIN_TIMEOUT, reply_rx)
                .await
                .map_err(|_| {
                    std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        "executor shutdown drain acknowledgement timed out",
                    )
                })
                .and_then(|response| {
                    response.map_err(|_| {
                        std::io::Error::new(
                            std::io::ErrorKind::BrokenPipe,
                            "executor shutdown response channel closed",
                        )
                    })
                })
        };
        let drain_result = self.wait_for_child_exit_after_input_close().await;
        drain_result?;
        match response {
            Ok(ExecutorResponse::ShutdownResult { .. }) => Ok(()),
            Ok(ExecutorResponse::Error { message, .. }) => Err(std::io::Error::other(message)),
            Err(error) => Err(error),
            _ => Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "invalid shutdown response",
            )),
        }
    }

    pub fn shutdown_sync(&self) -> std::io::Result<()> {
        if self.admission_closed.swap(true, Ordering::SeqCst) {
            return self.wait_for_child_exit_after_input_close_sync();
        }
        let (reply_tx, reply_rx) = std::sync::mpsc::sync_channel(1);
        let req = ExecutorRequest::Shutdown {
            id: Uuid::new_v4().to_string(),
        };
        let response = self
            .request_tx
            .send((req, ResponseSender::Sync(reply_tx)))
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::BrokenPipe, "executor closed"))
            .and_then(|_| {
                reply_rx.recv_timeout(DROP_DRAIN_TIMEOUT).map_err(|_| {
                    std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        "invalid or timed-out shutdown response",
                    )
                })
            });
        self.wait_for_child_exit_after_input_close_sync()?;
        match response {
            Ok(ExecutorResponse::ShutdownResult { .. }) => Ok(()),
            Ok(ExecutorResponse::Error { message, .. }) => Err(std::io::Error::other(message)),
            Err(error) => Err(error),
            _ => Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "invalid shutdown response",
            )),
        }
    }

    async fn wait_for_child_exit_after_input_close(&self) -> std::io::Result<()> {
        close_child_input(&self.child_stdin);
        let child = Arc::clone(&self.child);
        let drained =
            tokio::task::spawn_blocking(move || wait_for_child_exit(&child, DROP_DRAIN_TIMEOUT))
                .await
                .map_err(|error| {
                    std::io::Error::other(format!("executor drain task failed: {error}"))
                })?;
        if drained {
            Ok(())
        } else {
            Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "executor did not exit after its input was closed",
            ))
        }
    }

    fn wait_for_child_exit_after_input_close_sync(&self) -> std::io::Result<()> {
        close_child_input(&self.child_stdin);
        if wait_for_child_exit(&self.child, DROP_DRAIN_TIMEOUT) {
            Ok(())
        } else {
            Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "executor did not exit after its input was closed",
            ))
        }
    }
}

impl Drop for ExecutorClient {
    fn drop(&mut self) {
        if !self.admission_closed.load(Ordering::SeqCst) {
            let _ = self.shutdown_sync();
        } else {
            let _ = self.wait_for_child_exit_after_input_close_sync();
        }
        let process_drained = self
            .child
            .lock()
            .map(|child| child.is_none())
            .unwrap_or(false);
        if process_drained {
            remove_owned_tree_guard(&self.guard_dir);
        }
    }
}
