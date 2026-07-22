use super::{failure, root_display, ActiveRuns, Cancellation};
use crate::protocol::{ExecutorHealth, RunReason, RunResult, RunRole, RunSpec};
use crate::request_validation::ValidatedRun;
use crate::workspace::{file_size, initialize_root, inspect_workspace};
use std::collections::{BTreeMap, HashSet};
use std::ffi::c_void;
use std::fs;
use std::io;
use std::mem::{size_of, zeroed};
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::ptr::{null, null_mut};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, LocalFree, ERROR_ALREADY_EXISTS, ERROR_INSUFFICIENT_BUFFER,
    FILETIME, GENERIC_READ, GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0,
    WAIT_TIMEOUT,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, SetNamedSecurityInfoW, SE_FILE_OBJECT,
};
use windows_sys::Win32::Security::Isolation::{
    CreateAppContainerProfile, DeriveAppContainerSidFromAppContainerName, GetAppContainerFolderPath,
};
use windows_sys::Win32::Security::{
    AddAccessAllowedAceEx, CreateWellKnownSid, FreeSid, GetLengthSid, GetTokenInformation,
    InitializeAcl, TokenUser, WinBuiltinAdministratorsSid, WinLocalSystemSid, ACCESS_ALLOWED_ACE,
    ACL, ACL_REVISION, CONTAINER_INHERIT_ACE, DACL_SECURITY_INFORMATION, OBJECT_INHERIT_ACE,
    PROTECTED_DACL_SECURITY_INFORMATION, PSID, SECURITY_ATTRIBUTES, SECURITY_CAPABILITIES,
    SECURITY_MAX_SID_SIZE, TOKEN_QUERY, TOKEN_USER,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, CREATE_ALWAYS, FILE_ALL_ACCESS, FILE_ATTRIBUTE_NORMAL, FILE_GENERIC_EXECUTE,
    FILE_GENERIC_READ, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
};
use windows_sys::Win32::System::Com::CoTaskMemFree;
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectAssociateCompletionPortInformation,
    JobObjectBasicAccountingInformation, JobObjectBasicProcessIdList,
    JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
    TerminateJobObject, JOBOBJECT_ASSOCIATE_COMPLETION_PORT,
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_BASIC_PROCESS_ID_LIST,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_ACTIVE_PROCESS,
    JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION, JOB_OBJECT_LIMIT_JOB_MEMORY,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::SystemServices::{
    JOB_OBJECT_MSG_ACTIVE_PROCESS_LIMIT, JOB_OBJECT_MSG_JOB_MEMORY_LIMIT,
};
use windows_sys::Win32::System::Threading::{
    CreateProcessW, DeleteProcThreadAttributeList, GetCurrentProcess, GetExitCodeProcess,
    GetProcessTimes, InitializeProcThreadAttributeList, OpenProcessToken, ResumeThread,
    UpdateProcThreadAttribute, WaitForSingleObject, CREATE_NO_WINDOW, CREATE_SUSPENDED,
    CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT, PROCESS_INFORMATION,
    PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
    PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, STARTF_USESTDHANDLES, STARTUPINFOEXW,
};
use windows_sys::Win32::System::WindowsProgramming::PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT;
use windows_sys::Win32::System::IO::{CreateIoCompletionPort, GetQueuedCompletionStatus};

const PROFILE_NAME: &str = "JudgeDesk.NativeSecureExecutor.v1";
const CANCEL_EXIT_CODE: u32 = 0x4a44_0001;
const LIMIT_EXIT_CODE: u32 = 0x4a44_0002;

pub struct WindowsPlatform {
    sid: Vec<u8>,
    self_test: SelfTest,
}

struct SelfTest {
    ready: bool,
    diagnostics: Vec<String>,
    network_blocked: bool,
    filesystem_isolated: bool,
    process_tree_controlled: bool,
}

impl WindowsPlatform {
    pub fn initialize() -> Result<(Self, PathBuf), String> {
        let (sid, profile_root) = create_or_open_profile()?;
        let root = initialize_root(profile_root.join("LocalState"))?;
        protect_cache_directory(&root.join("toolchains"), &sid)?;
        protect_cache_directory(&root.join("artifacts"), &sid)?;
        let mut platform = Self {
            sid,
            self_test: SelfTest {
                ready: false,
                diagnostics: vec!["security self-test has not run".into()],
                network_blocked: false,
                filesystem_isolated: false,
                process_tree_controlled: false,
            },
        };
        platform.self_test = platform.run_self_test(&root);
        Ok((platform, root))
    }

    pub fn health(&self, root: &Path) -> ExecutorHealth {
        ExecutorHealth {
            ready: self.self_test.ready,
            mode: "windows-lpac-job".into(),
            executor_version: env!("CARGO_PKG_VERSION").into(),
            executor_root: root_display(root),
            diagnostics: self.self_test.diagnostics.clone(),
            network_blocked: self.self_test.network_blocked,
            filesystem_isolated: self.self_test.filesystem_isolated,
            process_tree_controlled: self.self_test.process_tree_controlled,
            memory_limit_supported: true,
        }
    }

    pub fn run(&self, spec: &RunSpec, validated: &ValidatedRun, active: &ActiveRuns) -> RunResult {
        match self.run_inner(spec, validated, active) {
            Ok(result) => result,
            Err(error) => failure(spec, RunReason::LaunchError, error),
        }
    }

    fn run_self_test(&self, root: &Path) -> SelfTest {
        let result = (|| -> Result<SelfTest, String> {
            let workspace_id = "startup_self_test";
            let workspace = root.join("workspaces").join(workspace_id);
            if workspace.exists() {
                fs::remove_dir_all(&workspace)
                    .map_err(|error| format!("cannot reset self-test workspace: {error}"))?;
            }
            fs::create_dir_all(&workspace)
                .map_err(|error| format!("cannot create self-test workspace: {error}"))?;
            let probe = workspace.join("probe.exe");
            fs::copy(
                std::env::current_exe().map_err(|error| error.to_string())?,
                &probe,
            )
            .map_err(|error| format!("cannot stage security probe: {error}"))?;
            let sentinel =
                std::env::temp_dir().join(format!("judgedesk-sentinel-{}.txt", std::process::id()));
            fs::write(&sentinel, b"JUDGEDESK_SENTINEL")
                .map_err(|error| format!("cannot create security sentinel: {error}"))?;
            let spec = RunSpec {
                run_id: "startup_self_test_run".into(),
                role: RunRole::SecurityProbe,
                workspace_id: workspace_id.into(),
                executable_id: format!("workspaces/{workspace_id}/probe.exe"),
                args: vec![
                    "--security-probe-child".into(),
                    sentinel.to_string_lossy().into_owned(),
                ],
                stdin_file: None,
                stdout_file: "probe.stdout".into(),
                stderr_file: "probe.stderr".into(),
                environment: BTreeMap::new(),
                limits: crate::protocol::RunLimits {
                    wall_time_ms: 5_000,
                    memory_bytes: 128 * 1024 * 1024,
                    process_count: 1,
                    thread_count: 16,
                    output_bytes: 1024 * 1024,
                    total_write_bytes: 4 * 1024 * 1024,
                    open_files: 32,
                    created_files: 16,
                },
            };
            let validated = crate::request_validation::validate_run(root, &spec)?;
            let active: ActiveRuns =
                Arc::new(std::sync::Mutex::new(std::collections::HashMap::new()));
            let run = self.run_inner(&spec, &validated, &active)?;
            let output = fs::read_to_string(workspace.join("probe.stdout"))
                .map_err(|error| format!("cannot read security probe: {error}"))?;
            let probe: serde_json::Value = serde_json::from_str(output.trim())
                .map_err(|error| {
                    let stderr = fs::read_to_string(workspace.join("probe.stderr"))
                        .unwrap_or_default();
                    format!(
                        "security probe returned invalid JSON: {error}; reason={:?}, exit={:?}, stderr={}",
                        run.reason,
                        run.exit_code,
                        stderr.trim()
                    )
                })?;
            let sentinel_intact = fs::read(&sentinel)
                .map(|value| value == b"JUDGEDESK_SENTINEL")
                .unwrap_or(false);
            let _ = fs::remove_file(&sentinel);
            let filesystem = probe["readBlocked"].as_bool() == Some(true)
                && probe["writeBlocked"].as_bool() == Some(true)
                && sentinel_intact;
            let network = probe["networkBlocked"].as_bool() == Some(true);
            let process = probe["processBlocked"].as_bool() == Some(true)
                && (matches!(run.reason, RunReason::ProcessLimit)
                    || (matches!(run.reason, RunReason::Exited) && run.exit_code == Some(0)));
            let ready = filesystem && network && process;
            let diagnostics = if ready {
                Vec::new()
            } else {
                vec![format!(
                    "LPAC security probe failed: probe={probe}, reason={:?}, exit={:?}",
                    run.reason, run.exit_code
                )]
            };
            Ok(SelfTest {
                ready,
                diagnostics,
                network_blocked: network,
                filesystem_isolated: filesystem,
                process_tree_controlled: process,
            })
        })();
        match result {
            Ok(value) => value,
            Err(error) => SelfTest {
                ready: false,
                diagnostics: vec![format!("SECURE_RUNNER_SELF_TEST_FAILED: {error}")],
                network_blocked: false,
                filesystem_isolated: false,
                process_tree_controlled: false,
            },
        }
    }

    fn run_inner(
        &self,
        spec: &RunSpec,
        paths: &ValidatedRun,
        active: &ActiveRuns,
    ) -> Result<RunResult, String> {
        let setup_started = Instant::now();
        let stdin = open_input(paths.stdin.as_deref())?;
        let stdout = open_output(&paths.stdout)?;
        let stderr = open_output(&paths.stderr)?;
        let inherited = [stdin.0, stdout.0, stderr.0];

        let job = Arc::new(JobHandle::new(spec)?);
        let completion_port = OwnedHandle::new(unsafe {
            CreateIoCompletionPort(INVALID_HANDLE_VALUE, null_mut(), 0, 1)
        })?;
        let association = JOBOBJECT_ASSOCIATE_COMPLETION_PORT {
            CompletionKey: null_mut(),
            CompletionPort: completion_port.0,
        };
        win_bool(
            unsafe {
                SetInformationJobObject(
                    job.handle(),
                    JobObjectAssociateCompletionPortInformation,
                    &association as *const _ as *const c_void,
                    size_of::<JOBOBJECT_ASSOCIATE_COMPLETION_PORT>() as u32,
                )
            },
            "associate Job Object completion port",
        )?;

        let mut security = SECURITY_CAPABILITIES {
            AppContainerSid: self.sid.as_ptr() as PSID,
            Capabilities: null_mut(),
            CapabilityCount: 0,
            Reserved: 0,
        };
        let mut lpac_policy = PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT;
        let mut handles = inherited;
        let compiler_may_spawn = matches!(spec.role, RunRole::Compiler);
        let mut attributes = AttributeList::new(if compiler_may_spawn { 2 } else { 3 })?;
        attributes.update(
            PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
            &mut security as *mut _ as *mut c_void,
            size_of::<SECURITY_CAPABILITIES>(),
        )?;
        if !compiler_may_spawn {
            attributes.update(
                PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY as usize,
                &mut lpac_policy as *mut _ as *mut c_void,
                size_of::<u32>(),
            )?;
        }
        attributes.update(
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
            handles.as_mut_ptr() as *mut c_void,
            size_of_val(&handles),
        )?;

        let mut startup: STARTUPINFOEXW = unsafe { zeroed() };
        startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = stdin.0;
        startup.StartupInfo.hStdOutput = stdout.0;
        startup.StartupInfo.hStdError = stderr.0;
        startup.lpAttributeList = attributes.as_ptr();
        let mut process: PROCESS_INFORMATION = unsafe { zeroed() };
        let application = wide(paths.executable.as_os_str());
        let mut command_line = wide_string(&build_command_line(&paths.executable, &spec.args));
        let current_directory = wide(paths.workspace.as_os_str());
        let mut environment = environment_block(&spec.environment, &paths.workspace);
        let created = unsafe {
            CreateProcessW(
                application.as_ptr(),
                command_line.as_mut_ptr(),
                null(),
                null(),
                1,
                CREATE_SUSPENDED
                    | CREATE_UNICODE_ENVIRONMENT
                    | CREATE_NO_WINDOW
                    | EXTENDED_STARTUPINFO_PRESENT,
                environment.as_mut_ptr() as *const c_void,
                current_directory.as_ptr(),
                &startup.StartupInfo,
                &mut process,
            )
        };
        win_bool(created, "launch AppContainer process")?;
        let process_handle = OwnedHandle(process.hProcess);
        let thread_handle = OwnedHandle(process.hThread);
        if unsafe { AssignProcessToJobObject(job.handle(), process_handle.0) } == 0 {
            let error = io::Error::last_os_error();
            unsafe {
                TerminateJobObject(job.handle(), LIMIT_EXIT_CODE);
            }
            return Err(format!("assign process to Job Object: {error}"));
        }

        let cancelled = Arc::new(AtomicBool::new(false));
        let cancellation: Arc<dyn Cancellation> = Arc::new(RunCancellation {
            job: Arc::clone(&job),
            cancelled: Arc::clone(&cancelled),
        });
        {
            let mut runs = active.lock().unwrap();
            if runs.contains_key(&spec.run_id) {
                unsafe {
                    TerminateJobObject(job.handle(), LIMIT_EXIT_CODE);
                }
                return Err("duplicate active runId".into());
            }
            runs.insert(spec.run_id.clone(), cancellation);
        }
        let (baseline_bytes, baseline_files) = inspect_workspace(&paths.workspace);
        let security_setup_time_us =
            setup_started.elapsed().as_micros().min(u64::MAX as u128) as u64;
        let started = Instant::now();
        if unsafe { ResumeThread(thread_handle.0) } == u32::MAX {
            active.lock().unwrap().remove(&spec.run_id);
            unsafe {
                TerminateJobObject(job.handle(), LIMIT_EXIT_CODE);
            }
            return Err(format!(
                "resume LPAC process: {}",
                io::Error::last_os_error()
            ));
        }
        drop(thread_handle);
        drop(stdin);
        drop(stdout);
        drop(stderr);

        let mut reason = RunReason::Exited;
        let mut diagnostic = None;
        let mut terminated = false;
        let deadline = started + Duration::from_millis(spec.limits.wall_time_ms);
        let mut next_resource_check = started;
        loop {
            let wait = unsafe { WaitForSingleObject(process_handle.0, 2) };
            let mut completion_code = 0_u32;
            let mut completion_key = 0_usize;
            let mut overlapped = null_mut();
            while unsafe {
                GetQueuedCompletionStatus(
                    completion_port.0,
                    &mut completion_code,
                    &mut completion_key,
                    &mut overlapped,
                    0,
                )
            } != 0
            {
                match completion_code {
                    JOB_OBJECT_MSG_JOB_MEMORY_LIMIT => reason = RunReason::MemoryLimit,
                    JOB_OBJECT_MSG_ACTIVE_PROCESS_LIMIT => reason = RunReason::ProcessLimit,
                    _ => {}
                }
            }
            if cancelled.load(Ordering::Acquire) {
                reason = RunReason::Cancelled;
            } else if matches!(reason, RunReason::MemoryLimit | RunReason::ProcessLimit) {
                // Kernel Job notifications outrank deadline/signal heuristics. In particular,
                // a process killed by JobMemoryLimit must never surface as TLE or RE.
            } else if started.elapsed() >= Duration::from_millis(spec.limits.wall_time_ms) {
                reason = RunReason::WallTimeLimit;
            } else if file_size(&paths.stdout).saturating_add(file_size(&paths.stderr))
                > spec.limits.output_bytes
            {
                reason = RunReason::OutputLimit;
            } else if Instant::now() >= next_resource_check
                && deadline.saturating_duration_since(Instant::now()) > Duration::from_millis(100)
            {
                let (workspace_bytes, workspace_files) = inspect_workspace(&paths.workspace);
                if workspace_bytes.saturating_sub(baseline_bytes) > spec.limits.total_write_bytes {
                    reason = RunReason::WriteLimit;
                } else if workspace_files.saturating_sub(baseline_files) > spec.limits.created_files
                {
                    reason = RunReason::WriteLimit;
                    diagnostic = Some("created-file limit exceeded".into());
                } else if count_job_threads(job.handle()).unwrap_or(0) > spec.limits.thread_count {
                    reason = RunReason::ThreadLimit;
                }
                // Toolhelp thread enumeration and recursive quota inspection can be expensive on
                // a busy host. Keep them off the deadline hot path and never start one in the last
                // 100 ms, while kernel Job notifications and stdout size remain continuously polled.
                next_resource_check = Instant::now() + Duration::from_millis(5);
            }

            if !matches!(reason, RunReason::Exited) && !terminated {
                unsafe {
                    TerminateJobObject(
                        job.handle(),
                        if matches!(reason, RunReason::Cancelled) {
                            CANCEL_EXIT_CODE
                        } else {
                            LIMIT_EXIT_CODE
                        },
                    );
                }
                terminated = true;
            }
            if wait == WAIT_OBJECT_0 {
                let accounting = query_accounting(job.handle()).unwrap_or_default();
                if accounting.ActiveProcesses == 0 || terminated {
                    break;
                }
            } else if wait != WAIT_TIMEOUT {
                reason = RunReason::InternalError;
                diagnostic = Some(format!("wait failed with status {wait}"));
                unsafe {
                    TerminateJobObject(job.handle(), LIMIT_EXIT_CODE);
                }
                break;
            }
        }
        let wall_time_us = started.elapsed().as_micros().min(u64::MAX as u128) as u64;
        let collection_started = Instant::now();
        if terminated {
            unsafe {
                WaitForSingleObject(process_handle.0, 5_000);
            }
        }
        if !wait_for_job_empty(job.handle(), Duration::from_secs(5)) {
            reason = RunReason::InternalError;
            diagnostic = Some("Job Object did not become empty during teardown".into());
        }
        active.lock().unwrap().remove(&spec.run_id);

        let mut exit_code = 0_u32;
        let exit_code = if unsafe { GetExitCodeProcess(process_handle.0, &mut exit_code) } != 0 {
            Some(exit_code as i32)
        } else {
            None
        };
        let metrics = query_metrics(job.handle());
        let (user_cpu, kernel_cpu) = process_times(process_handle.0).unwrap_or((None, None));
        let (workspace_bytes, created_files) = inspect_workspace(&paths.workspace);
        if matches!(reason, RunReason::Exited) {
            if workspace_bytes.saturating_sub(baseline_bytes) > spec.limits.total_write_bytes {
                reason = RunReason::WriteLimit;
            } else if created_files.saturating_sub(baseline_files) > spec.limits.created_files {
                reason = RunReason::WriteLimit;
                diagnostic = Some("created-file limit exceeded".into());
            }
        }
        let stdout_bytes = file_size(&paths.stdout);
        let stderr_bytes = file_size(&paths.stderr);
        let result_collection_time_us = collection_started
            .elapsed()
            .as_micros()
            .min(u64::MAX as u128) as u64;
        Ok(RunResult {
            run_id: spec.run_id.clone(),
            reason,
            exit_code,
            signal_or_status: exit_code
                .filter(|code| *code != 0)
                .map(|code| format!("0x{:08X}", code as u32)),
            security_setup_time_us,
            wall_time_us,
            result_collection_time_us,
            user_cpu_time_us: user_cpu,
            kernel_cpu_time_us: kernel_cpu,
            peak_memory_bytes: metrics.map(|value| value.PeakJobMemoryUsed as u64),
            stdout_bytes,
            stderr_bytes,
            created_files: Some(created_files),
            diagnostic,
        })
    }
}

fn protect_cache_directory(path: &Path, app_container_sid: &[u8]) -> Result<(), String> {
    let user_sid = current_user_sid()?;
    let system_sid = well_known_sid(WinLocalSystemSid)?;
    let administrators_sid = well_known_sid(WinBuiltinAdministratorsSid)?;
    let sids: [(&[u8], u32); 4] = [
        (&user_sid, FILE_ALL_ACCESS),
        (&system_sid, FILE_ALL_ACCESS),
        (&administrators_sid, FILE_ALL_ACCESS),
        (app_container_sid, FILE_GENERIC_READ | FILE_GENERIC_EXECUTE),
    ];
    let acl_bytes = size_of::<ACL>()
        + sids
            .iter()
            .map(|(sid, _)| size_of::<ACCESS_ALLOWED_ACE>() - size_of::<u32>() + sid.len())
            .sum::<usize>();
    let mut storage = vec![0_u32; acl_bytes.div_ceil(size_of::<u32>())];
    let acl = storage.as_mut_ptr().cast::<ACL>();
    win_bool(
        unsafe { InitializeAcl(acl, (storage.len() * size_of::<u32>()) as u32, ACL_REVISION) },
        "initialize cache ACL",
    )?;
    for (sid, access) in sids {
        win_bool(
            unsafe {
                AddAccessAllowedAceEx(
                    acl,
                    ACL_REVISION,
                    OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE,
                    access,
                    sid.as_ptr() as PSID,
                )
            },
            "add cache ACL entry",
        )?;
    }
    let wide_path = wide(path.as_os_str());
    let status = unsafe {
        SetNamedSecurityInfoW(
            wide_path.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            acl,
            null(),
        )
    };
    if status != 0 {
        return Err(format!(
            "protect executor cache {}: Windows error {status}",
            path.display()
        ));
    }
    Ok(())
}

fn current_user_sid() -> Result<Vec<u8>, String> {
    let mut token = null_mut();
    win_bool(
        unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) },
        "open executor process token",
    )?;
    let token = OwnedHandle(token);
    let mut bytes = 0_u32;
    unsafe {
        GetTokenInformation(token.0, TokenUser, null_mut(), 0, &mut bytes);
    }
    if bytes < size_of::<TOKEN_USER>() as u32 {
        return Err("query executor token user size failed".into());
    }
    let mut buffer = vec![0_u8; bytes as usize];
    win_bool(
        unsafe {
            GetTokenInformation(
                token.0,
                TokenUser,
                buffer.as_mut_ptr().cast(),
                bytes,
                &mut bytes,
            )
        },
        "query executor token user",
    )?;
    let token_user = unsafe { &*(buffer.as_ptr().cast::<TOKEN_USER>()) };
    clone_sid(token_user.User.Sid)
}

fn well_known_sid(kind: i32) -> Result<Vec<u8>, String> {
    let mut bytes = SECURITY_MAX_SID_SIZE;
    let mut sid = vec![0_u8; bytes as usize];
    win_bool(
        unsafe { CreateWellKnownSid(kind, null_mut(), sid.as_mut_ptr().cast(), &mut bytes) },
        "create well-known cache SID",
    )?;
    sid.truncate(bytes as usize);
    Ok(sid)
}

fn clone_sid(sid: PSID) -> Result<Vec<u8>, String> {
    let length = unsafe { GetLengthSid(sid) } as usize;
    if length == 0 {
        return Err("security identifier has zero length".into());
    }
    let mut copy = vec![0_u8; length];
    unsafe {
        std::ptr::copy_nonoverlapping(sid.cast::<u8>(), copy.as_mut_ptr(), length);
    }
    Ok(copy)
}

struct JobHandle(HANDLE);

unsafe impl Send for JobHandle {}
unsafe impl Sync for JobHandle {}

impl JobHandle {
    fn new(spec: &RunSpec) -> Result<Self, String> {
        let handle = unsafe { CreateJobObjectW(null(), null()) };
        let owned = OwnedHandle::new(handle)?;
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            | JOB_OBJECT_LIMIT_ACTIVE_PROCESS
            | JOB_OBJECT_LIMIT_JOB_MEMORY
            | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
        limits.BasicLimitInformation.ActiveProcessLimit = spec.limits.process_count;
        limits.JobMemoryLimit = spec.limits.memory_bytes as usize;
        win_bool(
            unsafe {
                SetInformationJobObject(
                    owned.0,
                    JobObjectExtendedLimitInformation,
                    &limits as *const _ as *const c_void,
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            },
            "configure Job Object limits",
        )?;
        Ok(Self(owned.into_raw()))
    }

    fn handle(&self) -> HANDLE {
        self.0
    }
}

impl Drop for JobHandle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

struct RunCancellation {
    job: Arc<JobHandle>,
    cancelled: Arc<AtomicBool>,
}

impl Cancellation for RunCancellation {
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        unsafe {
            TerminateJobObject(self.job.handle(), CANCEL_EXIT_CODE);
        }
    }
}

struct OwnedHandle(HANDLE);

impl OwnedHandle {
    fn new(handle: HANDLE) -> Result<Self, String> {
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            Err(io::Error::last_os_error().to_string())
        } else {
            Ok(Self(handle))
        }
    }
    fn into_raw(mut self) -> HANDLE {
        let value = self.0;
        self.0 = null_mut();
        value
    }
}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

struct AttributeList {
    storage: Vec<usize>,
}

impl AttributeList {
    fn new(count: u32) -> Result<Self, String> {
        let mut bytes = 0_usize;
        unsafe {
            InitializeProcThreadAttributeList(null_mut(), count, 0, &mut bytes);
        }
        if unsafe { GetLastError() } != ERROR_INSUFFICIENT_BUFFER || bytes == 0 {
            return Err(format!(
                "size process attribute list: {}",
                io::Error::last_os_error()
            ));
        }
        let mut storage = vec![0_usize; bytes.div_ceil(size_of::<usize>())];
        win_bool(
            unsafe {
                InitializeProcThreadAttributeList(storage.as_mut_ptr().cast(), count, 0, &mut bytes)
            },
            "initialize process attribute list",
        )?;
        Ok(Self { storage })
    }
    fn as_ptr(&mut self) -> *mut c_void {
        self.storage.as_mut_ptr().cast()
    }
    fn update(&mut self, attribute: usize, value: *mut c_void, bytes: usize) -> Result<(), String> {
        win_bool(
            unsafe {
                UpdateProcThreadAttribute(
                    self.as_ptr(),
                    0,
                    attribute,
                    value,
                    bytes,
                    null_mut(),
                    null(),
                )
            },
            "update process attribute",
        )
    }
}

impl Drop for AttributeList {
    fn drop(&mut self) {
        unsafe {
            DeleteProcThreadAttributeList(self.as_ptr());
        }
    }
}

fn create_or_open_profile() -> Result<(Vec<u8>, PathBuf), String> {
    let name = wide_string(PROFILE_NAME);
    let display = wide_string("JudgeDesk Native Secure Executor");
    let description = wide_string("Isolated execution identity for untrusted judging workloads");
    let mut sid: PSID = null_mut();
    let create = unsafe {
        CreateAppContainerProfile(
            name.as_ptr(),
            display.as_ptr(),
            description.as_ptr(),
            null(),
            0,
            &mut sid,
        )
    };
    if create < 0 {
        let already_exists = create as u32 == (0x8007_0000_u32 | ERROR_ALREADY_EXISTS);
        if !already_exists {
            return Err(format!(
                "CreateAppContainerProfile failed: HRESULT 0x{:08X}",
                create as u32
            ));
        }
        let derive = unsafe { DeriveAppContainerSidFromAppContainerName(name.as_ptr(), &mut sid) };
        if derive < 0 {
            return Err(format!(
                "DeriveAppContainerSid failed: HRESULT 0x{:08X}",
                derive as u32
            ));
        }
    }
    if sid.is_null() {
        return Err("AppContainer profile returned a null SID".into());
    }
    let length = unsafe { GetLengthSid(sid) } as usize;
    let mut owned_sid = vec![0_u8; length];
    unsafe {
        std::ptr::copy_nonoverlapping(sid.cast::<u8>(), owned_sid.as_mut_ptr(), length);
    }

    let mut sid_string = null_mut();
    if unsafe { ConvertSidToStringSidW(sid, &mut sid_string) } == 0 {
        unsafe {
            FreeSid(sid);
        }
        return Err(format!(
            "ConvertSidToStringSidW failed: {}",
            io::Error::last_os_error()
        ));
    }
    let sid_text = unsafe { wide_ptr_to_string(sid_string) };
    unsafe {
        LocalFree(sid_string.cast());
        FreeSid(sid);
    }
    let sid_wide = wide_string(&sid_text);
    let mut folder = null_mut();
    let result = unsafe { GetAppContainerFolderPath(sid_wide.as_ptr(), &mut folder) };
    if result < 0 || folder.is_null() {
        return Err(format!(
            "GetAppContainerFolderPath failed: HRESULT 0x{:08X}",
            result as u32
        ));
    }
    let folder_path = PathBuf::from(unsafe { wide_ptr_to_string(folder) });
    unsafe {
        CoTaskMemFree(folder.cast());
    }
    Ok((owned_sid, folder_path))
}

fn open_input(path: Option<&Path>) -> Result<OwnedHandle, String> {
    let path = path
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("NUL"));
    open_file(&path, GENERIC_READ, OPEN_EXISTING, FILE_SHARE_READ)
}

fn open_output(path: &Path) -> Result<OwnedHandle, String> {
    open_file(
        path,
        GENERIC_WRITE,
        CREATE_ALWAYS,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
    )
}

fn open_file(
    path: &Path,
    access: u32,
    disposition: u32,
    share: u32,
) -> Result<OwnedHandle, String> {
    let wide_path = wide(path.as_os_str());
    let security = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: null_mut(),
        bInheritHandle: 1,
    };
    OwnedHandle::new(unsafe {
        CreateFileW(
            wide_path.as_ptr(),
            access,
            share,
            &security,
            disposition,
            FILE_ATTRIBUTE_NORMAL,
            null_mut(),
        )
    })
    .map_err(|error| format!("open {}: {error}", path.display()))
}

fn query_metrics(job: HANDLE) -> Option<JOBOBJECT_EXTENDED_LIMIT_INFORMATION> {
    let mut value: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
    let ok = unsafe {
        QueryInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &mut value as *mut _ as *mut c_void,
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            null_mut(),
        )
    };
    (ok != 0).then_some(value)
}

fn query_accounting(job: HANDLE) -> Option<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION> {
    let mut value: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { zeroed() };
    let ok = unsafe {
        QueryInformationJobObject(
            job,
            JobObjectBasicAccountingInformation,
            &mut value as *mut _ as *mut c_void,
            size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
            null_mut(),
        )
    };
    (ok != 0).then_some(value)
}

fn wait_for_job_empty(job: HANDLE, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if query_accounting(job).is_some_and(|value| value.ActiveProcesses == 0) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(1));
    }
}

fn count_job_threads(job: HANDLE) -> Option<u32> {
    const MAX_PROCESSES: usize = 64;
    let mut buffer = vec![0_usize; MAX_PROCESSES + 2];
    let list = buffer.as_mut_ptr() as *mut JOBOBJECT_BASIC_PROCESS_ID_LIST;
    let ok = unsafe {
        QueryInformationJobObject(
            job,
            JobObjectBasicProcessIdList,
            list.cast(),
            (buffer.len() * size_of::<usize>()) as u32,
            null_mut(),
        )
    };
    if ok == 0 {
        return None;
    }
    let count = unsafe { (*list).NumberOfProcessIdsInList as usize }.min(MAX_PROCESSES);
    let first = unsafe { (*list).ProcessIdList.as_ptr() };
    let pids: HashSet<u32> = (0..count)
        .map(|index| unsafe { *first.add(index) as u32 })
        .collect();
    let snapshot =
        OwnedHandle::new(unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) }).ok()?;
    let mut entry: THREADENTRY32 = unsafe { zeroed() };
    entry.dwSize = size_of::<THREADENTRY32>() as u32;
    let mut threads = 0_u32;
    let mut present = unsafe { Thread32First(snapshot.0, &mut entry) } != 0;
    while present {
        if pids.contains(&entry.th32OwnerProcessID) {
            threads = threads.saturating_add(1);
        }
        present = unsafe { Thread32Next(snapshot.0, &mut entry) } != 0;
    }
    Some(threads)
}

fn process_times(process: HANDLE) -> Option<(Option<u64>, Option<u64>)> {
    let mut created: FILETIME = unsafe { zeroed() };
    let mut exited: FILETIME = unsafe { zeroed() };
    let mut kernel: FILETIME = unsafe { zeroed() };
    let mut user: FILETIME = unsafe { zeroed() };
    if unsafe { GetProcessTimes(process, &mut created, &mut exited, &mut kernel, &mut user) } == 0 {
        return None;
    }
    let micros =
        |value: FILETIME| (((value.dwHighDateTime as u64) << 32) | value.dwLowDateTime as u64) / 10;
    Some((Some(micros(user)), Some(micros(kernel))))
}

fn environment_block(values: &BTreeMap<String, String>, workspace: &Path) -> Vec<u16> {
    let mut environment = BTreeMap::new();
    let workspace_text = workspace.to_string_lossy().into_owned();
    if workspace_text.as_bytes().get(1) == Some(&b':') {
        // CreateProcess requires the hidden per-drive current-directory variable when a
        // caller supplies a custom environment block and lpCurrentDirectory.
        environment.insert(format!("={}", &workspace_text[..2]), workspace_text.clone());
    }
    const SAFE_PARENT_VARIABLES: &[&str] = &[
        "ALLUSERSPROFILE",
        "APPDATA",
        "CommonProgramFiles",
        "CommonProgramFiles(x86)",
        "CommonProgramW6432",
        "COMSPEC",
        "HOMEDRIVE",
        "HOMEPATH",
        "LOCALAPPDATA",
        "OS",
        "Path",
        "PATHEXT",
        "ProgramData",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ProgramW6432",
        "PUBLIC",
        "SystemDrive",
        "SystemRoot",
        "USERPROFILE",
        "windir",
    ];
    for key in SAFE_PARENT_VARIABLES {
        if let Ok(value) = std::env::var(key) {
            environment.insert((*key).to_string(), value);
        }
    }
    environment.insert("TEMP".into(), workspace_text.clone());
    environment.insert("TMP".into(), workspace_text);
    for (key, value) in values {
        environment.insert(key.clone(), value.clone());
    }
    let mut block = Vec::new();
    for (key, value) in environment {
        block.extend(format!("{key}={value}").encode_utf16());
        block.push(0);
    }
    block.push(0);
    block
}

fn build_command_line(executable: &Path, arguments: &[String]) -> String {
    std::iter::once(executable.to_string_lossy().into_owned())
        .chain(arguments.iter().cloned())
        .map(|value| quote_windows_argument(&value))
        .collect::<Vec<_>>()
        .join(" ")
}

fn quote_windows_argument(value: &str) -> String {
    if !value.is_empty()
        && !value
            .chars()
            .any(|character| character.is_whitespace() || character == '"')
    {
        return value.to_string();
    }
    let mut result = String::from("\"");
    let mut slashes = 0;
    for character in value.chars() {
        if character == '\\' {
            slashes += 1;
        } else if character == '"' {
            result.push_str(&"\\".repeat(slashes * 2 + 1));
            result.push('"');
            slashes = 0;
        } else {
            result.push_str(&"\\".repeat(slashes));
            slashes = 0;
            result.push(character);
        }
    }
    result.push_str(&"\\".repeat(slashes * 2));
    result.push('"');
    result
}

fn win_bool(value: i32, action: &str) -> Result<(), String> {
    if value == 0 {
        Err(format!("{action}: {}", io::Error::last_os_error()))
    } else {
        Ok(())
    }
}

fn wide(value: &std::ffi::OsStr) -> Vec<u16> {
    value.encode_wide().chain(std::iter::once(0)).collect()
}

fn wide_string(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

unsafe fn wide_ptr_to_string(pointer: *const u16) -> String {
    let mut length = 0;
    while *pointer.add(length) != 0 {
        length += 1;
    }
    String::from_utf16_lossy(std::slice::from_raw_parts(pointer, length))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_argument_quoting_preserves_spaces_quotes_and_trailing_slashes() {
        assert_eq!(quote_windows_argument("plain"), "plain");
        assert_eq!(quote_windows_argument("two words"), "\"two words\"");
        assert_eq!(quote_windows_argument("a\"b"), "\"a\\\"b\"");
        assert_eq!(
            quote_windows_argument("C:\\path with space\\"),
            "\"C:\\path with space\\\\\""
        );
    }
}
