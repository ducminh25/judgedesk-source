use crate::protocol::{ExecutorHealth, RunReason, RunResult, RunSpec};
use crate::request_validation::ValidatedRun;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

#[cfg(target_os = "macos")]
pub(crate) mod macos;
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
                startup_timings: None,
            },
        }
    }

    pub fn run(&self, spec: &RunSpec, validated: &ValidatedRun, _active: &ActiveRuns) -> RunResult {
        match &self.inner {
            #[cfg(windows)]
            PlatformInner::Windows(inner) => inner.run(spec, validated, _active),
            #[cfg(target_os = "macos")]
            PlatformInner::Macos(inner) => inner.run(&self.root, spec, validated, _active),
            PlatformInner::Unsupported(error) => {
                failure(spec, RunReason::SandboxDenied, error.clone())
            }
        }
    }

    pub fn run_interactive(
        &self,
        spec: &crate::protocol::InteractiveRunSpec,
        _active: &ActiveRuns,
    ) -> crate::protocol::InteractiveRunResult {
        match &self.inner {
            #[cfg(windows)]
            PlatformInner::Windows(inner) => inner.run_interactive(&self.root, spec, _active),
            #[cfg(target_os = "macos")]
            PlatformInner::Macos(inner) => match inner.validate_interactive(&self.root, spec) {
                Ok(()) => crate::macos_interactive::run(&self.root, spec, _active),
                Err(error) => interactive_failure(spec, error),
            },
            PlatformInner::Unsupported(error) => interactive_failure(spec, error.clone()),
        }
    }

    pub fn shutdown(&self, active: &ActiveRuns) {
        let runs: Vec<_> = active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .values()
            .cloned()
            .collect();
        for run in runs {
            run.cancel();
        }
    }
}

pub fn interactive_failure(
    spec: &crate::protocol::InteractiveRunSpec,
    message: String,
) -> crate::protocol::InteractiveRunResult {
    crate::protocol::InteractiveRunResult {
        run_id: spec.run_id.clone(),
        verdict: "JE".into(),
        score_multiplier: Some(0.0),
        execution_time_ms: 0,
        peak_memory_bytes: None,
        message: Some(message.clone()),
        transcript: None,
        submission_result: failure(&spec.submission, RunReason::InternalError, message.clone()),
        interactor_result: failure(&spec.interactor, RunReason::InternalError, message),
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
