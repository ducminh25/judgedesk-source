use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, RwLock};

use crate::executor_client::ExecutorClient;
use crate::server::dto::ProfileSelection;
use crate::server::os_integration::{
    DirectoryPicker, NativeDirectoryPicker, NativeWorkbookOpener, WorkbookOpener,
};
use crate::toolchains::discovery::{
    canonical_profile_id_for_kind, discover_installed_managed_packages_in, get_app_data_dir,
    load_persisted_preferences_in, normalize_language_kind, save_persisted_preferences_in,
    ProfilePreferenceEntry,
};

#[derive(Clone, Debug)]
pub struct ToolchainStore {
    pub app_data_dir: Option<PathBuf>,
    pub selections: HashMap<String, ProfileSelection>,
    pub installed_packages: HashSet<String>,
    pub uninstalled_overrides: HashSet<String>,
    pub revision: u64,
}

impl ToolchainStore {
    pub fn from_app_data_dir_opt(app_data_dir: Option<PathBuf>) -> Self {
        let effective_dir = app_data_dir.clone().unwrap_or_else(get_app_data_dir);
        let persisted = load_persisted_preferences_in(&effective_dir);
        let is_contract_env =
            crate::toolchains::discovery::is_seeded_contract_fixture_env(&effective_dir);
        let mut selections = HashMap::new();
        for id in &["cpp", "c", "python", "pascal", "java", "scratch"] {
            let canonical_id = canonical_profile_id_for_kind(id);
            let pref = persisted.as_ref().and_then(|p| {
                p.profiles
                    .get(*id)
                    .or_else(|| p.profiles.get(canonical_id))
                    .or_else(|| {
                        p.profiles
                            .iter()
                            .find(|(k, _)| normalize_language_kind(k) == *id)
                            .map(|(_, v)| v)
                    })
            });
            let has_managed = crate::toolchains::discovery::find_managed_toolchain_in(
                &effective_dir.join("toolchains"),
                id,
            )
            .is_some()
                || (app_data_dir.is_none()
                    && !is_contract_env
                    && crate::toolchains::discovery::find_managed_toolchain(id).is_some());
            let default_mode = if (!cfg!(windows) && (*id == "cpp" || *id == "c"))
                || (cfg!(target_os = "linux")
                    && !is_contract_env
                    && matches!(*id, "python" | "pascal" | "java" | "scratch")
                    && !has_managed)
            {
                "local_auto"
            } else {
                "managed"
            };
            let mode = pref
                .map(|p| p.mode.clone())
                .unwrap_or_else(|| default_mode.to_string());
            let local_path = pref.and_then(|p| p.local_path.clone());
            selections.insert(id.to_string(), ProfileSelection { mode, local_path });
        }

        let installed_packages =
            discover_installed_managed_packages_in(&effective_dir.join("toolchains"));

        Self {
            app_data_dir: Some(effective_dir),
            selections,
            installed_packages,
            uninstalled_overrides: HashSet::new(),
            revision: 1,
        }
    }

    pub fn effective_app_data_dir(&self) -> PathBuf {
        self.app_data_dir.clone().unwrap_or_else(get_app_data_dir)
    }

    pub fn effective_toolchains_dir(&self) -> PathBuf {
        self.effective_app_data_dir().join("toolchains")
    }

    pub fn effective_installed_packages(&self) -> HashSet<String> {
        let mut set = discover_installed_managed_packages_in(&self.effective_toolchains_dir());
        for pkg in &self.installed_packages {
            set.insert(pkg.clone());
        }
        for removed in &self.uninstalled_overrides {
            set.remove(removed);
        }
        set
    }

    pub fn persist_selections(&mut self) -> Result<(), String> {
        let dir = self.effective_app_data_dir();
        let mut entries = HashMap::new();
        for (k, v) in &self.selections {
            entries.insert(
                k.clone(),
                ProfilePreferenceEntry {
                    mode: v.mode.clone(),
                    local_path: v.local_path.clone(),
                },
            );
        }
        save_persisted_preferences_in(&dir, &entries)?;
        self.revision = self.revision.saturating_add(1);
        Ok(())
    }
}

impl Default for ToolchainStore {
    fn default() -> Self {
        Self::from_app_data_dir_opt(None)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ServerLifecyclePhase {
    Running,
    Draining,
    Stopping,
    Stopped,
}

#[derive(Default)]
pub struct JudgeJobRegistry {
    pub active_jobs: HashMap<String, Arc<AtomicBool>>,
    pub pending_cancellations: HashMap<String, std::time::Instant>,
}

impl JudgeJobRegistry {
    pub fn prune_expired_tombstones(&mut self) {
        let now = std::time::Instant::now();
        self.pending_cancellations
            .retain(|_, ts| now.duration_since(*ts) < std::time::Duration::from_secs(60));
    }
}

pub enum JobAdmissionResult {
    Admitted(JudgeSessionLease),
    Rejected { code: &'static str, message: String },
}

pub struct JudgeSessionLease {
    job_id: String,
    cancel_flag: Arc<AtomicBool>,
    registry: Arc<RwLock<JudgeJobRegistry>>,
}

impl JudgeSessionLease {
    pub fn job_id(&self) -> &str {
        &self.job_id
    }

    pub fn cancel_flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.cancel_flag)
    }
}

impl Drop for JudgeSessionLease {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.registry.write() {
            guard.active_jobs.remove(&self.job_id);
        }
    }
}

pub fn validate_job_id(raw: &str) -> Result<String, String> {
    if raw.bytes().any(|b| b < 0x20 || b == 0x7F) {
        return Err(
            "JUDGE_JOB_ID_INVALID: jobId must be 1..=256 printable ASCII characters.".to_string(),
        );
    }
    let trimmed = raw.trim();
    if trimmed.is_empty()
        || trimmed.len() > 256
        || !trimmed.bytes().all(|b| (0x21..=0x7E).contains(&b))
    {
        return Err(
            "JUDGE_JOB_ID_INVALID: jobId must be 1..=256 printable ASCII characters.".to_string(),
        );
    }
    Ok(trimmed.to_string())
}

static AUTO_JOB_SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

#[derive(Clone)]
pub struct AppState {
    pub cancel_flag: Arc<AtomicBool>,
    pub platform: Arc<ExecutorClient>,
    pub shutdown_tx: Option<tokio::sync::mpsc::Sender<()>>,
    pub toolchains: Arc<RwLock<ToolchainStore>>,
    pub job_registry: Arc<RwLock<JudgeJobRegistry>>,
    pub lifecycle_phase: Arc<RwLock<ServerLifecyclePhase>>,
    pub directory_picker: Arc<dyn DirectoryPicker>,
    pub workbook_opener: Arc<dyn WorkbookOpener>,
    pub export_dir: Option<PathBuf>,
    pub osd: Arc<crate::osd::OsdService>,
}

pub fn resolve_packaged_executor_path() -> Result<PathBuf, String> {
    let binary_name = if cfg!(windows) {
        "judgedesk-executor.exe"
    } else {
        "judgedesk-executor"
    };
    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(parent) = current_exe.parent() {
            let candidate = parent.join(binary_name);
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    Err("PACKAGED_EXECUTOR_NOT_FOUND: exact packaged binary 'judgedesk-executor' not found beside executable".into())
}

impl AppState {
    pub fn new(platform: Arc<ExecutorClient>) -> Self {
        Self {
            cancel_flag: Arc::new(AtomicBool::new(false)),
            platform,
            shutdown_tx: None,
            toolchains: Arc::new(RwLock::new(ToolchainStore::default())),
            job_registry: Arc::new(RwLock::new(JudgeJobRegistry::default())),
            lifecycle_phase: Arc::new(RwLock::new(ServerLifecyclePhase::Running)),
            directory_picker: Arc::new(NativeDirectoryPicker),
            workbook_opener: Arc::new(NativeWorkbookOpener::default()),
            export_dir: None,
            osd: Arc::new(crate::osd::OsdService::new()),
        }
    }

    pub fn set_app_data_dir(&mut self, dir: impl AsRef<Path>) {
        let dir_buf = dir.as_ref().to_path_buf();
        if let Ok(mut guard) = self.toolchains.write() {
            *guard = ToolchainStore::from_app_data_dir_opt(Some(dir_buf));
        }
    }

    pub fn lifecycle_phase(&self) -> ServerLifecyclePhase {
        self.lifecycle_phase
            .read()
            .map(|g| *g)
            .unwrap_or(ServerLifecyclePhase::Stopped)
    }

    pub fn set_lifecycle_phase(&self, phase: ServerLifecyclePhase) {
        if let Ok(mut guard) = self.lifecycle_phase.write() {
            *guard = phase;
        }
    }

    pub fn has_active_executor_runs(&self) -> bool {
        self.platform.has_active_runs()
    }

    pub fn active_executor_run_ids(&self) -> Vec<String> {
        self.platform.active_run_ids()
    }

    pub fn has_active_judge_jobs(&self) -> bool {
        self.job_registry
            .read()
            .map(|guard| !guard.active_jobs.is_empty())
            .unwrap_or(false)
    }

    pub fn admit_judge_job(&self, requested_job_id: Option<&str>) -> JobAdmissionResult {
        if self.lifecycle_phase() != ServerLifecyclePhase::Running {
            return JobAdmissionResult::Rejected {
                code: "SERVER_DRAINING",
                message:
                    "SERVER_DRAINING: server is draining or stopping and cannot accept new judge jobs."
                        .to_string(),
            };
        }

        let normalized_id = match requested_job_id {
            Some(raw) if !raw.is_empty() => match validate_job_id(raw) {
                Ok(valid) => valid,
                Err(message) => {
                    return JobAdmissionResult::Rejected {
                        code: "JUDGE_JOB_ID_INVALID",
                        message,
                    };
                }
            },
            _ => {
                let seq = AUTO_JOB_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                format!("job_{}_{seq}", std::process::id())
            }
        };

        let Ok(mut guard) = self.job_registry.write() else {
            return JobAdmissionResult::Rejected {
                code: "SERVER_DRAINING",
                message: "SERVER_DRAINING: job registry lock poisoned.".to_string(),
            };
        };

        guard.prune_expired_tombstones();

        if guard.pending_cancellations.remove(&normalized_id).is_some() {
            return JobAdmissionResult::Rejected {
                code: "JUDGE_CANCELLED",
                message: "JUDGE_CANCELLED: judging was cancelled before admission.".to_string(),
            };
        }

        if guard.active_jobs.contains_key(&normalized_id) {
            return JobAdmissionResult::Rejected {
                code: "JUDGE_JOB_ID_CONFLICT",
                message: format!(
                    "JUDGE_JOB_ID_CONFLICT: judge job '{normalized_id}' is already active."
                ),
            };
        }

        self.cancel_flag
            .store(false, std::sync::atomic::Ordering::SeqCst);
        let job_cancel_flag = Arc::new(AtomicBool::new(false));
        guard
            .active_jobs
            .insert(normalized_id.clone(), Arc::clone(&job_cancel_flag));

        JobAdmissionResult::Admitted(JudgeSessionLease {
            job_id: normalized_id,
            cancel_flag: job_cancel_flag,
            registry: Arc::clone(&self.job_registry),
        })
    }

    pub fn try_acquire_judge_lease(&self, job_id: &str) -> Option<JudgeSessionLease> {
        let opt = if job_id.trim().is_empty() {
            None
        } else {
            Some(job_id)
        };
        match self.admit_judge_job(opt) {
            JobAdmissionResult::Admitted(lease) => Some(lease),
            JobAdmissionResult::Rejected { .. } => None,
        }
    }

    pub fn cancel_judge_job(&self, requested_job_id: Option<&str>) -> usize {
        if let Some(raw_id) = requested_job_id.filter(|s| !s.trim().is_empty()) {
            let Ok(valid_id) = validate_job_id(raw_id) else {
                return 0;
            };
            if let Ok(mut guard) = self.job_registry.write() {
                guard.prune_expired_tombstones();
                if let Some(flag) = guard.active_jobs.get(&valid_id) {
                    flag.store(true, std::sync::atomic::Ordering::SeqCst);
                    let only_active_job = guard.active_jobs.len() <= 1;
                    drop(guard);
                    if only_active_job {
                        return self.platform.cancel_all_active_runs();
                    }
                    return 1;
                }
                if guard.pending_cancellations.len() < 1024
                    || guard.pending_cancellations.contains_key(&valid_id)
                {
                    guard
                        .pending_cancellations
                        .insert(valid_id, std::time::Instant::now());
                }
            }
            return 0;
        }

        self.cancel_flag
            .store(true, std::sync::atomic::Ordering::SeqCst);
        if let Ok(mut guard) = self.job_registry.write() {
            guard.prune_expired_tombstones();
            for flag in guard.active_jobs.values() {
                flag.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        }
        self.platform.cancel_all_active_runs()
    }

    pub fn from_packaged_executor() -> Self {
        match resolve_packaged_executor_path() {
            Ok(exe_path) => match ExecutorClient::spawn_sync(&exe_path) {
                Ok(client) => Self::new(Arc::new(client)),
                Err(e) => Self::new(Arc::new(ExecutorClient::unavailable(&format!(
                    "failed to spawn packaged executor at {}: {e}",
                    exe_path.display()
                )))),
            },
            Err(e) => Self::new(Arc::new(ExecutorClient::unavailable(&e))),
        }
    }

    pub fn from_packaged_executor_with_tree_guard(
        guard: crate::executor_client::TreeGuardContract,
    ) -> Self {
        match resolve_packaged_executor_path() {
            Ok(exe_path) => match ExecutorClient::spawn_sync_with_tree_guard(&exe_path, guard) {
                Ok(client) => Self::new(Arc::new(client)),
                Err(error) => Self::new(Arc::new(ExecutorClient::unavailable(&format!(
                    "failed to spawn packaged executor at {} with application tree guard: {error}",
                    exe_path.display()
                )))),
            },
            Err(error) => Self::new(Arc::new(ExecutorClient::unavailable(&error))),
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        #[cfg(debug_assertions)]
        {
            let test_var = std::env::var_os("JUDGEDESK_TEST_EXECUTOR_PATH")
                .or_else(|| std::env::var_os("JUDGEDESK_EXECUTOR_PATH"));
            if let Some(path) = test_var {
                let p = PathBuf::from(path);
                if p.is_file() {
                    if let Ok(client) = ExecutorClient::spawn_sync(&p) {
                        return Self::new(Arc::new(client));
                    }
                }
            }
        }

        Self::from_packaged_executor()
    }
}
