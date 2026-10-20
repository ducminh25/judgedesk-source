use crate::discovery::compile_config::ProblemCompileConfig;
use crate::executor_client::ExecutorClient;
use crate::toolchains::discovery::{
    ensure_cached_managed_toolchain, read_package_receipt, resolve_toolchain_for_profile_in,
};
use crate::toolchains::pch::{ensure_universal_cpp_pch_in, extract_pch_compiler_flags};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum PrewarmOutcome {
    Completed {
        prewarmed_kinds: Vec<String>,
        pch_dir: Option<PathBuf>,
    },
    Deferred {
        reason: String,
    },
}

pub fn native_compiler_kinds_to_prewarm(requirements: &BTreeSet<String>) -> Vec<String> {
    ["cpp", "c"]
        .into_iter()
        .filter(|kind| requirements.contains(*kind))
        .map(String::from)
        .collect()
}

pub fn execute_selective_prewarm(
    platform: &ExecutorClient,
    kinds: &[&str],
    is_closing: impl Fn() -> bool,
) -> PrewarmOutcome {
    execute_selective_prewarm_in(None, platform, kinds, is_closing)
}

pub fn execute_selective_prewarm_in(
    app_data_dir: Option<&Path>,
    platform: &ExecutorClient,
    kinds: &[&str],
    is_closing: impl Fn() -> bool,
) -> PrewarmOutcome {
    if kinds.is_empty() {
        return PrewarmOutcome::Completed {
            prewarmed_kinds: Vec::new(),
            pch_dir: None,
        };
    }
    if is_closing() {
        return PrewarmOutcome::Deferred {
            reason: "SERVER_CLOSING".to_string(),
        };
    }

    let health = platform.health();
    if !health.ready || platform.is_admission_closed() {
        return PrewarmOutcome::Deferred {
            reason: "EXECUTOR_NOT_READY".to_string(),
        };
    }

    let wants_cpp = kinds.contains(&"cpp");
    let wants_c = kinds.contains(&"c");

    let cpp_tc = if wants_cpp {
        Some(resolve_toolchain_for_profile_in(
            app_data_dir,
            "cpp",
            None,
            None,
        ))
    } else {
        None
    };
    let c_tc = if wants_c {
        Some(resolve_toolchain_for_profile_in(
            app_data_dir,
            "c",
            None,
            None,
        ))
    } else {
        None
    };

    let cpp_ready = cpp_tc.as_ref().is_some_and(|t| t.ready);
    let c_ready = c_tc.as_ref().is_some_and(|t| t.ready);
    if !cpp_ready && !c_ready {
        return PrewarmOutcome::Deferred {
            reason: "CPP_TOOLCHAIN_NOT_READY".to_string(),
        };
    }

    let mut prewarmed_kinds = Vec::new();
    let mut pch_dir = None;

    if let Some(ref cpp) = cpp_tc {
        if cpp.ready {
            if is_closing() {
                return PrewarmOutcome::Deferred {
                    reason: "SERVER_CLOSING".to_string(),
                };
            }
            if cpp.source_mode == "managed" {
                if let Some(ref pkg_root) = cpp.package_root {
                    if let Some(receipt) = read_package_receipt(pkg_root) {
                        let _ =
                            ensure_cached_managed_toolchain(&platform.root(), pkg_root, &receipt);
                    }
                }
            }
            let default_cfg = ProblemCompileConfig::default();
            let raw_flags = default_cfg.flags_for_language("cpp");
            if let Some(pch_flags) = extract_pch_compiler_flags(raw_flags) {
                if let Ok(outcome) =
                    ensure_universal_cpp_pch_in(app_data_dir, platform, cpp, &pch_flags)
                {
                    pch_dir = Some(outcome.pch_dir);
                }
            }
            prewarmed_kinds.push("cpp".to_string());
        }
    }

    if let Some(ref c) = c_tc {
        if c.ready {
            if is_closing() {
                return PrewarmOutcome::Deferred {
                    reason: "SERVER_CLOSING".to_string(),
                };
            }
            if c.source_mode == "managed" {
                if let Some(ref pkg_root) = c.package_root {
                    if let Some(receipt) = read_package_receipt(pkg_root) {
                        let _ =
                            ensure_cached_managed_toolchain(&platform.root(), pkg_root, &receipt);
                    }
                }
            }
            prewarmed_kinds.push("c".to_string());
        }
    }

    PrewarmOutcome::Completed {
        prewarmed_kinds,
        pch_dir,
    }
}
