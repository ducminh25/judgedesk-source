pub const REQUIRED_ENV: &str = "JUDGEDESK_TREE_GUARD_REQUIRED";
pub const PATH_ENV: &str = "JUDGEDESK_TREE_GUARD_PATH";
pub const GENERATION_ENV: &str = "JUDGEDESK_TREE_GUARD_GENERATION";
pub const PARENT_PID_ENV: &str = "JUDGEDESK_PARENT_PID";

const HEADER: &str = "JUDGEDESK_PROCESS_TREE/1";
const MAX_METADATA_BYTES: u64 = 160;

fn validate_generation(generation: &str) -> Result<(), String> {
    if generation.len() == 64
        && generation
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(())
    } else {
        Err("PROCESS_TREE_GUARD_INVALID_GENERATION".into())
    }
}

pub fn generation_contents(generation: &str) -> String {
    format!("{HEADER}\ngeneration={generation}\n")
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
mod macos {
    use super::{
        generation_contents, validate_generation, GENERATION_ENV, MAX_METADATA_BYTES,
        PARENT_PID_ENV, PATH_ENV, REQUIRED_ENV,
    };
    use std::fs::{File, OpenOptions};
    use std::io::{Read, Seek, SeekFrom};
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
    use std::path::{Path, PathBuf};

    #[derive(Debug)]
    pub struct ProcessTreeGuard {
        _file: File,
    }

    #[derive(Debug)]
    pub struct ExecutorTreeGuard {
        _generation: ProcessTreeGuard,
        _owner: File,
    }

    impl Drop for ExecutorTreeGuard {
        fn drop(&mut self) {
            // macOS normally releases flock ownership when the descriptor closes, but make the
            // lease transition explicit before the field is dropped. This avoids a transient
            // reacquisition failure observed when the complete test suite releases and
            // immediately reopens the same owner lease.
            unsafe {
                libc::flock(self._owner.as_raw_fd(), libc::LOCK_UN);
            }
        }
    }

    pub fn acquire_from_environment() -> Result<ProcessTreeGuard, String> {
        let (path, generation) = validated_environment()?;
        validate_parent_identity()?;
        acquire(&path, &generation)
    }

    pub fn acquire_executor_from_environment() -> Result<ExecutorTreeGuard, String> {
        let (path, generation) = validated_environment()?;
        validate_parent_identity()?;
        acquire_executor(&path, &generation)
    }

    fn validated_environment() -> Result<(PathBuf, String), String> {
        let required = std::env::var_os(REQUIRED_ENV);
        let path = std::env::var_os(PATH_ENV);
        let generation = std::env::var(GENERATION_ENV);

        if required.is_none() {
            if path.is_some() || generation.is_ok() {
                return Err("PROCESS_TREE_GUARD_PARTIAL_ENVIRONMENT".into());
            }
            return Err("PROCESS_TREE_GUARD_REQUIRED_MISSING".into());
        }
        if required.as_deref() != Some(std::ffi::OsStr::new("1")) {
            return Err("PROCESS_TREE_GUARD_INVALID_REQUIREMENT".into());
        }
        let path = PathBuf::from(path.ok_or("PROCESS_TREE_GUARD_PATH_MISSING")?);
        let generation = generation.map_err(|_| "PROCESS_TREE_GUARD_GENERATION_MISSING")?;
        validate_generation(&generation)?;
        Ok((path, generation))
    }

    fn validate_parent_identity() -> Result<(), String> {
        let expected_parent_str =
            std::env::var(PARENT_PID_ENV).map_err(|_| "PROCESS_PARENT_PID_MISSING".to_string())?;
        let expected_parent_pid: i32 = expected_parent_str
            .parse()
            .map_err(|_| "PROCESS_PARENT_PID_INVALID".to_string())?;

        let os_parent_pid = unsafe { libc::getppid() };
        if os_parent_pid != expected_parent_pid {
            return Err(format!(
                "PROCESS_PARENT_IDENTITY_MISMATCH: expected {expected_parent_pid}, kernel reported {os_parent_pid}"
            ));
        }

        #[cfg(target_os = "macos")]
        {
            let parent_identity = crate::macos_process::read_process_identity(os_parent_pid)
                .map_err(|e| format!("PROCESS_PARENT_LOOKUP_FAILED: {e}"))?;
            let current_identity =
                crate::macos_process::read_process_identity(unsafe { libc::getpid() })
                    .map_err(|e| format!("CURRENT_PROCESS_LOOKUP_FAILED: {e}"))?;

            if parent_identity.start_abstime > current_identity.start_abstime {
                return Err("PROCESS_PARENT_STALE_OR_RECYCLED".into());
            }
        }
        #[cfg(target_os = "linux")]
        {
            let parent_start = read_linux_process_start_ticks(os_parent_pid)
                .map_err(|e| format!("PROCESS_PARENT_LOOKUP_FAILED: {e}"))?;
            let current_start = read_linux_process_start_ticks(unsafe { libc::getpid() })
                .map_err(|e| format!("CURRENT_PROCESS_LOOKUP_FAILED: {e}"))?;

            if parent_start > current_start {
                return Err("PROCESS_PARENT_STALE_OR_RECYCLED".into());
            }
        }
        Ok(())
    }

    #[cfg(target_os = "linux")]
    fn read_linux_process_start_ticks(pid: i32) -> Result<u64, String> {
        if pid <= 0 {
            return Err("invalid process ID".into());
        }
        let stat_path = format!("/proc/{pid}/stat");
        let stat = std::fs::read_to_string(&stat_path)
            .map_err(|error| format!("read {stat_path}: {error}"))?;
        let close_paren = stat
            .rfind(')')
            .ok_or_else(|| format!("malformed {stat_path}: missing comm terminator"))?;
        let after_comm = stat
            .get(close_paren + 1..)
            .ok_or_else(|| format!("malformed {stat_path}: truncated after comm"))?;
        let mut fields = after_comm.split_whitespace();
        let state = fields
            .next()
            .ok_or_else(|| format!("malformed {stat_path}: missing state"))?;
        if state == "Z" || state == "X" {
            return Err("PROCESS_PARENT_NOT_ACTIVE".into());
        }
        // Field 3 is state (consumed above); field 22 is starttime (18 fields after state).
        let start_ticks_str = fields
            .nth(18)
            .ok_or_else(|| format!("malformed {stat_path}: missing starttime"))?;
        start_ticks_str
            .parse::<u64>()
            .map_err(|error| format!("malformed {stat_path} starttime: {error}"))
    }

    pub fn acquire(path: &Path, generation: &str) -> Result<ProcessTreeGuard, String> {
        validate_generation(generation)?;
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
            .open(path)
            .map_err(|error| format!("PROCESS_TREE_GUARD_OPEN_FAILED: {error}"))?;
        let metadata = file
            .metadata()
            .map_err(|error| format!("PROCESS_TREE_GUARD_METADATA_FAILED: {error}"))?;
        if !metadata.file_type().is_file()
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.permissions().mode() & 0o777 != 0o600
            || metadata.nlink() != 1
            || metadata.len() > MAX_METADATA_BYTES
        {
            return Err("PROCESS_TREE_GUARD_UNTRUSTED_FILE".into());
        }
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_SH | libc::LOCK_NB) } != 0 {
            return Err(format!(
                "PROCESS_TREE_GUARD_LOCK_FAILED: {}",
                std::io::Error::last_os_error()
            ));
        }
        file.seek(SeekFrom::Start(0))
            .map_err(|error| format!("PROCESS_TREE_GUARD_SEEK_FAILED: {error}"))?;
        let mut contents = String::new();
        file.by_ref()
            .take(MAX_METADATA_BYTES + 1)
            .read_to_string(&mut contents)
            .map_err(|error| format!("PROCESS_TREE_GUARD_READ_FAILED: {error}"))?;
        if contents.len() as u64 > MAX_METADATA_BYTES || contents != generation_contents(generation)
        {
            return Err("PROCESS_TREE_GUARD_GENERATION_MISMATCH".into());
        }
        Ok(ProcessTreeGuard { _file: file })
    }

    pub fn acquire_executor(path: &Path, generation: &str) -> Result<ExecutorTreeGuard, String> {
        let generation_guard = acquire(path, generation)?;
        let owner_path = path.with_extension("executor-owner.lock");
        let owner = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .mode(0o600)
            .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
            .open(&owner_path)
            .map_err(|error| format!("PROCESS_TREE_OWNER_OPEN_FAILED: {error}"))?;
        let metadata = owner
            .metadata()
            .map_err(|error| format!("PROCESS_TREE_OWNER_METADATA_FAILED: {error}"))?;
        if !metadata.file_type().is_file()
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.permissions().mode() & 0o777 != 0o600
            || metadata.nlink() != 1
        {
            return Err("PROCESS_TREE_OWNER_UNTRUSTED_FILE".into());
        }
        if unsafe { libc::flock(owner.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(format!(
                "PROCESS_TREE_GUARD_LOCK_FAILED: executor owner lease: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(ExecutorTreeGuard {
            _generation: generation_guard,
            _owner: owner,
        })
    }

    #[cfg(test)]
    mod tests {
        use super::{acquire, acquire_executor, generation_contents};
        use std::fs::{self, OpenOptions};
        use std::io::Write;
        use std::os::fd::AsRawFd;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        use std::path::PathBuf;
        use std::sync::atomic::{AtomicU64, Ordering};

        static NEXT_DIRECTORY: AtomicU64 = AtomicU64::new(0);
        const GENERATION: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

        struct TestDirectory(PathBuf);

        impl TestDirectory {
            fn new() -> Self {
                let suffix = NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed);
                let path = std::env::temp_dir().join(format!(
                    "judgedesk-tree-guard-test-{}-{suffix}",
                    std::process::id()
                ));
                fs::create_dir(&path).expect("create tree guard test directory");
                Self(path)
            }
        }

        impl Drop for TestDirectory {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }

        fn create_guard_file(directory: &TestDirectory) -> (PathBuf, std::fs::File) {
            let path = directory.0.join("process-tree.lock");
            let mut file = OpenOptions::new()
                .create_new(true)
                .read(true)
                .write(true)
                .mode(0o600)
                .open(&path)
                .expect("create process-tree lock");
            file.write_all(generation_contents(GENERATION).as_bytes())
                .expect("write generation");
            file.sync_all().expect("sync generation");
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
                .expect("set process-tree lock permissions");
            (path, file)
        }

        #[test]
        fn shared_guard_requires_the_expected_generation() {
            let directory = TestDirectory::new();
            let (path, _owner) = create_guard_file(&directory);
            let guard = acquire(&path, GENERATION).expect("acquire shared generation guard");
            drop(guard);
            assert!(acquire(
                &path,
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            )
            .expect_err("wrong generation must fail")
            .contains("GENERATION_MISMATCH"));
        }

        #[test]
        fn shared_generation_guards_can_coexist() {
            let directory = TestDirectory::new();
            let (path, _owner) = create_guard_file(&directory);
            let first = acquire(&path, GENERATION).expect("acquire first shared generation guard");
            let second =
                acquire(&path, GENERATION).expect("acquire second shared generation guard");
            drop(second);
            drop(first);
        }

        #[test]
        fn executor_owner_is_exclusive_while_generation_guards_remain_shared() {
            let directory = TestDirectory::new();
            let (path, _owner) = create_guard_file(&directory);
            let executor =
                acquire_executor(&path, GENERATION).expect("acquire executor generation owner");
            let shared =
                acquire(&path, GENERATION).expect("acquire nested shared generation guard");
            assert!(acquire_executor(&path, GENERATION)
                .expect_err("second executor owner must fail")
                .contains("GUARD_LOCK_FAILED"));
            drop(shared);
            drop(executor);
            acquire_executor(&path, GENERATION)
                .expect("owner lock must release after executor exit");
        }

        #[test]
        fn shared_guard_requires_exact_private_mode_and_single_link() {
            let directory = TestDirectory::new();
            let (path, _owner) = create_guard_file(&directory);
            fs::set_permissions(&path, fs::Permissions::from_mode(0o640))
                .expect("make guard permissions too broad");
            assert!(acquire(&path, GENERATION)
                .expect_err("group-readable guard must fail")
                .contains("UNTRUSTED_FILE"));

            fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
                .expect("restore private guard permissions");
            fs::hard_link(&path, directory.0.join("process-tree.alias"))
                .expect("create second guard hard link");
            assert!(acquire(&path, GENERATION)
                .expect_err("multiply-linked guard must fail")
                .contains("UNTRUSTED_FILE"));
        }

        #[test]
        fn exclusive_handoff_blocks_late_executor_startup() {
            let directory = TestDirectory::new();
            let (path, owner) = create_guard_file(&directory);
            assert_eq!(
                unsafe { libc::flock(owner.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
                0
            );
            assert!(acquire(&path, GENERATION)
                .expect_err("exclusive handoff must reject a late executor")
                .contains("LOCK_FAILED"));
            assert_eq!(unsafe { libc::flock(owner.as_raw_fd(), libc::LOCK_UN) }, 0);
            acquire(&path, GENERATION).expect("shared guard after handoff");
        }
    }
}

#[cfg(target_os = "windows")]
mod windows {
    use super::{
        generation_contents, validate_generation, GENERATION_ENV, MAX_METADATA_BYTES, PATH_ENV,
        REQUIRED_ENV,
    };
    use std::fs::{File, OpenOptions};
    use std::io::{Read, Seek, SeekFrom};
    use std::os::windows::io::AsRawHandle;
    use std::path::{Path, PathBuf};
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        LockFileEx, LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY,
    };
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, GetExitCodeProcess, GetProcessTimes, OpenProcess,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };

    #[derive(Debug)]
    pub struct ProcessTreeGuard {
        _file: File,
    }

    pub type ExecutorTreeGuard = ProcessTreeGuard;

    pub fn acquire_executor_from_environment() -> Result<ExecutorTreeGuard, String> {
        acquire_from_environment()
    }

    pub fn acquire_from_environment() -> Result<ProcessTreeGuard, String> {
        let required = std::env::var_os(REQUIRED_ENV);
        let path = std::env::var_os(PATH_ENV);
        let generation = std::env::var(GENERATION_ENV);

        if required.is_none() {
            if path.is_some() || generation.is_ok() {
                return Err("PROCESS_TREE_GUARD_PARTIAL_ENVIRONMENT".into());
            }
            return Err("PROCESS_TREE_GUARD_REQUIRED_MISSING".into());
        }
        if required.as_deref() != Some(std::ffi::OsStr::new("1")) {
            return Err("PROCESS_TREE_GUARD_INVALID_REQUIREMENT".into());
        }
        let path = PathBuf::from(path.ok_or("PROCESS_TREE_GUARD_PATH_MISSING")?);
        let generation = generation.map_err(|_| "PROCESS_TREE_GUARD_GENERATION_MISSING")?;
        validate_generation(&generation)?;
        validate_parent_identity()?;
        acquire(&path, &generation)
    }

    fn validate_parent_identity() -> Result<(), String> {
        let expected_parent_str = std::env::var("JUDGEDESK_PARENT_PID")
            .map_err(|_| "PROCESS_PARENT_PID_MISSING".to_string())?;
        let expected_parent_pid: u32 = expected_parent_str
            .parse()
            .map_err(|_| "PROCESS_PARENT_PID_INVALID".to_string())?;

        let current_pid = std::process::id();
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(format!(
                "PROCESS_PARENT_SNAPSHOT_FAILED: {}",
                std::io::Error::last_os_error()
            ));
        }

        let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut success = unsafe { Process32FirstW(snapshot, &mut entry) };
        let mut os_parent_pid = None;
        while success != 0 {
            if entry.th32ProcessID == current_pid {
                os_parent_pid = Some(entry.th32ParentProcessID);
                break;
            }
            success = unsafe { Process32NextW(snapshot, &mut entry) };
        }
        unsafe { CloseHandle(snapshot) };

        let os_parent_pid = os_parent_pid.ok_or("PROCESS_PARENT_NOT_FOUND_IN_SNAPSHOT")?;
        if os_parent_pid != expected_parent_pid {
            return Err(format!(
                "PROCESS_PARENT_IDENTITY_MISMATCH: expected {expected_parent_pid}, kernel reported {os_parent_pid}"
            ));
        }

        // Authenticate parent process handle and liveness
        let parent_handle =
            unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, os_parent_pid) };
        if parent_handle.is_null() {
            return Err(format!(
                "PROCESS_PARENT_OPEN_FAILED: {}",
                std::io::Error::last_os_error()
            ));
        }

        let mut parent_exit_code = 0u32;
        let exit_ok = unsafe { GetExitCodeProcess(parent_handle, &mut parent_exit_code) };
        if exit_ok == 0 || parent_exit_code != 259
        /* STILL_ACTIVE */
        {
            unsafe { CloseHandle(parent_handle) };
            return Err("PROCESS_PARENT_NOT_ACTIVE".into());
        }

        // Authenticate parent creation time <= child creation time (prevents PID recycling)
        let mut parent_create: FILETIME = unsafe { std::mem::zeroed() };
        let mut parent_exit: FILETIME = unsafe { std::mem::zeroed() };
        let mut parent_kernel: FILETIME = unsafe { std::mem::zeroed() };
        let mut parent_user: FILETIME = unsafe { std::mem::zeroed() };
        let ptimes_ok = unsafe {
            GetProcessTimes(
                parent_handle,
                &mut parent_create,
                &mut parent_exit,
                &mut parent_kernel,
                &mut parent_user,
            )
        };

        let mut current_create: FILETIME = unsafe { std::mem::zeroed() };
        let mut current_exit: FILETIME = unsafe { std::mem::zeroed() };
        let mut current_kernel: FILETIME = unsafe { std::mem::zeroed() };
        let mut current_user: FILETIME = unsafe { std::mem::zeroed() };
        let ctimes_ok = unsafe {
            GetProcessTimes(
                GetCurrentProcess(),
                &mut current_create,
                &mut current_exit,
                &mut current_kernel,
                &mut current_user,
            )
        };

        unsafe { CloseHandle(parent_handle) };

        if ptimes_ok == 0 || ctimes_ok == 0 {
            return Err("PROCESS_PARENT_TIMES_FAILED".into());
        }

        let parent_time =
            ((parent_create.dwHighDateTime as u64) << 32) | (parent_create.dwLowDateTime as u64);
        let current_time =
            ((current_create.dwHighDateTime as u64) << 32) | (current_create.dwLowDateTime as u64);

        if parent_time > current_time {
            return Err("PROCESS_PARENT_STALE_OR_RECYCLED".into());
        }

        Ok(())
    }

    pub fn acquire(path: &Path, generation: &str) -> Result<ProcessTreeGuard, String> {
        validate_generation(generation)?;
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)
            .map_err(|error| format!("PROCESS_TREE_GUARD_OPEN_FAILED: {error}"))?;
        let metadata = file
            .metadata()
            .map_err(|error| format!("PROCESS_TREE_GUARD_METADATA_FAILED: {error}"))?;
        if !metadata.file_type().is_file() || metadata.len() > MAX_METADATA_BYTES {
            return Err("PROCESS_TREE_GUARD_UNTRUSTED_FILE".into());
        }
        let mut overlapped = unsafe { std::mem::zeroed() };
        let lock_result = unsafe {
            LockFileEx(
                file.as_raw_handle() as _,
                LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
                0,
                1,
                0,
                &mut overlapped,
            )
        };
        if lock_result == 0 {
            return Err(format!(
                "PROCESS_TREE_GUARD_LOCK_FAILED: {}",
                std::io::Error::last_os_error()
            ));
        }
        file.seek(SeekFrom::Start(0))
            .map_err(|error| format!("PROCESS_TREE_GUARD_SEEK_FAILED: {error}"))?;
        let mut contents = String::new();
        file.by_ref()
            .take(MAX_METADATA_BYTES + 1)
            .read_to_string(&mut contents)
            .map_err(|error| format!("PROCESS_TREE_GUARD_READ_FAILED: {error}"))?;
        let normalized = contents.replace("\r\n", "\n");
        if normalized.len() as u64 > MAX_METADATA_BYTES
            || normalized != generation_contents(generation)
        {
            return Err("PROCESS_TREE_GUARD_GENERATION_MISMATCH".into());
        }
        Ok(ProcessTreeGuard { _file: file })
    }

    #[cfg(test)]
    mod tests {
        use super::{acquire, generation_contents};
        use std::fs::{self, OpenOptions};
        use std::io::Write;
        use std::os::windows::io::AsRawHandle;
        use std::path::PathBuf;
        use std::sync::atomic::{AtomicU64, Ordering};
        use windows_sys::Win32::Storage::FileSystem::{
            LockFileEx, UnlockFileEx, LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY,
        };

        static NEXT_DIRECTORY: AtomicU64 = AtomicU64::new(0);
        const GENERATION: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

        struct TestDirectory(PathBuf);

        impl TestDirectory {
            fn new() -> Self {
                let suffix = NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed);
                let path = std::env::temp_dir().join(format!(
                    "judgedesk-tree-guard-test-{}-{suffix}",
                    std::process::id()
                ));
                fs::create_dir(&path).expect("create tree guard test directory");
                Self(path)
            }
        }

        impl Drop for TestDirectory {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }

        fn create_guard_file(directory: &TestDirectory) -> (PathBuf, std::fs::File) {
            let path = directory.0.join("process-tree.lock");
            let mut file = OpenOptions::new()
                .create_new(true)
                .read(true)
                .write(true)
                .open(&path)
                .expect("create process-tree lock");
            file.write_all(generation_contents(GENERATION).as_bytes())
                .expect("write generation");
            file.sync_all().expect("sync generation");
            (path, file)
        }

        #[test]
        fn shared_guard_requires_the_expected_generation() {
            let directory = TestDirectory::new();
            let (path, _owner) = create_guard_file(&directory);
            let guard = acquire(&path, GENERATION).expect("acquire shared generation guard");
            drop(guard);
            assert!(acquire(
                &path,
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            )
            .expect_err("wrong generation must fail")
            .contains("GENERATION_MISMATCH"));
        }

        #[test]
        fn exclusive_handoff_blocks_late_executor_startup() {
            let directory = TestDirectory::new();
            let (path, owner) = create_guard_file(&directory);
            let mut overlapped = unsafe { std::mem::zeroed() };
            let locked = unsafe {
                LockFileEx(
                    owner.as_raw_handle() as _,
                    LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
                    0,
                    1,
                    0,
                    &mut overlapped,
                )
            };
            assert_ne!(locked, 0, "must acquire exclusive lock on owner");
            assert!(acquire(&path, GENERATION)
                .expect_err("exclusive handoff must reject a late executor")
                .contains("LOCK_FAILED"));
            let unlocked =
                unsafe { UnlockFileEx(owner.as_raw_handle() as _, 0, 1, 0, &mut overlapped) };
            assert_ne!(unlocked, 0, "unlock must succeed");
            acquire(&path, GENERATION).expect("shared guard after handoff");
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub use macos::{
    acquire_executor_from_environment, acquire_from_environment, ExecutorTreeGuard,
    ProcessTreeGuard,
};

#[cfg(target_os = "windows")]
pub use windows::{
    acquire_executor_from_environment, acquire_from_environment, ExecutorTreeGuard,
    ProcessTreeGuard,
};

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
#[derive(Debug)]
pub struct ProcessTreeGuard;

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
pub type ExecutorTreeGuard = ProcessTreeGuard;

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
pub fn acquire_from_environment() -> Result<ProcessTreeGuard, String> {
    Err("UNSUPPORTED_PLATFORM".into())
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
pub fn acquire_executor_from_environment() -> Result<ExecutorTreeGuard, String> {
    Err("UNSUPPORTED_PLATFORM".into())
}
