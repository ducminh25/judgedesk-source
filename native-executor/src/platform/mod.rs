use crate::protocol::{ExecutorHealth, RunReason, RunResult, RunSpec};
use crate::request_validation::ValidatedRun;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;

pub trait Cancellation: Send + Sync {
    fn cancel(&self);
}

pub type ActiveRuns = Arc<Mutex<HashMap<String, Arc<dyn Cancellation>>>>;

pub struct Platform {
    root: PathBuf,
    inner: PlatformInner,
}

enum PlatformInner {
    #[cfg(windows)]
    Windows(Arc<windows::WindowsPlatform>),
    #[cfg(target_os = "macos")]
    Macos(Arc<macos::MacosPlatform>),
    Unsupported(String),
}

impl Platform {
    pub fn initialize() -> Self {
        #[cfg(windows)]
        {
            match windows::WindowsPlatform::initialize() {
                Ok((inner, root)) => Self {
                    root,
                    inner: PlatformInner::Windows(Arc::new(inner)),
                },
                Err(error) => Self {
                    root: PathBuf::new(),
                    inner: PlatformInner::Unsupported(error),
                },
            }
        }
        #[cfg(target_os = "macos")]
        {
            match macos::MacosPlatform::initialize() {
                Ok((inner, root)) => Self {
                    root,
                    inner: PlatformInner::Macos(Arc::new(inner)),
                },
                Err(error) => Self {
                    root: PathBuf::new(),
                    inner: PlatformInner::Unsupported(error),
                },
            }
        }
        #[cfg(not(any(windows, target_os = "macos")))]
        Self {
            root: PathBuf::new(),
            inner: PlatformInner::Unsupported(
                "secure executor is supported only on Windows and macOS".into(),
            ),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn health(&self) -> ExecutorHealth {
        match &self.inner {
            #[cfg(windows)]
            PlatformInner::Windows(inner) => inner.health(&self.root),
            #[cfg(target_os = "macos")]
            PlatformInner::Macos(inner) => inner.health(&self.root),
            PlatformInner::Unsupported(error) => ExecutorHealth {
                ready: false,
                mode: "unavailable".into(),
                executor_version: env!("CARGO_PKG_VERSION").into(),
                executor_root: self.root.to_string_lossy().into_owned(),
                diagnostics: vec![error.clone()],
                network_blocked: false,
                filesystem_isolated: false,
                process_tree_controlled: false,
                memory_limit_supported: false,
            },
        }
    }

    pub fn run(&self, spec: &RunSpec, validated: &ValidatedRun, active: &ActiveRuns) -> RunResult {
        match &self.inner {
            #[cfg(windows)]
            PlatformInner::Windows(inner) => inner.run(spec, validated, active),
            #[cfg(target_os = "macos")]
            PlatformInner::Macos(inner) => inner.run(spec, validated, active),
            PlatformInner::Unsupported(error) => {
                failure(spec, RunReason::SandboxDenied, error.clone())
            }
        }
    }

    pub fn shutdown(&self, active: &ActiveRuns) {
        let runs: Vec<_> = active.lock().unwrap().values().cloned().collect();
        for run in runs {
            run.cancel();
        }
    }
}

pub fn failure(spec: &RunSpec, reason: RunReason, diagnostic: String) -> RunResult {
    RunResult {
        run_id: spec.run_id.clone(),
        reason,
        exit_code: None,
        signal_or_status: None,
        security_setup_time_us: 0,
        wall_time_us: 0,
        result_collection_time_us: 0,
        user_cpu_time_us: None,
        kernel_cpu_time_us: None,
        peak_memory_bytes: None,
        stdout_bytes: 0,
        stderr_bytes: 0,
        created_files: None,
        diagnostic: Some(diagnostic),
    }
}

pub fn root_display(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

pub fn reported_peak_memory_bytes(
    reason: &RunReason,
    observed_peak_bytes: Option<u64>,
    memory_limit_bytes: u64,
) -> Option<u64> {
    if matches!(reason, RunReason::MemoryLimit) {
        observed_peak_bytes.map(|value| value.min(memory_limit_bytes))
    } else {
        observed_peak_bytes
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reported_mle_memory_is_capped_at_the_enforced_limit() {
        assert_eq!(
            reported_peak_memory_bytes(&RunReason::MemoryLimit, Some(80), 64),
            Some(64)
        );
        assert_eq!(
            reported_peak_memory_bytes(&RunReason::Exited, Some(80), 64),
            Some(80)
        );
        assert_eq!(
            reported_peak_memory_bytes(&RunReason::MemoryLimit, None, 64),
            None
        );
    }
}
