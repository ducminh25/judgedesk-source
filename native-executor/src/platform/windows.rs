mod launch;

use super::{failure, reported_peak_memory_bytes, root_display, ActiveRuns, Cancellation};
use crate::protocol::{
    ExecutorHealth, ExecutorStartupTimings, InteractiveRunResult, InteractiveRunSpec,
    LocalToolchainIsolation, RunReason, RunResult, RunRole, RunSpec,
};
use crate::request_validation::ValidatedRun;
use crate::workspace::{file_size, initialize_root, inspect_workspace};
use launch::create_process;
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
    CloseHandle, GetLastError, LocalFree, ERROR_ALREADY_EXISTS, ERROR_COMMITMENT_LIMIT,
    ERROR_INSUFFICIENT_BUFFER, ERROR_NOT_ENOUGH_MEMORY, ERROR_OUTOFMEMORY, FILETIME, GENERIC_READ,
    GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, GetNamedSecurityInfoW, SetNamedSecurityInfoW, SE_FILE_OBJECT,
};
use windows_sys::Win32::Security::Isolation::{
    CreateAppContainerProfile, DeriveAppContainerSidFromAppContainerName, GetAppContainerFolderPath,
};
use windows_sys::Win32::Security::{
    AclSizeInformation, AddAccessAllowedAceEx, CreateWellKnownSid, DeriveCapabilitySidsFromName,
    EqualSid, FreeSid, GetAce, GetAclInformation, GetLengthSid, GetSecurityDescriptorControl,
    GetTokenInformation, InitializeAcl, TokenUser, WinBuiltinAdministratorsSid, WinLocalSystemSid,
    ACCESS_ALLOWED_ACE, ACL, ACL_REVISION, ACL_SIZE_INFORMATION, CONTAINER_INHERIT_ACE,
    DACL_SECURITY_INFORMATION, OBJECT_INHERIT_ACE, PROTECTED_DACL_SECURITY_INFORMATION,
    PSECURITY_DESCRIPTOR, PSID, SECURITY_ATTRIBUTES, SECURITY_CAPABILITIES, SECURITY_MAX_SID_SIZE,
    SE_DACL_PROTECTED, SID_AND_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, CREATE_ALWAYS, FILE_ALL_ACCESS, FILE_ATTRIBUTE_NORMAL, FILE_GENERIC_EXECUTE,
    FILE_GENERIC_READ, FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_TRAVERSE, OPEN_EXISTING,
};
use windows_sys::Win32::System::Com::CoTaskMemFree;
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
};
use windows_sys::Win32::System::JobObjects::{
    CreateJobObjectW, JobObjectAssociateCompletionPortInformation,
    JobObjectBasicAccountingInformation, JobObjectBasicProcessIdList,
    JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
    TerminateJobObject, JOBOBJECT_ASSOCIATE_COMPLETION_PORT,
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_BASIC_PROCESS_ID_LIST,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_ACTIVE_PROCESS,
    JOB_OBJECT_LIMIT_AFFINITY, JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION,
    JOB_OBJECT_LIMIT_JOB_MEMORY, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::SystemServices::{
    ACCESS_ALLOWED_ACE_TYPE, JOB_OBJECT_MSG_ACTIVE_PROCESS_LIMIT, JOB_OBJECT_MSG_JOB_MEMORY_LIMIT,
    SE_GROUP_ENABLED,
};
use windows_sys::Win32::System::Threading::{
    DeleteProcThreadAttributeList, GetCurrentProcess, GetExitCodeProcess, GetProcessAffinityMask,
    GetProcessTimes, InitializeProcThreadAttributeList, OpenProcessToken, ResumeThread,
    UpdateProcThreadAttribute, WaitForSingleObject, PROCESS_INFORMATION,
    PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
    PROC_THREAD_ATTRIBUTE_JOB_LIST, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
    STARTF_USESTDHANDLES, STARTUPINFOEXW,
};
use windows_sys::Win32::System::WindowsProgramming::PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT;
use windows_sys::Win32::System::IO::{CreateIoCompletionPort, GetQueuedCompletionStatus};

const PROFILE_NAME: &str = "JudgeDesk.NativeSecureExecutor.v1";
const CANCEL_EXIT_CODE: u32 = 0x4a44_0001;
const LIMIT_EXIT_CODE: u32 = 0x4a44_0002;
const MANAGED_RUNTIME_MARKERS: [&str; 6] = [
    "JUDGEDESK_PYTHON_ISOLATED",
    "JUDGEDESK_NODE_ISOLATED",
    "JUDGEDESK_JAVA_ISOLATED",
    "JUDGEDESK_DOTNET_ISOLATED",
    "JUDGEDESK_SCRATCH_ISOLATED",
    "JUDGEDESK_PASCAL_ISOLATED",
];

pub struct WindowsPlatform {
    sid: Vec<u8>,
    self_test: SelfTest,
    startup_timings: ExecutorStartupTimings,
}

struct SelfTest {
    ready: bool,
    diagnostics: Vec<String>,
    network_blocked: bool,
    filesystem_isolated: bool,
    process_tree_controlled: bool,
}

impl WindowsPlatform {
    pub fn initialize_with_root(base_dir: PathBuf) -> Result<(Self, PathBuf), String> {
        let startup_started = Instant::now();
        let mut phases = BTreeMap::new();
        let phase_started = Instant::now();
        let (sid, _) = create_or_open_profile()?;
        phases.insert("profile".into(), elapsed_us(phase_started));
        let phase_started = Instant::now();
        let root = initialize_root(base_dir.join("JudgeDesk"))?;
        phases.insert("root".into(), elapsed_us(phase_started));
        let phase_started = Instant::now();
        protect_cache_directory(&root.join("toolchains"), &sid)?;
        phases.insert("toolchainAcl".into(), elapsed_us(phase_started));
        let phase_started = Instant::now();
        protect_cache_directory(&root.join("artifacts"), &sid)?;
        phases.insert("artifactAcl".into(), elapsed_us(phase_started));
        let phase_started = Instant::now();
        protect_workspace_parent(&root.join("workspaces"), &sid)?;
        phases.insert("workspaceAcl".into(), elapsed_us(phase_started));
        let mut platform = Self {
            sid,
            self_test: SelfTest {
                ready: false,
                diagnostics: vec!["security self-test has not run".into()],
                network_blocked: false,
                filesystem_isolated: false,
                process_tree_controlled: false,
            },
            startup_timings: ExecutorStartupTimings {
                total_time_us: 0,
                phases,
            },
        };
        let phase_started = Instant::now();
        platform.self_test = platform.run_self_test(&root);
        platform
            .startup_timings
            .phases
            .insert("selfTest".into(), elapsed_us(phase_started));
        platform.startup_timings.total_time_us = elapsed_us(startup_started);
        Ok((platform, root))
    }

    pub fn initialize() -> Result<(Self, PathBuf), String> {
        #[cfg(test)]
        let base_dir = {
            let dir = std::env::temp_dir().join(format!(
                "jd_test_executor_{}_{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0)
            ));
            std::fs::create_dir(&dir)
                .map_err(|error| format!("cannot create owned executor test root: {error}"))?;
            std::fs::write(dir.join(".judgedesk-test-root"), b"judgedesk-test-owned\n")
                .map_err(|error| format!("cannot mark owned executor test root: {error}"))?;
            dir
        };
        #[cfg(not(test))]
        let base_dir = {
            std::env::var_os("LOCALAPPDATA")
                .map(PathBuf::from)
                .unwrap_or_else(|| {
                    let (_, profile_root) =
                        create_or_open_profile().unwrap_or_else(|_| (vec![], std::env::temp_dir()));
                    profile_root.join("LocalState")
                })
        };
        Self::initialize_with_root(base_dir)
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
            startup_timings: Some(self.startup_timings.clone()),
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
            fs::create_dir_all(&workspace)
                .map_err(|error| format!("cannot create self-test workspace: {error}"))?;
            let probe = workspace.join("probe.exe");
            let current_exe = std::env::var_os("JUDGEDESK_EXECUTOR_PATH")
                .map(PathBuf::from)
                .filter(|p| p.is_file())
                .or_else(|| std::env::current_exe().ok())
                .ok_or_else(|| "cannot determine probe executable".to_string())?;
            let need_copy = match (fs::metadata(&current_exe), fs::metadata(&probe)) {
                (Ok(src_meta), Ok(dst_meta)) => src_meta.len() != dst_meta.len(),
                _ => true,
            };
            if need_copy {
                let _ = fs::remove_file(&probe);
                fs::copy(&current_exe, &probe)
                    .map_err(|error| format!("cannot stage security probe: {error}"))?;
            }
            let _ = fs::remove_file(workspace.join("probe.stdout"));
            let _ = fs::remove_file(workspace.join("probe.stderr"));
            let sentinel =
                std::env::temp_dir().join(format!("judgedesk-sentinel-{}.txt", std::process::id()));
            let _ = fs::remove_file(&sentinel);
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
                toolchain: None,
                local_toolchain: None,
                limits: crate::protocol::RunLimits {
                    wall_time_ms: 20_000,
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
            let process = probe["processAttemptStarted"].as_bool() == Some(true)
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
        // A single long-lived AppContainer package SID would otherwise let two
        // concurrent submissions inspect each other's workspace under
        // LocalState. Give every run an unforgeable capability SID and protect
        // the complete workspace tree with that SID before any handle is
        // opened or process is created.
        prepare_workspace_profile_directories(&paths.workspace)?;
        let workspace_capability_sid = derive_workspace_capability_sid(&spec.workspace_id)?;
        protect_workspace_tree(&paths.workspace, &workspace_capability_sid)?;
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

        let mut workspace_capability = SID_AND_ATTRIBUTES {
            Sid: workspace_capability_sid.as_ptr() as PSID,
            Attributes: SE_GROUP_ENABLED as u32,
        };
        let mut security = SECURITY_CAPABILITIES {
            AppContainerSid: self.sid.as_ptr() as PSID,
            Capabilities: &mut workspace_capability,
            CapabilityCount: 1,
            Reserved: 0,
        };
        let mut lpac_policy = PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT;
        let mut handles = inherited;
        let compiler_may_spawn = matches!(spec.role, RunRole::Compiler);
        // Managed language runtimes depend on system DLLs and registry/file resources
        // granted to regular AppContainers through ALL APPLICATION PACKAGES. LPAC opts out of
        // those grants: CPython terminates with STATUS_ACCESS_DENIED and Node fails WSAStartup
        // before user code runs. The typed submission role plus an exact runtime marker select
        // this compatibility boundary. A regular AppContainer still has no capabilities, so
        // network and private user-file access remain default-deny; the Job Object continues to
        // enforce process and resource limits.
        let isolated_submission_runtime = matches!(spec.role, RunRole::Submission)
            && (spec.toolchain.is_some()
                || spec.local_toolchain.is_some()
                || spec
                    .environment
                    .get("JUDGEDESK_PASCAL_ISOLATED")
                    .map(String::as_str)
                    == Some("1"))
            && MANAGED_RUNTIME_MARKERS
                .iter()
                .any(|marker| spec.environment.get(*marker).map(String::as_str) == Some("1"));
        let managed_checker_runtime = matches!(spec.role, RunRole::CheckerRuntime);
        let resource_only = matches!(paths.isolation, LocalToolchainIsolation::ResourceOnly);
        let use_lpac = !resource_only
            && !compiler_may_spawn
            && !isolated_submission_runtime
            && !managed_checker_runtime;
        let attribute_count = if resource_only {
            2
        } else if use_lpac {
            4
        } else {
            3
        };
        let mut attributes = AttributeList::new(attribute_count)?;
        if !resource_only {
            attributes.update(
                PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
                &mut security as *mut _ as *mut c_void,
                size_of::<SECURITY_CAPABILITIES>(),
            )?;
        }
        if use_lpac {
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
        // Assign the child during CreateProcess. AssignProcessToJobObject after
        // CREATE_SUSPENDED is still too late for PE image/stack commit: Windows
        // explicitly excludes memory operations performed before association.
        let mut job_handles = [job.handle()];
        attributes.update(
            PROC_THREAD_ATTRIBUTE_JOB_LIST as usize,
            job_handles.as_mut_ptr().cast(),
            size_of_val(&job_handles),
        )?;

        let mut startup: STARTUPINFOEXW = unsafe { zeroed() };
        startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = stdin.0;
        startup.StartupInfo.hStdOutput = stdout.0;
        startup.StartupInfo.hStdError = stderr.0;
        startup.lpAttributeList = attributes.as_ptr();
        let mut process: PROCESS_INFORMATION = unsafe { zeroed() };
        // std::fs::canonicalize returns a verbatim (\\?\) path on Windows.
        // That identity is useful for the security checks above, but several
        // relocatable toolchains derive their installation root from argv[0].
        // OpenJDK's JDK_Canonicalize rejects a verbatim modules-image path and
        // aborts before javac/main can start. Pass the equivalent DOS/UNC path
        // to the child only after validation has completed.
        let launch_executable = process_launch_path(&paths.executable);
        let launch_workspace = process_launch_path(&paths.workspace);
        let application = wide(launch_executable.as_os_str());
        let mut command_line = wide_string(&build_command_line(&launch_executable, &spec.args));
        let current_directory = wide(launch_workspace.as_os_str());
        let mut environment = environment_block(&spec.environment, &launch_workspace);
        // SAFETY: launch buffers and all startup attributes remain live until creation returns.
        let created = unsafe {
            create_process(
                &application,
                &mut command_line,
                &mut environment,
                &current_directory,
                &startup,
                &mut process,
            )
        };
        if created == 0 {
            let error_code = unsafe { GetLastError() };
            let error = io::Error::from_raw_os_error(error_code as i32);
            if is_process_creation_memory_error(error_code) {
                let mut result = failure(
                    spec,
                    RunReason::MemoryLimit,
                    format!("process image exceeded the Job memory limit during creation: {error}"),
                );
                result.security_setup_time_us =
                    setup_started.elapsed().as_micros().min(u64::MAX as u128) as u64;
                result.peak_memory_bytes = query_metrics(job.handle())
                    .map(|value| (value.PeakJobMemoryUsed as u64).min(spec.limits.memory_bytes));
                return Ok(result);
            }
            return Err(launch::failure_diagnostic(error_code));
        }
        let process_handle = OwnedHandle(process.hProcess);
        let thread_handle = OwnedHandle(process.hThread);

        let cancelled = Arc::new(AtomicBool::new(false));
        let cancellation: Arc<dyn Cancellation> = Arc::new(RunCancellation {
            job: Arc::clone(&job),
            cancelled: Arc::clone(&cancelled),
        });
        {
            let mut runs = active.lock().unwrap_or_else(|p| p.into_inner());
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
            active
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(&spec.run_id);
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
        active
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&spec.run_id);

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
        let peak_memory_bytes = reported_peak_memory_bytes(
            &reason,
            metrics.map(|value| value.PeakJobMemoryUsed as u64),
            spec.limits.memory_bytes,
        );

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
            peak_memory_bytes,
            stdout_bytes,
            stderr_bytes,
            created_files: Some(created_files),
            diagnostic,
        })
    }

    pub fn run_interactive(
        &self,
        root: &Path,
        spec: &InteractiveRunSpec,
        active: &ActiveRuns,
    ) -> InteractiveRunResult {
        match self.run_interactive_inner(root, spec, active) {
            Ok(result) => result,
            Err(diagnostic) => crate::platform::interactive_failure(spec, diagnostic),
        }
    }

    fn run_interactive_inner(
        &self,
        root: &Path,
        spec: &InteractiveRunSpec,
        active: &ActiveRuns,
    ) -> Result<InteractiveRunResult, String> {
        let setup_started = Instant::now();
        let sub_paths = crate::request_validation::validate_run(root, &spec.submission)?;
        let inter_paths = crate::request_validation::validate_run(root, &spec.interactor)?;
        crate::request_validation::validate_interactive_pair(spec, &sub_paths, &inter_paths)?;

        prepare_workspace_profile_directories(&sub_paths.workspace)?;
        let sub_workspace_sid = derive_workspace_capability_sid(&spec.submission.workspace_id)?;
        protect_workspace_tree(&sub_paths.workspace, &sub_workspace_sid)?;

        prepare_workspace_profile_directories(&inter_paths.workspace)?;
        let inter_workspace_sid = derive_workspace_capability_sid(&spec.interactor.workspace_id)?;
        protect_workspace_tree(&inter_paths.workspace, &inter_workspace_sid)?;

        let sa = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: null_mut(),
            bInheritHandle: 1,
        };

        // Pipe 1: Interactor STDOUT -> Submission STDIN
        let mut sub_stdin_read = INVALID_HANDLE_VALUE;
        let mut inter_stdout_write = INVALID_HANDLE_VALUE;
        if unsafe {
            CreatePipe(
                &mut sub_stdin_read,
                &mut inter_stdout_write,
                &sa,
                1024 * 1024,
            )
        } == 0
        {
            return Err(format!("create pipe 1: {}", io::Error::last_os_error()));
        }
        let sub_stdin_r = OwnedHandle::new(sub_stdin_read)?;
        let inter_stdout_w = OwnedHandle::new(inter_stdout_write)?;

        // Pipe 2: Submission STDOUT -> Interactor STDIN
        let mut inter_stdin_read = INVALID_HANDLE_VALUE;
        let mut sub_stdout_write = INVALID_HANDLE_VALUE;
        if unsafe {
            CreatePipe(
                &mut inter_stdin_read,
                &mut sub_stdout_write,
                &sa,
                1024 * 1024,
            )
        } == 0
        {
            return Err(format!("create pipe 2: {}", io::Error::last_os_error()));
        }
        let inter_stdin_r = OwnedHandle::new(inter_stdin_read)?;
        let sub_stdout_w = OwnedHandle::new(sub_stdout_write)?;

        let sub_stderr = open_output(&sub_paths.stderr)?;
        let inter_stderr = open_output(&inter_paths.stderr)?;

        let job_sub = Arc::new(JobHandle::new(&spec.submission)?);
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
                    job_sub.handle(),
                    JobObjectAssociateCompletionPortInformation,
                    &association as *const _ as *const c_void,
                    size_of::<JOBOBJECT_ASSOCIATE_COMPLETION_PORT>() as u32,
                )
            },
            "associate submission Job completion port",
        )?;

        let job_inter = Arc::new(JobHandle::new(&spec.interactor)?);

        let (sub_process, sub_thread) = match spawn_child_process(
            &spec.submission,
            &sub_paths,
            &sub_workspace_sid,
            &self.sid,
            job_sub.handle(),
            ChildHandles {
                stdin: sub_stdin_r.0,
                stdout: sub_stdout_w.0,
                stderr: sub_stderr.0,
            },
        ) {
            Ok(handles) => handles,
            Err(SpawnError::ProcessCreationMemory(err)) => {
                let res = failure(
                    &spec.submission,
                    RunReason::MemoryLimit,
                    format!("submission image exceeded memory limit during creation: {err}"),
                );
                return Ok(InteractiveRunResult {
                    run_id: spec.run_id.clone(),
                    verdict: "MLE".into(),
                    score_multiplier: Some(0.0),
                    execution_time_ms: 0,
                    peak_memory_bytes: query_metrics(job_sub.handle()).map(|v| {
                        (v.PeakJobMemoryUsed as u64).min(spec.submission.limits.memory_bytes)
                    }),
                    message: Some("Memory limit exceeded during process creation".into()),
                    transcript: None,
                    submission_result: res,
                    interactor_result: failure(
                        &spec.interactor,
                        RunReason::Cancelled,
                        "cancelled".into(),
                    ),
                });
            }
            Err(SpawnError::Failed(msg)) => return Err(format!("spawn submission: {msg}")),
        };

        let inter_spawn = spawn_child_process(
            &spec.interactor,
            &inter_paths,
            &inter_workspace_sid,
            &self.sid,
            job_inter.handle(),
            ChildHandles {
                stdin: inter_stdin_r.0,
                stdout: inter_stdout_w.0,
                stderr: inter_stderr.0,
            },
        );
        // The first child is still suspended and not registered in ActiveRuns.
        // Do not release this accepted run until its exact child and Job are drained.
        if inter_spawn.is_err() {
            launch::drain_suspended_child(job_sub.handle(), sub_process.0);
        }
        let (inter_process, inter_thread) = match inter_spawn {
            Ok(handles) => handles,
            Err(SpawnError::ProcessCreationMemory(err)) => {
                return Err(format!("interactor memory error: {err}"))
            }
            Err(SpawnError::Failed(msg)) => return Err(format!("spawn interactor: {msg}")),
        };

        // Crucial: close parent pipe handles immediately so EOF is transmitted when either process closes/exits
        drop(sub_stdin_r);
        drop(sub_stdout_w);
        drop(sub_stderr);
        drop(inter_stdin_r);
        drop(inter_stdout_w);
        drop(inter_stderr);

        let cancelled = Arc::new(AtomicBool::new(false));
        let cancellation: Arc<dyn Cancellation> = Arc::new(InteractiveCancellation {
            job_sub: Arc::clone(&job_sub),
            job_inter: Arc::clone(&job_inter),
            cancelled: Arc::clone(&cancelled),
        });

        {
            let mut runs = active.lock().unwrap_or_else(|p| p.into_inner());
            if runs.contains_key(&spec.run_id) {
                unsafe {
                    TerminateJobObject(job_sub.handle(), LIMIT_EXIT_CODE);
                    TerminateJobObject(job_inter.handle(), LIMIT_EXIT_CODE);
                }
                return Err("duplicate active runId".into());
            }
            runs.insert(spec.run_id.clone(), cancellation);
        }

        let security_setup_time_us = elapsed_us(setup_started);
        let started = Instant::now();

        if unsafe { ResumeThread(sub_thread.0) } == u32::MAX {
            active
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(&spec.run_id);
            unsafe {
                TerminateJobObject(job_sub.handle(), LIMIT_EXIT_CODE);
                TerminateJobObject(job_inter.handle(), LIMIT_EXIT_CODE);
            }
            return Err(format!(
                "resume submission process: {}",
                io::Error::last_os_error()
            ));
        }
        if unsafe { ResumeThread(inter_thread.0) } == u32::MAX {
            active
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(&spec.run_id);
            unsafe {
                TerminateJobObject(job_sub.handle(), LIMIT_EXIT_CODE);
                TerminateJobObject(job_inter.handle(), LIMIT_EXIT_CODE);
            }
            return Err(format!(
                "resume interactor process: {}",
                io::Error::last_os_error()
            ));
        }
        drop(sub_thread);
        drop(inter_thread);

        let sub_limit_ms = spec.submission.limits.wall_time_ms;
        let watchdog_deadline =
            started + Duration::from_millis((sub_limit_ms * 2).max(sub_limit_ms + 2000));
        let mut sub_reason = RunReason::Exited;
        let mut inter_exited = false;
        let mut sub_exited = false;

        loop {
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
                    JOB_OBJECT_MSG_JOB_MEMORY_LIMIT => sub_reason = RunReason::MemoryLimit,
                    JOB_OBJECT_MSG_ACTIVE_PROCESS_LIMIT => sub_reason = RunReason::ProcessLimit,
                    _ => {}
                }
            }

            if cancelled.load(Ordering::Acquire) {
                sub_reason = RunReason::Cancelled;
                unsafe {
                    TerminateJobObject(job_sub.handle(), CANCEL_EXIT_CODE);
                    TerminateJobObject(job_inter.handle(), CANCEL_EXIT_CODE);
                }
                break;
            }

            if matches!(sub_reason, RunReason::MemoryLimit | RunReason::ProcessLimit) {
                unsafe {
                    TerminateJobObject(job_sub.handle(), LIMIT_EXIT_CODE);
                    TerminateJobObject(job_inter.handle(), LIMIT_EXIT_CODE);
                }
                break;
            }

            if Instant::now() >= watchdog_deadline {
                sub_reason = RunReason::WallTimeLimit;
                unsafe {
                    TerminateJobObject(job_sub.handle(), LIMIT_EXIT_CODE);
                    TerminateJobObject(job_inter.handle(), LIMIT_EXIT_CODE);
                }
                break;
            }

            if !inter_exited {
                let wait_inter = unsafe { WaitForSingleObject(inter_process.0, 5) };
                if wait_inter == WAIT_OBJECT_0 {
                    inter_exited = true;
                }
            }

            if !sub_exited {
                let wait_sub = unsafe { WaitForSingleObject(sub_process.0, 5) };
                if wait_sub == WAIT_OBJECT_0 {
                    sub_exited = true;
                }
            }

            if inter_exited {
                unsafe {
                    WaitForSingleObject(sub_process.0, 50);
                    TerminateJobObject(job_sub.handle(), LIMIT_EXIT_CODE);
                }
                break;
            }

            if sub_exited {
                unsafe {
                    WaitForSingleObject(inter_process.0, 200);
                    TerminateJobObject(job_inter.handle(), LIMIT_EXIT_CODE);
                }
                break;
            }
        }

        let wall_time_us = elapsed_us(started);
        let collection_started = Instant::now();

        let _ = wait_for_job_empty(job_sub.handle(), Duration::from_secs(2));
        let _ = wait_for_job_empty(job_inter.handle(), Duration::from_secs(2));
        active
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&spec.run_id);

        let mut sub_code = 0_u32;
        let sub_exit_code = if unsafe { GetExitCodeProcess(sub_process.0, &mut sub_code) } != 0 {
            Some(sub_code as i32)
        } else {
            None
        };

        let mut inter_code = 0_u32;
        let inter_exit_code =
            if unsafe { GetExitCodeProcess(inter_process.0, &mut inter_code) } != 0 {
                Some(inter_code as i32)
            } else {
                None
            };

        let (sub_user_cpu, sub_kernel_cpu) = process_times(sub_process.0).unwrap_or((None, None));
        let sub_cpu_us = sub_user_cpu.unwrap_or(0) + sub_kernel_cpu.unwrap_or(0);
        let execution_time_ms = sub_cpu_us / 1000;

        if execution_time_ms > spec.submission.limits.wall_time_ms {
            sub_reason = RunReason::WallTimeLimit;
        }

        let sub_metrics = query_metrics(job_sub.handle());
        let peak_memory_bytes = reported_peak_memory_bytes(
            &sub_reason,
            sub_metrics.map(|v| v.PeakJobMemoryUsed as u64),
            spec.submission.limits.memory_bytes,
        );

        let inter_stderr_str = if inter_paths.stderr.exists() {
            fs::read_to_string(&inter_paths.stderr).unwrap_or_default()
        } else {
            String::new()
        };

        let transcript = if let Some(arg) = spec.interactor.args.get(1) {
            let p = inter_paths.workspace.join(arg);
            if p.exists() {
                fs::read_to_string(&p).ok()
            } else {
                None
            }
        } else {
            None
        };

        let result_collection_time_us = elapsed_us(collection_started);

        let (verdict, score_multiplier, message) = if matches!(sub_reason, RunReason::MemoryLimit) {
            (
                "MLE".to_string(),
                Some(0.0),
                Some("Memory limit exceeded".into()),
            )
        } else if matches!(sub_reason, RunReason::WallTimeLimit) {
            (
                "TLE".to_string(),
                Some(0.0),
                Some("Time limit exceeded".into()),
            )
        } else if matches!(sub_reason, RunReason::Cancelled) {
            ("CANCELLED".to_string(), Some(0.0), Some("Cancelled".into()))
        } else {
            match inter_exit_code {
                Some(0) => ("AC".to_string(), Some(1.0), Some(inter_stderr_str)),
                Some(1) => ("WA".to_string(), Some(0.0), Some(inter_stderr_str)),
                Some(2) => ("PE".to_string(), Some(0.0), Some(inter_stderr_str)),
                Some(7) => ("PARTIAL".to_string(), None, Some(inter_stderr_str)),
                Some(code) if code >= 16 => {
                    let mult = ((code - 16) as f64) / 100.0;
                    (
                        "PARTIAL".to_string(),
                        Some(mult.clamp(0.0, 1.0)),
                        Some(inter_stderr_str),
                    )
                }
                Some(3) => (
                    "JE".to_string(),
                    Some(0.0),
                    Some(format!("Interactor failed: {inter_stderr_str}")),
                ),
                _ => {
                    if let Some(code) = sub_exit_code {
                        if code != 0 {
                            (
                                "RTE".to_string(),
                                Some(0.0),
                                Some(format!("Runtime error (exit code {code})")),
                            )
                        } else {
                            ("JE".to_string(), Some(0.0), Some(format!("Unknown interaction outcome. Interactor exit: {inter_exit_code:?}")))
                        }
                    } else {
                        (
                            "JE".to_string(),
                            Some(0.0),
                            Some("Process execution error".into()),
                        )
                    }
                }
            }
        };

        let sub_result = RunResult {
            run_id: spec.submission.run_id.clone(),
            reason: sub_reason,
            exit_code: sub_exit_code,
            signal_or_status: sub_exit_code
                .filter(|code| *code != 0)
                .map(|code| format!("0x{:08X}", code as u32)),
            security_setup_time_us,
            wall_time_us,
            result_collection_time_us,
            user_cpu_time_us: sub_user_cpu,
            kernel_cpu_time_us: sub_kernel_cpu,
            peak_memory_bytes,
            stdout_bytes: file_size(&sub_paths.stdout),
            stderr_bytes: file_size(&sub_paths.stderr),
            created_files: None,
            diagnostic: message.clone(),
        };

        let inter_result = RunResult {
            run_id: spec.interactor.run_id.clone(),
            reason: RunReason::Exited,
            exit_code: inter_exit_code,
            signal_or_status: inter_exit_code
                .filter(|code| *code != 0)
                .map(|code| format!("0x{:08X}", code as u32)),
            security_setup_time_us: 0,
            wall_time_us,
            result_collection_time_us,
            user_cpu_time_us: None,
            kernel_cpu_time_us: None,
            peak_memory_bytes: None,
            stdout_bytes: file_size(&inter_paths.stdout),
            stderr_bytes: file_size(&inter_paths.stderr),
            created_files: None,
            diagnostic: None,
        };

        Ok(InteractiveRunResult {
            run_id: spec.run_id.clone(),
            verdict,
            score_multiplier,
            execution_time_ms,
            peak_memory_bytes,
            message,
            transcript,
            submission_result: sub_result,
            interactor_result: inter_result,
        })
    }
}

fn elapsed_us(started: Instant) -> u64 {
    started.elapsed().as_micros().min(u64::MAX as u128) as u64
}

fn protect_cache_directory(path: &Path, app_container_sid: &[u8]) -> Result<(), String> {
    let user_sid = current_user_sid()?;
    let system_sid = well_known_sid(WinLocalSystemSid)?;
    let administrators_sid = well_known_sid(WinBuiltinAdministratorsSid)?;
    let inherit = OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE;
    let grants = [
        AclGrant::new(&user_sid, FILE_ALL_ACCESS, inherit),
        AclGrant::new(&system_sid, FILE_ALL_ACCESS, inherit),
        AclGrant::new(&administrators_sid, FILE_ALL_ACCESS, inherit),
        AclGrant::new(
            app_container_sid,
            FILE_GENERIC_READ | FILE_GENERIC_EXECUTE,
            inherit,
        ),
    ];
    if protected_acl_matches(path, &grants)? {
        return Ok(());
    }
    set_protected_acl(path, &grants, "protect executor cache")
}

fn protected_acl_matches(path: &Path, grants: &[AclGrant<'_>]) -> Result<bool, String> {
    let wide_path = wide(path.as_os_str());
    let mut acl: *mut ACL = null_mut();
    let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
    let status = unsafe {
        GetNamedSecurityInfoW(
            wide_path.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            &mut acl,
            null_mut(),
            &mut descriptor,
        )
    };
    if status != 0 {
        return Err(format!(
            "inspect executor cache ACL {}: Windows error {status}",
            path.display()
        ));
    }
    if descriptor.is_null() {
        return Err(format!(
            "inspect executor cache ACL {}: Windows returned no security descriptor",
            path.display()
        ));
    }

    let matches = (|| -> Result<bool, String> {
        if acl.is_null() {
            return Ok(false);
        }
        let mut control = 0_u16;
        let mut revision = 0_u32;
        win_bool(
            unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) },
            "inspect executor cache security descriptor",
        )?;
        if control & SE_DACL_PROTECTED == 0 {
            return Ok(false);
        }

        let mut information = ACL_SIZE_INFORMATION::default();
        win_bool(
            unsafe {
                GetAclInformation(
                    acl,
                    (&mut information as *mut ACL_SIZE_INFORMATION).cast(),
                    size_of::<ACL_SIZE_INFORMATION>() as u32,
                    AclSizeInformation,
                )
            },
            "inspect executor cache ACL",
        )?;
        if information.AceCount as usize != grants.len() {
            return Ok(false);
        }

        for (index, grant) in grants.iter().enumerate() {
            let mut raw_ace: *mut c_void = null_mut();
            win_bool(
                unsafe { GetAce(acl, index as u32, &mut raw_ace) },
                "inspect executor cache ACL entry",
            )?;
            if raw_ace.is_null() {
                return Ok(false);
            }
            let ace = unsafe { &*raw_ace.cast::<ACCESS_ALLOWED_ACE>() };
            if ace.Header.AceType != ACCESS_ALLOWED_ACE_TYPE as u8
                || ace.Header.AceFlags != grant.inheritance as u8
                || ace.Mask != grant.access
            {
                return Ok(false);
            }
            let ace_sid = (&ace.SidStart as *const u32).cast_mut().cast::<c_void>();
            if unsafe { EqualSid(ace_sid, grant.sid.as_ptr() as PSID) } == 0 {
                return Ok(false);
            }
        }
        Ok(true)
    })();
    unsafe {
        LocalFree(descriptor);
    }
    matches
}

fn protect_workspace_parent(path: &Path, app_container_sid: &[u8]) -> Result<(), String> {
    let user_sid = current_user_sid()?;
    let system_sid = well_known_sid(WinLocalSystemSid)?;
    let administrators_sid = well_known_sid(WinBuiltinAdministratorsSid)?;
    let inherit = OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE;
    let grants = [
        AclGrant::new(&user_sid, FILE_ALL_ACCESS, inherit),
        AclGrant::new(&system_sid, FILE_ALL_ACCESS, inherit),
        AclGrant::new(&administrators_sid, FILE_ALL_ACCESS, inherit),
        // The package SID may traverse the stable parent when it already knows
        // a workspace name, but it cannot list the parent and this ACE is not
        // inherited by child workspaces.
        AclGrant::new(app_container_sid, FILE_TRAVERSE, 0),
    ];
    set_protected_acl(path, &grants, "protect executor workspace parent")
}

fn prepare_workspace_profile_directories(workspace: &Path) -> Result<(), String> {
    // GetTempPath inside an AppContainer can resolve the package's redirected
    // AC\Temp folder relative to USERPROFILE even when TEMP/TMP are pinned.
    // Materialize that location inside this run instead of falling back to the
    // real per-user profile.
    fs::create_dir_all(
        workspace
            .join("Packages")
            .join(PROFILE_NAME.to_ascii_lowercase())
            .join("AC")
            .join("Temp"),
    )
    .map_err(|error| format!("create executor workspace profile directories: {error}"))
}

fn protect_workspace_tree(path: &Path, capability_sid: &[u8]) -> Result<(), String> {
    let user_sid = current_user_sid()?;
    let system_sid = well_known_sid(WinLocalSystemSid)?;
    let administrators_sid = well_known_sid(WinBuiltinAdministratorsSid)?;
    let inherit = OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE;
    let directory_grants = [
        AclGrant::new(&user_sid, FILE_ALL_ACCESS, inherit),
        AclGrant::new(&system_sid, FILE_ALL_ACCESS, inherit),
        AclGrant::new(&administrators_sid, FILE_ALL_ACCESS, inherit),
        AclGrant::new(capability_sid, FILE_ALL_ACCESS, inherit),
    ];
    let file_grants = [
        AclGrant::new(&user_sid, FILE_ALL_ACCESS, 0),
        AclGrant::new(&system_sid, FILE_ALL_ACCESS, 0),
        AclGrant::new(&administrators_sid, FILE_ALL_ACCESS, 0),
        AclGrant::new(capability_sid, FILE_ALL_ACCESS, 0),
    ];
    let mut pending = vec![path.to_path_buf()];
    while let Some(current) = pending.pop() {
        let metadata = fs::symlink_metadata(&current)
            .map_err(|error| format!("inspect executor workspace ACL target: {error}"))?;
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if metadata.file_type().is_symlink()
            || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
        {
            return Err("executor workspace ACL target cannot be a reparse point".into());
        }
        if metadata.is_dir() {
            let entries = fs::read_dir(&current)
                .map_err(|error| format!("enumerate executor workspace ACL target: {error}"))?;
            for entry in entries {
                pending.push(
                    entry
                        .map_err(|error| {
                            format!("enumerate executor workspace ACL entry: {error}")
                        })?
                        .path(),
                );
            }
            set_protected_acl(
                &current,
                &directory_grants,
                "isolate executor workspace directory",
            )?;
        } else if metadata.is_file() {
            set_protected_acl(&current, &file_grants, "isolate executor workspace file")?;
        } else {
            return Err("executor workspace contains an unsupported file type".into());
        }
    }
    Ok(())
}

struct AclGrant<'a> {
    sid: &'a [u8],
    access: u32,
    inheritance: u32,
}

impl<'a> AclGrant<'a> {
    const fn new(sid: &'a [u8], access: u32, inheritance: u32) -> Self {
        Self {
            sid,
            access,
            inheritance,
        }
    }
}

fn set_protected_acl(path: &Path, grants: &[AclGrant<'_>], action: &str) -> Result<(), String> {
    let acl_bytes = size_of::<ACL>()
        + grants
            .iter()
            .map(|grant| size_of::<ACCESS_ALLOWED_ACE>() - size_of::<u32>() + grant.sid.len())
            .sum::<usize>();
    let mut storage = vec![0_u32; acl_bytes.div_ceil(size_of::<u32>())];
    let acl = storage.as_mut_ptr().cast::<ACL>();
    win_bool(
        unsafe { InitializeAcl(acl, (storage.len() * size_of::<u32>()) as u32, ACL_REVISION) },
        "initialize protected ACL",
    )?;
    for grant in grants {
        win_bool(
            unsafe {
                AddAccessAllowedAceEx(
                    acl,
                    ACL_REVISION,
                    grant.inheritance,
                    grant.access,
                    grant.sid.as_ptr() as PSID,
                )
            },
            "add protected ACL entry",
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
            "{action} {}: Windows error {status}",
            path.display()
        ));
    }
    Ok(())
}

fn derive_workspace_capability_sid(workspace_id: &str) -> Result<Vec<u8>, String> {
    let capability_name = wide_string(&format!("JudgeDesk.Workspace.{workspace_id}"));
    let mut group_sids: *mut PSID = null_mut();
    let mut group_count = 0_u32;
    let mut capability_sids: *mut PSID = null_mut();
    let mut capability_count = 0_u32;
    let derived = unsafe {
        DeriveCapabilitySidsFromName(
            capability_name.as_ptr(),
            &mut group_sids,
            &mut group_count,
            &mut capability_sids,
            &mut capability_count,
        )
    };
    if derived == 0 {
        return Err(format!(
            "derive executor workspace capability: {}",
            io::Error::last_os_error()
        ));
    }
    let result = if capability_count == 1 && !capability_sids.is_null() {
        let sid = unsafe { *capability_sids };
        if sid.is_null() {
            Err("executor workspace capability returned a null SID".into())
        } else {
            clone_sid(sid)
        }
    } else {
        Err(format!(
            "executor workspace capability returned {capability_count} SIDs"
        ))
    };
    unsafe {
        free_local_sid_array(group_sids, group_count);
        free_local_sid_array(capability_sids, capability_count);
    }
    result
}

unsafe fn free_local_sid_array(sids: *mut PSID, count: u32) {
    if sids.is_null() {
        return;
    }
    for index in 0..count as usize {
        let sid = *sids.add(index);
        if !sid.is_null() {
            LocalFree(sid);
        }
    }
    LocalFree(sids.cast());
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
            | JOB_OBJECT_LIMIT_AFFINITY
            | JOB_OBJECT_LIMIT_JOB_MEMORY
            | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
        limits.BasicLimitInformation.ActiveProcessLimit = spec.limits.process_count;
        limits.BasicLimitInformation.Affinity = single_processor_affinity();
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

fn single_processor_affinity() -> usize {
    let mut process_mask = 0_usize;
    let mut system_mask = 0_usize;
    let available =
        unsafe { GetProcessAffinityMask(GetCurrentProcess(), &mut process_mask, &mut system_mask) }
            != 0;
    if available && process_mask != 0 {
        process_mask & process_mask.wrapping_neg()
    } else {
        1
    }
}

fn is_process_creation_memory_error(error: u32) -> bool {
    matches!(
        error,
        ERROR_NOT_ENOUGH_MEMORY | ERROR_OUTOFMEMORY | ERROR_COMMITMENT_LIMIT
    )
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

struct InteractiveCancellation {
    job_sub: Arc<JobHandle>,
    job_inter: Arc<JobHandle>,
    cancelled: Arc<AtomicBool>,
}

impl Cancellation for InteractiveCancellation {
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        unsafe {
            TerminateJobObject(self.job_sub.handle(), CANCEL_EXIT_CODE);
            TerminateJobObject(self.job_inter.handle(), CANCEL_EXIT_CODE);
        }
    }
}

enum SpawnError {
    ProcessCreationMemory(io::Error),
    Failed(String),
}

struct ChildHandles {
    stdin: HANDLE,
    stdout: HANDLE,
    stderr: HANDLE,
}

fn spawn_child_process(
    spec: &RunSpec,
    paths: &ValidatedRun,
    workspace_capability_sid: &[u8],
    app_container_sid: &[u8],
    job: HANDLE,
    child_handles: ChildHandles,
) -> Result<(OwnedHandle, OwnedHandle), SpawnError> {
    let mut workspace_capability = SID_AND_ATTRIBUTES {
        Sid: workspace_capability_sid.as_ptr() as PSID,
        Attributes: SE_GROUP_ENABLED as u32,
    };
    let mut security = SECURITY_CAPABILITIES {
        AppContainerSid: app_container_sid.as_ptr() as PSID,
        Capabilities: &mut workspace_capability,
        CapabilityCount: 1,
        Reserved: 0,
    };
    let mut lpac_policy = PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT;
    let mut handles = [
        child_handles.stdin,
        child_handles.stdout,
        child_handles.stderr,
    ];
    let compiler_may_spawn = matches!(spec.role, RunRole::Compiler);
    let isolated_submission_runtime = matches!(spec.role, RunRole::Submission)
        && (spec.toolchain.is_some()
            || spec.local_toolchain.is_some()
            || spec
                .environment
                .get("JUDGEDESK_PASCAL_ISOLATED")
                .map(String::as_str)
                == Some("1"))
        && MANAGED_RUNTIME_MARKERS
            .iter()
            .any(|marker| spec.environment.get(*marker).map(String::as_str) == Some("1"));
    let managed_checker_runtime = matches!(spec.role, RunRole::CheckerRuntime);
    let resource_only = matches!(paths.isolation, LocalToolchainIsolation::ResourceOnly);
    let use_lpac = !resource_only
        && !compiler_may_spawn
        && !isolated_submission_runtime
        && !managed_checker_runtime;
    let attribute_count = if resource_only {
        2
    } else if use_lpac {
        4
    } else {
        3
    };
    let mut attributes = AttributeList::new(attribute_count).map_err(SpawnError::Failed)?;
    if !resource_only {
        attributes
            .update(
                PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
                &mut security as *mut _ as *mut c_void,
                size_of::<SECURITY_CAPABILITIES>(),
            )
            .map_err(SpawnError::Failed)?;
    }
    if use_lpac {
        attributes
            .update(
                PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY as usize,
                &mut lpac_policy as *mut _ as *mut c_void,
                size_of::<u32>(),
            )
            .map_err(SpawnError::Failed)?;
    }
    attributes
        .update(
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
            handles.as_mut_ptr() as *mut c_void,
            size_of_val(&handles),
        )
        .map_err(SpawnError::Failed)?;
    let mut job_handles = [job];
    attributes
        .update(
            PROC_THREAD_ATTRIBUTE_JOB_LIST as usize,
            job_handles.as_mut_ptr().cast(),
            size_of_val(&job_handles),
        )
        .map_err(SpawnError::Failed)?;

    let mut startup: STARTUPINFOEXW = unsafe { zeroed() };
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = child_handles.stdin;
    startup.StartupInfo.hStdOutput = child_handles.stdout;
    startup.StartupInfo.hStdError = child_handles.stderr;
    startup.lpAttributeList = attributes.as_ptr();
    let mut process: PROCESS_INFORMATION = unsafe { zeroed() };

    let launch_executable = process_launch_path(&paths.executable);
    let launch_workspace = process_launch_path(&paths.workspace);
    let application = wide(launch_executable.as_os_str());
    let mut command_line = wide_string(&build_command_line(&launch_executable, &spec.args));
    let current_directory = wide(launch_workspace.as_os_str());
    let mut environment = environment_block(&spec.environment, &launch_workspace);
    // SAFETY: launch buffers and all startup attributes remain live until creation returns.
    let created = unsafe {
        create_process(
            &application,
            &mut command_line,
            &mut environment,
            &current_directory,
            &startup,
            &mut process,
        )
    };
    if created == 0 {
        let error_code = unsafe { GetLastError() };
        let error = io::Error::from_raw_os_error(error_code as i32);
        if is_process_creation_memory_error(error_code) {
            return Err(SpawnError::ProcessCreationMemory(error));
        }
        return Err(SpawnError::Failed(launch::failure_diagnostic(error_code)));
    }
    Ok((OwnedHandle(process.hProcess), OwnedHandle(process.hThread)))
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
    let environment = environment_values(values, workspace);
    let mut block = Vec::new();
    for (key, value) in environment {
        block.extend(format!("{key}={value}").encode_utf16());
        block.push(0);
    }
    block.push(0);
    block
}

fn environment_values(
    values: &BTreeMap<String, String>,
    workspace: &Path,
) -> BTreeMap<String, String> {
    let mut environment = BTreeMap::new();
    let workspace_text = workspace.to_string_lossy().into_owned();
    if workspace_text.as_bytes().get(1) == Some(&b':') {
        // CreateProcess requires the hidden per-drive current-directory variable when a
        // caller supplies a custom environment block and lpCurrentDirectory.
        environment.insert(format!("={}", &workspace_text[..2]), workspace_text.clone());
    }
    const SAFE_PARENT_VARIABLES: &[&str] = &[
        "ALLUSERSPROFILE",
        "CommonProgramFiles",
        "CommonProgramFiles(x86)",
        "CommonProgramW6432",
        "COMSPEC",
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
        "windir",
    ];
    for key in SAFE_PARENT_VARIABLES {
        if let Ok(value) = std::env::var(key) {
            insert_environment_value(&mut environment, key, value);
        }
    }
    for (key, value) in values {
        insert_environment_value(&mut environment, key, value.clone());
    }

    // User-profile and temporary paths are containment controls. Inheriting them from the
    // desktop process makes managed runtimes probe private user directories that an
    // AppContainer cannot access, and would expose those directories if their ACLs were ever
    // relaxed. Force every writable per-user location into this run's private workspace after
    // merging caller values so no adapter can accidentally override the boundary.
    for key in ["APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "USERPROFILE"] {
        insert_environment_value(&mut environment, key, workspace_text.clone());
    }
    if workspace_text.as_bytes().get(1) == Some(&b':') {
        insert_environment_value(&mut environment, "HOMEDRIVE", workspace_text[..2].into());
        insert_environment_value(&mut environment, "HOMEPATH", workspace_text[2..].into());
    }
    let system_root = environment
        .get("SystemRoot")
        .cloned()
        .or_else(|| std::env::var("SystemRoot").ok())
        .unwrap_or_else(|| r"C:\Windows".to_string());
    let sys32 = format!(r"{system_root}\System32");
    if let Some(existing_path) = environment.get("PATH").cloned() {
        if !existing_path.to_lowercase().contains("system32") {
            insert_environment_value(
                &mut environment,
                "PATH",
                format!("{existing_path};{sys32};{system_root};{sys32}\\Wbem"),
            );
        }
    }
    environment
}

fn insert_environment_value(environment: &mut BTreeMap<String, String>, key: &str, value: String) {
    let existing = environment
        .keys()
        .find(|candidate| !candidate.starts_with('=') && candidate.eq_ignore_ascii_case(key))
        .cloned();
    if let Some(existing) = existing {
        environment.remove(&existing);
    }
    environment.insert(key.to_string(), value);
}

fn build_command_line(executable: &Path, arguments: &[String]) -> String {
    let clean_exe = process_launch_path(executable);
    std::iter::once(clean_exe.to_string_lossy().into_owned())
        .chain(arguments.iter().map(|arg| {
            if arg.starts_with(r"\\?\") {
                process_launch_path(Path::new(arg))
                    .to_string_lossy()
                    .into_owned()
            } else {
                arg.clone()
            }
        }))
        .map(|value| quote_windows_argument(&value))
        .collect::<Vec<_>>()
        .join(" ")
}

fn process_launch_path(path: &Path) -> PathBuf {
    const LEGACY_MAX_PATH: usize = 260;
    let value = path.to_string_lossy();
    let candidate = if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = value.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        return path.to_path_buf();
    };
    if candidate.encode_utf16().count() < LEGACY_MAX_PATH {
        PathBuf::from(candidate)
    } else {
        path.to_path_buf()
    }
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
    mod launch_failure;

    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(label: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "judgedesk-windows-{label}-{}-{nonce}",
                std::process::id()
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

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

    #[test]
    fn validated_verbatim_paths_use_child_compatible_argv_zero() {
        assert_eq!(
            process_launch_path(Path::new(r"\\?\C:\JudgeDesk\toolchains\bin\javac.exe")),
            PathBuf::from(r"C:\JudgeDesk\toolchains\bin\javac.exe")
        );
        assert_eq!(
            process_launch_path(Path::new(r"\\?\UNC\server\share\java.exe")),
            PathBuf::from(r"\\server\share\java.exe")
        );
        let long = format!(r"\\?\C:\{}\java.exe", "x".repeat(300));
        assert_eq!(process_launch_path(Path::new(&long)), PathBuf::from(long));
    }

    #[test]
    fn process_creation_memory_errors_map_to_the_job_memory_limit() {
        for error in [
            ERROR_NOT_ENOUGH_MEMORY,
            ERROR_OUTOFMEMORY,
            ERROR_COMMITMENT_LIMIT,
        ] {
            assert!(is_process_creation_memory_error(error));
        }
        assert!(!is_process_creation_memory_error(225));
    }

    #[test]
    fn target_environment_forces_private_profile_and_temp_paths() {
        let workspace = Path::new(r"C:\executor\workspaces\run");
        let supplied = BTreeMap::from([
            ("APPDATA".into(), r"D:\host\appdata".into()),
            ("LOCALAPPDATA".into(), r"D:\host\local".into()),
            ("TEMP".into(), r"D:\host\temp".into()),
            ("TMP".into(), r"D:\host\tmp".into()),
            ("USERPROFILE".into(), r"D:\host\profile".into()),
        ]);
        let environment = environment_values(&supplied, workspace);
        for key in ["APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "USERPROFILE"] {
            assert_eq!(environment[key], workspace.to_string_lossy());
        }
        assert_eq!(environment["HOMEDRIVE"], "C:");
        assert_eq!(environment["HOMEPATH"], r"\executor\workspaces\run");
    }

    #[test]
    fn target_environment_has_only_one_case_insensitive_path_value() {
        let workspace = Path::new(r"C:\executor\workspaces\run");
        let supplied = BTreeMap::from([("PATH".into(), r"C:\managed\bin".into())]);
        let environment = environment_values(&supplied, workspace);
        let path_values: Vec<_> = environment
            .iter()
            .filter(|(key, _)| key.eq_ignore_ascii_case("PATH"))
            .collect();
        assert_eq!(path_values.len(), 1);
        assert!(path_values[0].1.starts_with(r"C:\managed\bin"));
    }

    #[test]
    fn workspace_capabilities_are_stable_and_distinct() {
        let first = derive_workspace_capability_sid("workspace_one").unwrap();
        let repeated = derive_workspace_capability_sid("workspace_one").unwrap();
        let second = derive_workspace_capability_sid("workspace_two").unwrap();
        assert_eq!(first, repeated);
        assert_ne!(first, second);
    }

    #[test]
    fn cache_acl_matcher_accepts_only_the_exact_protected_policy() {
        let directory = TestDirectory::new("cache-acl");
        let app_container_sid = current_user_sid().unwrap();
        protect_cache_directory(&directory.0, &app_container_sid).unwrap();

        let user_sid = current_user_sid().unwrap();
        let system_sid = well_known_sid(WinLocalSystemSid).unwrap();
        let administrators_sid = well_known_sid(WinBuiltinAdministratorsSid).unwrap();
        let inherit = OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE;
        let expected = [
            AclGrant::new(&user_sid, FILE_ALL_ACCESS, inherit),
            AclGrant::new(&system_sid, FILE_ALL_ACCESS, inherit),
            AclGrant::new(&administrators_sid, FILE_ALL_ACCESS, inherit),
            AclGrant::new(
                &app_container_sid,
                FILE_GENERIC_READ | FILE_GENERIC_EXECUTE,
                inherit,
            ),
        ];
        assert!(protected_acl_matches(&directory.0, &expected).unwrap());

        let wrong = [AclGrant::new(&user_sid, FILE_ALL_ACCESS, inherit)];
        set_protected_acl(&directory.0, &wrong, "set test ACL").unwrap();
        assert!(!protected_acl_matches(&directory.0, &expected).unwrap());

        protect_cache_directory(&directory.0, &app_container_sid).unwrap();
        assert!(protected_acl_matches(&directory.0, &expected).unwrap());
    }

    static TEST_SHARED_INITIALIZATION_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn owned_executor_test_root(root: &Path) -> PathBuf {
        let test_root = root
            .ancestors()
            .find(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("jd_test_executor_"))
            })
            .expect("executor test root must use the owned jd_test_executor_ prefix")
            .to_path_buf();
        assert!(
            test_root.join(".judgedesk-test-root").is_file(),
            "executor test root must contain its ownership marker"
        );
        test_root
    }

    fn cleanup_executor_test_root(root: &Path) {
        let test_root = owned_executor_test_root(root);
        std::fs::remove_dir_all(&test_root).expect("remove owned executor test root");
        assert!(
            !test_root.exists(),
            "owned executor test root must be absent after cleanup"
        );
    }

    #[test]
    fn test_scratch_execution() {
        let _lock = TEST_SHARED_INITIALIZATION_LOCK.lock().unwrap();
        let scratch_exe = PathBuf::from(
            r"C:\Users\mon\AppData\Local\ThemisV2\toolchains\scratch-windows-x64\scratch-run.exe",
        );
        let sample_sb3 =
            Path::new(r"C:\Users\mon\Downloads\DAP AN TIN HOC\bailam\sub 1 - scr\bai2.sb3");
        let sample_inp =
            Path::new(r"C:\Users\mon\Downloads\DAP AN TIN HOC\test\bai2\Test01\bai2.inp");
        if !scratch_exe.exists() || !sample_sb3.exists() || !sample_inp.exists() {
            return;
        }
        let (runner, root) = WindowsPlatform::initialize().unwrap();
        let workspace = TestDirectory::new("scratch-test-workspace");
        let stdin_path = workspace.0.join("stdin.txt");
        let stdout_path = workspace.0.join("stdout.txt");
        let stderr_path = workspace.0.join("stderr.txt");
        let sb3_path = workspace.0.join("submission.sb3");
        fs::copy(sample_sb3, &sb3_path).unwrap();
        fs::copy(sample_inp, &stdin_path).unwrap();

        let spec = RunSpec {
            run_id: "scratch_test_1".into(),
            role: RunRole::Submission,
            workspace_id: "scratch_test_ws_1".into(),
            executable_id: scratch_exe.to_string_lossy().into_owned(),
            args: vec!["submission.sb3".into()],
            stdin_file: Some("stdin.txt".into()),
            stdout_file: "stdout.txt".into(),
            stderr_file: "stderr.txt".into(),
            environment: BTreeMap::from([
                ("JUDGEDESK_SCRATCH_ISOLATED".into(), "1".into()),
                ("TURBO_MODE".into(), "1".into()),
            ]),
            toolchain: None,
            local_toolchain: None,
            limits: crate::protocol::RunLimits {
                wall_time_ms: 5000,
                memory_bytes: 512 * 1024 * 1024,
                process_count: 1,
                thread_count: 64,
                output_bytes: 10 * 1024 * 1024,
                total_write_bytes: 100 * 1024 * 1024,
                open_files: 64,
                created_files: 256,
            },
        };

        let paths = ValidatedRun {
            executable: scratch_exe,
            workspace: workspace.0.clone(),
            stdin: Some(stdin_path),
            stdout: stdout_path.clone(),
            stderr: stderr_path.clone(),
            toolchain_package_root: None,
            isolation: LocalToolchainIsolation::ResourceOnly,
        };

        let active = ActiveRuns::default();
        let result = runner.run_inner(&spec, &paths, &active).unwrap();
        println!("Scratch run result: {:?}", result);
        let stdout = fs::read_to_string(&stdout_path).unwrap_or_default();
        let stderr = fs::read_to_string(&stderr_path).unwrap_or_default();
        println!("Stdout: {stdout}");
        println!("Stderr: {stderr}");
        assert_eq!(result.exit_code, Some(0));
        assert_eq!(stdout.trim(), "5070720");

        cleanup_executor_test_root(&root);
    }

    #[test]
    fn test_pascal_execution() {
        let _lock = TEST_SHARED_INITIALIZATION_LOCK.lock().unwrap();
        let (runner, root) = WindowsPlatform::initialize().unwrap();
        let ws_dir = root.join("workspaces").join("pascal-test-workspace");
        let _ = fs::create_dir_all(&ws_dir);
        let stdout_path = ws_dir.join("stdout.txt");
        let _stderr_path = ws_dir.join("stderr.txt");
        let exe_path = ws_dir.join("prog.exe");

        // Compile probe.pas
        let pascal_src = "program Probe;\nbegin\n  writeln('JUDGEDESK_PROBE_OK');\nend.\n";
        let src_path = ws_dir.join("probe.pas");
        fs::write(&src_path, pascal_src).unwrap();

        let tool_root =
            PathBuf::from(r"C:\Users\mon\AppData\Local\ThemisV2\toolchains\fpc-windows-x64");
        if !tool_root.exists() {
            cleanup_executor_test_root(&root);
            return;
        }

        let mut cmd = std::process::Command::new(tool_root.join("bin/ppcx64.exe"));
        cmd.arg("-O2")
            .arg("-XS")
            .arg("-Sg")
            .arg("-WR")
            .arg("-Xs")
            .arg("-Cs66060288")
            .arg(format!("-o{}", exe_path.display()))
            .arg(&src_path);
        let out = cmd.output().unwrap();
        assert!(
            out.status.success(),
            "FPC compile failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert!(exe_path.exists(), "prog.exe was not created");

        let spec = RunSpec {
            run_id: "pascal_test_1".into(),
            role: RunRole::Submission,
            workspace_id: "pascal-test-workspace".into(),
            executable_id: "workspaces/pascal-test-workspace/prog.exe".into(),
            args: Vec::new(),
            stdin_file: None,
            stdout_file: "stdout.txt".into(),
            stderr_file: "stderr.txt".into(),
            environment: BTreeMap::from([("JUDGEDESK_PASCAL_ISOLATED".into(), "1".into())]),
            toolchain: None,
            local_toolchain: None,
            limits: crate::protocol::RunLimits {
                wall_time_ms: 5000,
                memory_bytes: 128 * 1024 * 1024,
                process_count: 1,
                thread_count: 16,
                output_bytes: 1024 * 1024,
                total_write_bytes: 4 * 1024 * 1024,
                open_files: 32,
                created_files: 16,
            },
        };

        let paths = crate::request_validation::validate_run(&root, &spec).unwrap();

        let active = ActiveRuns::default();
        let result = runner.run_inner(&spec, &paths, &active).unwrap();
        let stdout = fs::read_to_string(&stdout_path).unwrap_or_default();
        assert_eq!(result.exit_code, Some(0));
        assert!(stdout.contains("JUDGEDESK_PROBE_OK"));

        cleanup_executor_test_root(&root);
    }

    #[test]
    fn test_sentinel_host_executor_appdata_untouched() {
        let _lock = TEST_SHARED_INITIALIZATION_LOCK.lock().unwrap();
        let host_appdata = match std::env::var_os("LOCALAPPDATA") {
            Some(val) => PathBuf::from(val),
            None => return,
        };
        let host_executor_dir = host_appdata.join("JudgeDesk").join("JudgeDeskExecutor");

        // Run default WindowsPlatform::initialize()
        let (_runner, root) = WindowsPlatform::initialize().expect("initialize platform");

        // Verify root is NOT host_executor_dir and not inside host_executor_dir
        assert_ne!(
            root, host_executor_dir,
            "Default test platform root must NOT be host executor AppData"
        );
        assert!(
            !root.starts_with(&host_executor_dir),
            "Default test platform root must NOT be inside host executor AppData"
        );
        assert!(
            root.starts_with(std::env::temp_dir()),
            "Default test platform root must be inside std::env::temp_dir()"
        );

        let test_root = owned_executor_test_root(&root);
        assert!(test_root.starts_with(std::env::temp_dir()));
        cleanup_executor_test_root(&root);
    }
}
