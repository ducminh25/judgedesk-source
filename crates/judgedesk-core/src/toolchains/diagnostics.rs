use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::executor_client::ExecutorClient;
use judgedesk_native_executor::protocol::{
    LocalToolchainGrant, LocalToolchainIsolation, RunLimits, RunReason, RunRole, RunSpec,
    ToolchainGrantRole,
};
use judgedesk_native_executor::request_validation::validate_run;

use super::discovery::normalize_language_kind;

static DIAGNOSTIC_COUNTER: AtomicU64 = AtomicU64::new(1);
pub const PROBE_TOKEN_MARKER: &str = "JUDGEDESK_PROBE_OK";

const DEFAULT_DIAGNOSTIC_WALL_TIME_MS: u64 = 3_000;
const SCRATCH_DIAGNOSTIC_WALL_TIME_MS: u64 = 5_000;
const PYTHON_DIAGNOSTIC_WALL_TIME_MS: u64 = 10_000;
const JAVA_DIAGNOSTIC_WALL_TIME_MS: u64 = 15_000;

// Diagnostics verify managed runtimes through a fresh sandbox, so their startup
// budget is deliberately separate from a contestant submission's time limit.
fn diagnostic_wall_time_ms(kind: &str) -> u64 {
    match kind {
        "python" => PYTHON_DIAGNOSTIC_WALL_TIME_MS,
        "java" => JAVA_DIAGNOSTIC_WALL_TIME_MS,
        "scratch" => SCRATCH_DIAGNOSTIC_WALL_TIME_MS,
        _ => DEFAULT_DIAGNOSTIC_WALL_TIME_MS,
    }
}

#[cfg(test)]
mod tests {
    use super::diagnostic_wall_time_ms;

    #[test]
    fn managed_runtime_diagnostics_have_cold_start_headroom() {
        assert_eq!(diagnostic_wall_time_ms("python"), 10_000);
        assert_eq!(diagnostic_wall_time_ms("java"), 15_000);
        assert_eq!(diagnostic_wall_time_ms("cpp"), 3_000);
        assert_eq!(diagnostic_wall_time_ms("scratch"), 5_000);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolchainDiagnosticResult {
    pub success: bool,
    pub profile_id: String,
    pub language: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub phase: String, // "configuration" | "compilation" | "execution"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compile_time_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_time_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub peak_memory_kb: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stdout: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn get_probe_source(kind: &str, managed_linux: bool) -> (&'static str, &'static str) {
    match kind {
        "cpp" => (
            "probe.cpp",
            "#include <iostream>\nint main() { std::cout << \"JUDGEDESK_PROBE_OK\" << std::endl; return 0; }\n",
        ),
        "c" => (
            "probe.c",
            "#include <stdio.h>\nint main(void) { puts(\"JUDGEDESK_PROBE_OK\"); return 0; }\n",
        ),
        "python" => (
            "probe.py",
            "print(\"JUDGEDESK_PROBE_OK\")\n",
        ),
        "pascal" if managed_linux => (
            "probe.pas",
            "program Probe;\nuses cthreads, classes;\nbegin\n  writeln('JUDGEDESK_PROBE_OK');\nend.\n",
        ),
        "pascal" => (
            "probe.pas",
            "program Probe;\nbegin\n  writeln('JUDGEDESK_PROBE_OK');\nend.\n",
        ),
        "java" => (
            "Main.java",
            "public class Main {\n  public static void main(String[] args) {\n    System.out.println(\"JUDGEDESK_PROBE_OK\");\n  }\n}\n",
        ),
        "scratch" => (
            "probe.json",
            concat!(
                "{\"targets\":[{\"isStage\":true,\"name\":\"Stage\",\"variables\":{},\"lists\":{},\"broadcasts\":{},\"blocks\":{},",
                "\"comments\":{},\"currentCostume\":0,\"costumes\":[{\"assetId\":\"cd21514d0531fdffb22204e0ec5ed84a\",\"name\":\"backdrop1\",",
                "\"md5ext\":\"cd21514d0531fdffb22204e0ec5ed84a.svg\",\"dataFormat\":\"svg\",\"rotationCenterX\":240,\"rotationCenterY\":180}],",
                "\"sounds\":[],\"volume\":100,\"layerOrder\":0,\"tempo\":60,\"videoTransparency\":50,\"videoState\":\"on\",\"textToSpeechLanguage\":null},",
                "{\"isStage\":false,\"name\":\"Sprite1\",\"variables\":{},\"lists\":{},\"broadcasts\":{},\"blocks\":{\"start\":{\"opcode\":\"event_whenflagclicked\",",
                "\"next\":\"say\",\"parent\":null,\"inputs\":{},\"fields\":{},\"shadow\":false,\"topLevel\":true},\"say\":{\"opcode\":\"looks_say\",\"next\":null,",
                "\"parent\":\"start\",\"inputs\":{\"MESSAGE\":[1,[10,\"JUDGEDESK_PROBE_OK\"]]},\"fields\":{},\"shadow\":false,\"topLevel\":false}},",
                "\"comments\":{},\"currentCostume\":0,\"costumes\":[{\"assetId\":\"bcf454acf82e4504149f7ffe07081dbc\",\"name\":\"costume1\",",
                "\"bitmapResolution\":1,\"md5ext\":\"bcf454acf82e4504149f7ffe07081dbc.svg\",\"dataFormat\":\"svg\",\"rotationCenterX\":48,\"rotationCenterY\":50}],",
                "\"sounds\":[],\"volume\":100,\"layerOrder\":1,\"visible\":true,\"x\":0,\"y\":0,\"size\":100,\"direction\":90,\"draggable\":false,",
                "\"rotationStyle\":\"all around\"}],\"monitors\":[],\"extensions\":[],\"meta\":{\"semver\":\"3.0.0\",\"vm\":\"0.2.0\",\"agent\":\"JudgeDesk\"}}"
            ),
        ),
        _ => ("probe.txt", "JUDGEDESK_PROBE_OK\n"),
    }
}

#[cfg(target_os = "macos")]
fn resolve_macos_sdk_path() -> Option<String> {
    if let Ok(sdk) = std::env::var("SDKROOT") {
        if !sdk.trim().is_empty() && std::path::Path::new(&sdk).is_dir() {
            return Some(sdk);
        }
    }
    if let Ok(out) = std::process::Command::new("xcrun")
        .args(["--show-sdk-path"])
        .output()
    {
        if out.status.success() {
            let sdk = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !sdk.is_empty() && std::path::Path::new(&sdk).is_dir() {
                return Some(sdk);
            }
        }
    }
    let default_sdk = "/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk";
    if std::path::Path::new(default_sdk).is_dir() {
        return Some(default_sdk.to_string());
    }
    let xcode_sdk = "/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk";
    if std::path::Path::new(xcode_sdk).is_dir() {
        return Some(xcode_sdk.to_string());
    }
    None
}

pub async fn diagnose_language_profile(
    profile_id: &str,
    platform: &ExecutorClient,
    preferred_mode: Option<&str>,
    preferred_path: Option<&str>,
) -> ToolchainDiagnosticResult {
    diagnose_language_profile_in(None, profile_id, platform, preferred_mode, preferred_path).await
}

pub async fn diagnose_language_profile_in(
    app_data_dir: Option<&std::path::Path>,
    profile_id: &str,
    platform: &ExecutorClient,
    preferred_mode: Option<&str>,
    preferred_path: Option<&str>,
) -> ToolchainDiagnosticResult {
    let toolchain = super::discovery::resolve_toolchain_for_profile_in(
        app_data_dir,
        profile_id,
        preferred_mode,
        preferred_path,
    );
    diagnose_resolved_language_profile(profile_id, platform, toolchain)
}

pub(crate) fn diagnose_resolved_language_profile(
    profile_id: &str,
    platform: &ExecutorClient,
    toolchain: super::discovery::ResolvedToolchain,
) -> ToolchainDiagnosticResult {
    let kind = normalize_language_kind(profile_id);

    // 1. Health check
    let health = platform.health();
    if !health.ready {
        return ToolchainDiagnosticResult {
            success: false,
            profile_id: profile_id.to_string(),
            language: kind.to_string(),
            source_mode: None,
            version: None,
            phase: "configuration".to_string(),
            compile_time_ms: None,
            execution_time_ms: None,
            peak_memory_kb: None,
            stdout: None,
            error: Some(format!(
                "Native secure runner is unavailable: {}",
                health.diagnostics.join("; ")
            )),
        };
    }

    if !toolchain.ready || !toolchain.executable_path.exists() {
        if cfg!(target_os = "macos")
            && profile_id == "cpp-legacy-v1"
            && toolchain.source_mode == "managed"
        {
            return ToolchainDiagnosticResult {
                success: false,
                profile_id: profile_id.to_string(),
                language: kind.to_string(),
                source_mode: Some("managed".to_string()),
                version: Some(String::new()),
                phase: "configuration".to_string(),
                compile_time_ms: None,
                execution_time_ms: None,
                peak_memory_kb: None,
                stdout: None,
                error: Some("Managed toolchain not installed.".to_string()),
            };
        }
        return ToolchainDiagnosticResult {
            success: false,
            profile_id: profile_id.to_string(),
            language: kind.to_string(),
            source_mode: Some(toolchain.source_mode),
            version: Some(toolchain.version),
            phase: "configuration".to_string(),
            compile_time_ms: None,
            execution_time_ms: None,
            peak_memory_kb: None,
            stdout: None,
            error: toolchain.diagnostic.or(Some(
                "Compiler or runtime executable not found on disk.".to_string(),
            )),
        };
    }

    let mut toolchain = toolchain;
    toolchain.executable_path = super::discovery::clean_canonical_path(&toolchain.executable_path);
    toolchain.runtime_executable_path = toolchain
        .runtime_executable_path
        .as_ref()
        .map(|p| super::discovery::clean_canonical_path(p));
    toolchain.package_root = toolchain
        .package_root
        .as_ref()
        .map(|p| super::discovery::clean_canonical_path(p));

    if toolchain.source_mode == "managed"
        && matches!(kind, "cpp" | "c")
        && fs::read_to_string(&toolchain.executable_path)
            .is_ok_and(|c| c.starts_with("dummy binary for contract tests"))
    {
        return ToolchainDiagnosticResult {
            success: false,
            profile_id: profile_id.to_string(),
            language: kind.to_string(),
            source_mode: Some("managed".to_string()),
            version: Some(toolchain.version),
            phase: "compilation".to_string(),
            compile_time_ms: None,
            execution_time_ms: None,
            peak_memory_kb: None,
            stdout: None,
            error: Some("TOOLCHAIN_NOT_SANDBOX_COMPATIBLE".to_string()),
        };
    }

    // 3. Workspace setup
    let count = DIAGNOSTIC_COUNTER.fetch_add(1, Ordering::Relaxed);
    let workspace_id = format!("diag_{}_{}", std::process::id(), count);
    let workspaces_root = platform.root().join("workspaces");
    let diag_workspace =
        match crate::storage::OwnedWorkspace::create_with_id(&workspaces_root, &workspace_id) {
            Ok(ws) => ws,
            Err(e) => {
                return ToolchainDiagnosticResult {
                    success: false,
                    profile_id: profile_id.to_string(),
                    language: kind.to_string(),
                    source_mode: Some(toolchain.source_mode),
                    version: Some(toolchain.version),
                    phase: "configuration".to_string(),
                    compile_time_ms: None,
                    execution_time_ms: None,
                    peak_memory_kb: None,
                    stdout: None,
                    error: Some(format!("Failed to create diagnostic workspace: {e}")),
                };
            }
        };
    let workspace_dir = diag_workspace.root().to_path_buf();

    let (file_name, source_code) = get_probe_source(
        kind,
        super::linux_managed::is_managed_linux_toolchain(&toolchain),
    );
    let source_path =
        match diag_workspace.write_file(std::path::Path::new(file_name), source_code.as_bytes()) {
            Ok(p) => p,
            Err(e) => {
                return ToolchainDiagnosticResult {
                    success: false,
                    profile_id: profile_id.to_string(),
                    language: kind.to_string(),
                    source_mode: Some(toolchain.source_mode),
                    version: Some(toolchain.version),
                    phase: "configuration".to_string(),
                    compile_time_ms: None,
                    execution_time_ms: None,
                    peak_memory_kb: None,
                    stdout: None,
                    error: Some(format!("Failed to write probe source: {e}")),
                };
            }
        };

    // 4. Compilation phase
    let mut compile_time_ms: Option<u64> = None;
    let exe_name = if cfg!(windows) { "prog.exe" } else { "prog" };
    let staged_exe = workspace_dir.join(exe_name);

    match kind {
        #[cfg(target_os = "linux")]
        "cpp" | "c" | "pascal" | "java" => {
            let start = Instant::now();
            let output = crate::engine::compiler::compile_resolved_submission(
                crate::engine::compiler::CompileSubmissionRequest {
                    language: kind,
                    source_path: &source_path,
                    output_dir: &workspace_dir,
                    platform,
                    timeout_ms: None,
                    extra_include_dirs: &[],
                },
                &toolchain,
                None,
            );
            compile_time_ms = Some(start.elapsed().as_millis() as u64);
            let prepared = if output.status == "OK" {
                match output.executable.as_ref() {
                    Some(executable) if kind == "java" => executable.is_dir(),
                    Some(executable) => fs::copy(executable, &staged_exe).is_ok(),
                    None => false,
                }
            } else {
                false
            };
            if !prepared {
                return ToolchainDiagnosticResult {
                    success: false,
                    profile_id: profile_id.to_string(),
                    language: kind.to_string(),
                    source_mode: Some(toolchain.source_mode),
                    version: Some(toolchain.version),
                    phase: "compilation".to_string(),
                    compile_time_ms,
                    execution_time_ms: None,
                    peak_memory_kb: None,
                    stdout: None,
                    error: output.error.or_else(|| {
                        Some("Diagnostic compiler produced no usable artifact.".into())
                    }),
                };
            }
        }
        #[cfg(not(target_os = "linux"))]
        "cpp" | "c" => {
            let start = Instant::now();
            let mut cmd = std::process::Command::new(&toolchain.executable_path);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                cmd.creation_flags(CREATE_NO_WINDOW);
            }
            cmd.arg("-O2");
            if kind == "cpp" {
                cmd.arg("-std=c++14");
                let exe_str = toolchain.executable_path.to_string_lossy();
                if exe_str.ends_with("clang") || exe_str.ends_with("clang.exe") {
                    cmd.arg("-lc++");
                }
            } else {
                cmd.arg("-std=c11");
            }
            if !cfg!(target_os = "macos") {
                cmd.arg("-static");
            }
            #[cfg(target_os = "macos")]
            {
                if let Some(sdk) = resolve_macos_sdk_path() {
                    cmd.arg("-isysroot").arg(sdk);
                }
            }
            cmd.arg("-o").arg(&staged_exe).arg(&source_path);

            let mut path_entries = Vec::new();
            if let Some(exe_dir) = toolchain.executable_path.parent() {
                path_entries.push(exe_dir.to_string_lossy().into_owned());
            }
            if let Some(ref pkg_root) = toolchain.package_root {
                let bin_dir = pkg_root.join("bin").to_string_lossy().into_owned();
                if !path_entries.contains(&bin_dir) {
                    path_entries.push(bin_dir);
                }
            }
            if !path_entries.is_empty() {
                let delimiter = if cfg!(windows) { ";" } else { ":" };
                if let Ok(current_path) = std::env::var("PATH") {
                    if !current_path.is_empty() {
                        path_entries.push(current_path);
                    }
                }
                cmd.env("PATH", path_entries.join(delimiter));
            }

            let output = match cmd.output() {
                Ok(out) => out,
                Err(err) => {
                    let _ = fs::remove_dir_all(&workspace_dir);
                    return ToolchainDiagnosticResult {
                        success: false,
                        profile_id: profile_id.to_string(),
                        language: kind.to_string(),
                        source_mode: Some(toolchain.source_mode),
                        version: Some(toolchain.version),
                        phase: "compilation".to_string(),
                        compile_time_ms: Some(start.elapsed().as_millis() as u64),
                        execution_time_ms: None,
                        peak_memory_kb: None,
                        stdout: None,
                        error: Some(format!("Failed to spawn compiler: {err}")),
                    };
                }
            };

            let elapsed = start.elapsed().as_millis() as u64;
            compile_time_ms = Some(elapsed);

            if !output.status.success() {
                let err = String::from_utf8_lossy(&output.stderr).to_string();
                let _ = fs::remove_dir_all(&workspace_dir);
                return ToolchainDiagnosticResult {
                    success: false,
                    profile_id: profile_id.to_string(),
                    language: kind.to_string(),
                    source_mode: Some(toolchain.source_mode),
                    version: Some(toolchain.version),
                    phase: "compilation".to_string(),
                    compile_time_ms,
                    execution_time_ms: None,
                    peak_memory_kb: None,
                    stdout: None,
                    error: Some(err),
                };
            }
        }
        #[cfg(not(target_os = "linux"))]
        "pascal" => {
            let start = Instant::now();
            let mut cmd = std::process::Command::new(&toolchain.executable_path);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                cmd.creation_flags(CREATE_NO_WINDOW);
            }
            cmd.arg("-O2").arg("-XS").arg("-Sg");
            if cfg!(windows) {
                cmd.arg("-WR").arg("-Xs").arg("-Cs66060288");
            }
            #[cfg(target_os = "macos")]
            {
                if let Some(sdk) = resolve_macos_sdk_path() {
                    cmd.arg(format!("-XR{sdk}"));
                }
            }

            if let Some(ref pkg_root) = toolchain.package_root {
                let bin_dir = pkg_root.join("bin");
                if let Ok(current_path) = std::env::var("PATH") {
                    let delimiter = if cfg!(windows) { ";" } else { ":" };
                    cmd.env(
                        "PATH",
                        format!("{}{delimiter}{}", bin_dir.display(), current_path),
                    );
                }
                let target_triple = super::discovery::fpc_host_target_triple();
                if let Some(units_dir) =
                    super::discovery::find_fpc_units_dir(pkg_root, target_triple)
                {
                    cmd.arg(format!("-Fu{}", units_dir.join("*").display()));
                    cmd.arg(format!("-Fu{}", units_dir.join("rtl").display()));
                }
            }
            cmd.arg(format!("-o{}", staged_exe.display()))
                .arg(&source_path);

            let output = match cmd.output() {
                Ok(out) => out,
                Err(err) => {
                    let _ = fs::remove_dir_all(&workspace_dir);
                    return ToolchainDiagnosticResult {
                        success: false,
                        profile_id: profile_id.to_string(),
                        language: kind.to_string(),
                        source_mode: Some(toolchain.source_mode),
                        version: Some(toolchain.version),
                        phase: "compilation".to_string(),
                        compile_time_ms: Some(start.elapsed().as_millis() as u64),
                        execution_time_ms: None,
                        peak_memory_kb: None,
                        stdout: None,
                        error: Some(format!("Failed to spawn FPC: {err}")),
                    };
                }
            };

            let elapsed = start.elapsed().as_millis() as u64;
            compile_time_ms = Some(elapsed);

            if !output.status.success() {
                let err = String::from_utf8_lossy(&output.stderr).to_string();
                let _ = fs::remove_dir_all(&workspace_dir);
                return ToolchainDiagnosticResult {
                    success: false,
                    profile_id: profile_id.to_string(),
                    language: kind.to_string(),
                    source_mode: Some(toolchain.source_mode),
                    version: Some(toolchain.version),
                    phase: "compilation".to_string(),
                    compile_time_ms,
                    execution_time_ms: None,
                    peak_memory_kb: None,
                    stdout: None,
                    error: Some(err),
                };
            }
        }
        #[cfg(not(target_os = "linux"))]
        "java" => {
            let start = Instant::now();
            let mut cmd = std::process::Command::new(&toolchain.executable_path);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                cmd.creation_flags(CREATE_NO_WINDOW);
            }
            cmd.arg("-d").arg(&workspace_dir).arg(&source_path);

            let output = match cmd.output() {
                Ok(out) => out,
                Err(err) => {
                    let _ = fs::remove_dir_all(&workspace_dir);
                    return ToolchainDiagnosticResult {
                        success: false,
                        profile_id: profile_id.to_string(),
                        language: kind.to_string(),
                        source_mode: Some(toolchain.source_mode),
                        version: Some(toolchain.version),
                        phase: "compilation".to_string(),
                        compile_time_ms: Some(start.elapsed().as_millis() as u64),
                        execution_time_ms: None,
                        peak_memory_kb: None,
                        stdout: None,
                        error: Some(format!("Failed to spawn javac: {err}")),
                    };
                }
            };

            let elapsed = start.elapsed().as_millis() as u64;
            compile_time_ms = Some(elapsed);

            if !output.status.success() {
                let err = String::from_utf8_lossy(&output.stderr).to_string();
                let _ = fs::remove_dir_all(&workspace_dir);
                return ToolchainDiagnosticResult {
                    success: false,
                    profile_id: profile_id.to_string(),
                    language: kind.to_string(),
                    source_mode: Some(toolchain.source_mode),
                    version: Some(toolchain.version),
                    phase: "compilation".to_string(),
                    compile_time_ms,
                    execution_time_ms: None,
                    peak_memory_kb: None,
                    stdout: None,
                    error: Some(err),
                };
            }
        }
        _ => {
            // Script languages (python, scratch) do not have a separate compile step
        }
    }

    // 5. Build RunSpec for sandbox execution
    let run_id = format!("exec_{}_{}", std::process::id(), count);
    let stdout_path = workspace_dir.join("stdout.txt");
    let stderr_path = workspace_dir.join("stderr.txt");

    let limits = RunLimits {
        wall_time_ms: diagnostic_wall_time_ms(kind),
        memory_bytes: if kind == "java" || kind == "scratch" {
            512 * 1024 * 1024
        } else {
            128 * 1024 * 1024
        },
        process_count: 1,
        thread_count: if kind == "scratch" || kind == "java" {
            64
        } else {
            16
        },
        output_bytes: if kind == "scratch" {
            10 * 1024 * 1024
        } else {
            1024 * 1024
        },
        total_write_bytes: if kind == "scratch" {
            100 * 1024 * 1024
        } else {
            4 * 1024 * 1024
        },
        open_files: if kind == "scratch" { 64 } else { 32 },
        created_files: if kind == "scratch" { 256 } else { 16 },
    };

    let spec = match kind {
        "cpp" | "c" | "pascal" => RunSpec {
            run_id: run_id.clone(),
            role: RunRole::Submission,
            workspace_id: workspace_id.clone(),
            executable_id: format!("workspaces/{}/{}", workspace_id, exe_name),
            args: Vec::new(),
            stdin_file: None,
            stdout_file: "stdout.txt".to_string(),
            stderr_file: "stderr.txt".to_string(),
            environment: BTreeMap::new(),
            toolchain: None,
            local_toolchain: None,
            limits,
        },
        "python" => {
            let receipt = toolchain
                .package_root
                .as_ref()
                .and_then(|p| super::discovery::read_package_receipt(p));

            if let (Some(pkg_root), Some(receipt)) = (&toolchain.package_root, receipt) {
                match super::discovery::ensure_cached_managed_toolchain(
                    &platform.root(),
                    pkg_root,
                    &receipt,
                ) {
                    Ok(cached_root) => {
                        let cache_id = super::discovery::managed_cache_id(
                            &receipt.package_id,
                            &receipt.version,
                            &receipt.archive_sha256,
                        );
                        let relative_exe = receipt
                            .components
                            .iter()
                            .find(|c| c.id == receipt.entrypoint_component_id)
                            .map(|c| c.relative_path.as_str())
                            .unwrap_or(if cfg!(windows) {
                                "python.exe"
                            } else {
                                "bin/python3"
                            });
                        let exe_dir = cached_root
                            .join(relative_exe)
                            .parent()
                            .map(Path::to_path_buf)
                            .unwrap_or_else(|| cached_root.clone());

                        let mut env = BTreeMap::new();
                        env.insert("JUDGEDESK_PYTHON_ISOLATED".to_string(), "1".to_string());
                        env.insert("PYTHONNOUSERSITE".to_string(), "1".to_string());
                        env.insert("PYTHONDONTWRITEBYTECODE".to_string(), "1".to_string());
                        env.insert(
                            "PYTHONHOME".to_string(),
                            cached_root.to_string_lossy().into_owned(),
                        );
                        env.insert("PATH".to_string(), exe_dir.to_string_lossy().into_owned());

                        RunSpec {
                            run_id: run_id.clone(),
                            role: RunRole::Submission,
                            workspace_id: workspace_id.clone(),
                            executable_id: format!("toolchains/{cache_id}/{relative_exe}"),
                            args: vec!["-I".to_string(), "-B".to_string(), "probe.py".to_string()],
                            stdin_file: None,
                            stdout_file: "stdout.txt".to_string(),
                            stderr_file: "stderr.txt".to_string(),
                            environment: env,
                            toolchain: Some(judgedesk_native_executor::protocol::ToolchainGrant {
                                package_id: receipt.package_id.clone(),
                                package_digest: receipt.archive_sha256.clone(),
                                component_id: receipt.entrypoint_component_id.clone(),
                                role: ToolchainGrantRole::SubmissionRuntime,
                            }),
                            local_toolchain: None,
                            limits,
                        }
                    }
                    Err(e) => {
                        let _ = fs::remove_dir_all(&workspace_dir);
                        return ToolchainDiagnosticResult {
                            success: false,
                            profile_id: profile_id.to_string(),
                            language: kind.to_string(),
                            source_mode: Some(toolchain.source_mode),
                            version: Some(toolchain.version),
                            phase: "configuration".to_string(),
                            compile_time_ms: None,
                            execution_time_ms: None,
                            peak_memory_kb: None,
                            stdout: None,
                            error: Some(format!("Failed to cache managed python toolchain: {e}")),
                        };
                    }
                }
            } else {
                let (exe_canon, mut python_root) =
                    super::discovery::resolve_macos_framework_python_executable(
                        &toolchain.executable_path,
                    )
                    .unwrap_or_else(|| {
                        let canon =
                            super::discovery::clean_canonical_path(&toolchain.executable_path);
                        let root = toolchain
                            .package_root
                            .as_ref()
                            .map(|p| super::discovery::clean_canonical_path(p))
                            .or_else(|| canon.parent().map(Path::to_path_buf))
                            .unwrap_or_else(|| PathBuf::from("."));
                        (canon, root)
                    });
                if let Some(ref pkg_root) = toolchain.package_root {
                    let pkg_canon = super::discovery::clean_canonical_path(pkg_root);
                    if exe_canon.starts_with(&pkg_canon) {
                        python_root = pkg_canon;
                    }
                }
                let mut rel_exe = exe_canon
                    .strip_prefix(&python_root)
                    .ok()
                    .filter(|rel| !rel.as_os_str().is_empty())
                    .map(|rel| rel.to_string_lossy().replace('\\', "/"))
                    .unwrap_or_default();
                if rel_exe.is_empty() {
                    if let Some(parent) = exe_canon.parent() {
                        python_root = parent.to_path_buf();
                    }
                    rel_exe = exe_canon
                        .file_name()
                        .and_then(|f| f.to_str())
                        .unwrap_or(if cfg!(windows) {
                            "python.exe"
                        } else {
                            "python3"
                        })
                        .to_string();
                }
                let exe_dir = exe_canon
                    .parent()
                    .map(Path::to_path_buf)
                    .unwrap_or_else(|| python_root.clone());

                let mut env = BTreeMap::new();
                env.insert("JUDGEDESK_PYTHON_ISOLATED".to_string(), "1".to_string());
                env.insert("PYTHONNOUSERSITE".to_string(), "1".to_string());
                env.insert("PYTHONDONTWRITEBYTECODE".to_string(), "1".to_string());
                env.insert(
                    "PYTHONHOME".to_string(),
                    python_root.to_string_lossy().into_owned(),
                );
                env.insert("PATH".to_string(), exe_dir.to_string_lossy().into_owned());

                let isolation = if cfg!(target_os = "linux") {
                    LocalToolchainIsolation::Strict
                } else {
                    LocalToolchainIsolation::ResourceOnly
                };

                RunSpec {
                    run_id: run_id.clone(),
                    role: RunRole::Submission,
                    workspace_id: workspace_id.clone(),
                    executable_id: format!("local-toolchain/{rel_exe}"),
                    args: vec!["-I".to_string(), "-B".to_string(), "probe.py".to_string()],
                    stdin_file: None,
                    stdout_file: "stdout.txt".to_string(),
                    stderr_file: "stderr.txt".to_string(),
                    environment: env,
                    toolchain: None,
                    local_toolchain: Some(LocalToolchainGrant {
                        root_path: python_root.to_string_lossy().into_owned(),
                        executable_relative_path: rel_exe,
                        isolation,
                        role: ToolchainGrantRole::SubmissionRuntime,
                    }),
                    limits,
                }
            }
        }
        "java" => {
            let receipt = toolchain
                .package_root
                .as_ref()
                .and_then(|p| super::discovery::read_package_receipt(p));
            let local_isolation = if cfg!(target_os = "linux") {
                LocalToolchainIsolation::Strict
            } else {
                LocalToolchainIsolation::ResourceOnly
            };
            let java_args = || {
                vec![
                    "-XX:+UseSerialGC".to_string(),
                    "-XX:ActiveProcessorCount=1".to_string(),
                    "-XX:TieredStopAtLevel=1".to_string(),
                    "-XX:+ExitOnOutOfMemoryError".to_string(),
                    "-XX:MaxRAM=536870912".to_string(),
                    "-XX:MaxRAMPercentage=65.0".to_string(),
                    "-Dfile.encoding=UTF-8".to_string(),
                    "-Duser.language=en".to_string(),
                    "-Duser.country=US".to_string(),
                    "-Djava.io.tmpdir=.".to_string(),
                    "-Duser.home=.".to_string(),
                    "-cp".to_string(),
                    if cfg!(target_os = "linux") {
                        "java_classes"
                    } else {
                        "."
                    }
                    .to_string(),
                    "Main".to_string(),
                ]
            };

            if let (Some(pkg_root), Some(receipt)) = (&toolchain.package_root, receipt) {
                match super::discovery::ensure_cached_managed_toolchain(
                    &platform.root(),
                    pkg_root,
                    &receipt,
                ) {
                    Ok(cached_root) => {
                        let _cache_id = super::discovery::managed_cache_id(
                            &receipt.package_id,
                            &receipt.version,
                            &receipt.archive_sha256,
                        );
                        let relative_exe = if cfg!(windows) {
                            "bin/java.exe"
                        } else {
                            "bin/java"
                        };

                        let mut env = BTreeMap::new();
                        env.insert("JUDGEDESK_JAVA_ISOLATED".to_string(), "1".to_string());
                        env.insert(
                            "JAVA_HOME".to_string(),
                            cached_root.to_string_lossy().into_owned(),
                        );
                        env.insert(
                            "PATH".to_string(),
                            cached_root.join("bin").to_string_lossy().into_owned(),
                        );

                        RunSpec {
                            run_id: run_id.clone(),
                            role: RunRole::Submission,
                            workspace_id: workspace_id.clone(),
                            executable_id: format!("local-toolchain/{relative_exe}"),
                            args: java_args(),
                            stdin_file: None,
                            stdout_file: "stdout.txt".to_string(),
                            stderr_file: "stderr.txt".to_string(),
                            environment: env,
                            toolchain: None,
                            local_toolchain: Some(LocalToolchainGrant {
                                root_path: cached_root.to_string_lossy().into_owned(),
                                executable_relative_path: relative_exe.to_string(),
                                isolation: local_isolation,
                                role: ToolchainGrantRole::SubmissionRuntime,
                            }),
                            limits,
                        }
                    }
                    Err(_) => {
                        let java_exe = toolchain
                            .runtime_executable_path
                            .as_ref()
                            .unwrap_or(&toolchain.executable_path);
                        let java_root = toolchain
                            .package_root
                            .clone()
                            .or_else(|| {
                                java_exe
                                    .parent()
                                    .and_then(|p| p.parent())
                                    .map(|p| p.to_path_buf())
                            })
                            .unwrap_or_else(|| PathBuf::from("."));
                        let relative_exe = if cfg!(windows) {
                            "bin/java.exe"
                        } else {
                            "bin/java"
                        };

                        let mut env = BTreeMap::new();
                        env.insert("JUDGEDESK_JAVA_ISOLATED".to_string(), "1".to_string());
                        env.insert(
                            "JAVA_HOME".to_string(),
                            java_root.to_string_lossy().into_owned(),
                        );
                        env.insert(
                            "PATH".to_string(),
                            java_root.join("bin").to_string_lossy().into_owned(),
                        );

                        RunSpec {
                            run_id: run_id.clone(),
                            role: RunRole::Submission,
                            workspace_id: workspace_id.clone(),
                            executable_id: format!("local-toolchain/{relative_exe}"),
                            args: java_args(),
                            stdin_file: None,
                            stdout_file: "stdout.txt".to_string(),
                            stderr_file: "stderr.txt".to_string(),
                            environment: env,
                            toolchain: None,
                            local_toolchain: Some(LocalToolchainGrant {
                                root_path: java_root.to_string_lossy().into_owned(),
                                executable_relative_path: relative_exe.to_string(),
                                isolation: local_isolation,
                                role: ToolchainGrantRole::SubmissionRuntime,
                            }),
                            limits,
                        }
                    }
                }
            } else {
                let java_exe = toolchain
                    .runtime_executable_path
                    .as_ref()
                    .unwrap_or(&toolchain.executable_path);

                let java_root = toolchain
                    .package_root
                    .clone()
                    .or_else(|| {
                        java_exe
                            .parent()
                            .and_then(|p| p.parent())
                            .map(|p| p.to_path_buf())
                    })
                    .unwrap_or_else(|| PathBuf::from("."));

                let relative_exe = if cfg!(windows) {
                    "bin/java.exe"
                } else {
                    "bin/java"
                };

                let mut env = BTreeMap::new();
                env.insert("JUDGEDESK_JAVA_ISOLATED".to_string(), "1".to_string());
                env.insert(
                    "JAVA_HOME".to_string(),
                    java_root.to_string_lossy().into_owned(),
                );
                env.insert(
                    "PATH".to_string(),
                    java_root.join("bin").to_string_lossy().into_owned(),
                );

                RunSpec {
                    run_id: run_id.clone(),
                    role: RunRole::Submission,
                    workspace_id: workspace_id.clone(),
                    executable_id: format!("local-toolchain/{relative_exe}"),
                    args: java_args(),
                    stdin_file: None,
                    stdout_file: "stdout.txt".to_string(),
                    stderr_file: "stderr.txt".to_string(),
                    environment: env,
                    toolchain: None,
                    local_toolchain: Some(LocalToolchainGrant {
                        root_path: java_root.to_string_lossy().into_owned(),
                        executable_relative_path: relative_exe.to_string(),
                        isolation: local_isolation,
                        role: ToolchainGrantRole::SubmissionRuntime,
                    }),
                    limits,
                }
            }
        }

        "scratch" => {
            let receipt = toolchain
                .package_root
                .as_ref()
                .and_then(|p| super::discovery::read_package_receipt(p));

            if let (Some(pkg_root), Some(receipt)) = (&toolchain.package_root, receipt) {
                match super::discovery::ensure_cached_managed_toolchain(
                    &platform.root(),
                    pkg_root,
                    &receipt,
                ) {
                    Ok(cached_root) => {
                        let cache_id = super::discovery::managed_cache_id(
                            &receipt.package_id,
                            &receipt.version,
                            &receipt.archive_sha256,
                        );
                        let relative_exe = receipt
                            .components
                            .iter()
                            .find(|c| c.id == receipt.entrypoint_component_id)
                            .map(|c| c.relative_path.as_str())
                            .unwrap_or(if cfg!(windows) {
                                "scratch-run.exe"
                            } else {
                                "scratch-run"
                            });

                        let mut env = BTreeMap::new();
                        env.insert("JUDGEDESK_SCRATCH_ISOLATED".to_string(), "1".to_string());
                        env.insert("TURBO_MODE".to_string(), "1".to_string());
                        env.insert(
                            "PATH".to_string(),
                            cached_root.to_string_lossy().into_owned(),
                        );

                        RunSpec {
                            run_id: run_id.clone(),
                            role: RunRole::Submission,
                            workspace_id: workspace_id.clone(),
                            executable_id: format!("toolchains/{cache_id}/{relative_exe}"),
                            args: vec!["probe.json".to_string()],
                            stdin_file: None,
                            stdout_file: "stdout.txt".to_string(),
                            stderr_file: "stderr.txt".to_string(),
                            environment: env,
                            toolchain: Some(judgedesk_native_executor::protocol::ToolchainGrant {
                                package_id: receipt.package_id.clone(),
                                package_digest: receipt.archive_sha256.clone(),
                                component_id: receipt.entrypoint_component_id.clone(),
                                role: ToolchainGrantRole::SubmissionRuntime,
                            }),
                            local_toolchain: None,
                            limits,
                        }
                    }
                    Err(e) => {
                        let _ = fs::remove_dir_all(&workspace_dir);
                        return ToolchainDiagnosticResult {
                            success: false,
                            profile_id: profile_id.to_string(),
                            language: kind.to_string(),
                            source_mode: Some(toolchain.source_mode),
                            version: Some(toolchain.version),
                            phase: "configuration".to_string(),
                            compile_time_ms: None,
                            execution_time_ms: None,
                            peak_memory_kb: None,
                            stdout: None,
                            error: Some(format!("Failed to cache managed scratch toolchain: {e}")),
                        };
                    }
                }
            } else {
                let scratch_root = toolchain
                    .package_root
                    .clone()
                    .or_else(|| toolchain.executable_path.parent().map(|p| p.to_path_buf()))
                    .unwrap_or_else(|| PathBuf::from("."));

                let scratch_exe_name = toolchain
                    .executable_path
                    .file_name()
                    .and_then(|f| f.to_str())
                    .unwrap_or(if cfg!(windows) {
                        "scratch-run.exe"
                    } else {
                        "scratch-run"
                    });

                let mut env = BTreeMap::new();
                env.insert("JUDGEDESK_SCRATCH_ISOLATED".to_string(), "1".to_string());
                env.insert("TURBO_MODE".to_string(), "1".to_string());
                env.insert(
                    "PATH".to_string(),
                    scratch_root.to_string_lossy().into_owned(),
                );

                let isolation = if cfg!(target_os = "linux") {
                    LocalToolchainIsolation::Strict
                } else {
                    LocalToolchainIsolation::ResourceOnly
                };

                RunSpec {
                    run_id: run_id.clone(),
                    role: RunRole::Submission,
                    workspace_id: workspace_id.clone(),
                    executable_id: format!("local-toolchain/{scratch_exe_name}"),
                    args: vec!["probe.json".to_string()],
                    stdin_file: None,
                    stdout_file: "stdout.txt".to_string(),
                    stderr_file: "stderr.txt".to_string(),
                    environment: env,
                    toolchain: None,
                    local_toolchain: Some(LocalToolchainGrant {
                        root_path: scratch_root.to_string_lossy().into_owned(),
                        executable_relative_path: scratch_exe_name.to_string(),
                        isolation,
                        role: ToolchainGrantRole::SubmissionRuntime,
                    }),
                    limits,
                }
            }
        }

        _ => {
            // Scratch or generic
            RunSpec {
                run_id: run_id.clone(),
                role: RunRole::Submission,
                workspace_id: workspace_id.clone(),
                executable_id: format!("workspaces/{}/{}", workspace_id, exe_name),
                args: Vec::new(),
                stdin_file: None,
                stdout_file: "stdout.txt".to_string(),
                stderr_file: "stderr.txt".to_string(),
                environment: BTreeMap::new(),
                toolchain: None,
                local_toolchain: None,
                limits,
            }
        }
    };

    let _validated = match validate_run(&platform.root(), &spec) {
        Ok(v) => v,
        Err(err) => {
            let _ = fs::remove_dir_all(&workspace_dir);
            return ToolchainDiagnosticResult {
                success: false,
                profile_id: profile_id.to_string(),
                language: kind.to_string(),
                source_mode: Some(toolchain.source_mode),
                version: Some(toolchain.version),
                phase: "execution".to_string(),
                compile_time_ms,
                execution_time_ms: None,
                peak_memory_kb: None,
                stdout: None,
                error: Some(format!("Sandbox validation error: {err}")),
            };
        }
    };

    let run_result = match platform.run_sync(Box::new(spec.clone())) {
        Ok(r) => r,
        Err(e) => {
            let _ = fs::remove_dir_all(&workspace_dir);
            return ToolchainDiagnosticResult {
                success: false,
                profile_id: profile_id.to_string(),
                language: kind.to_string(),
                source_mode: Some(toolchain.source_mode),
                version: Some(toolchain.version),
                phase: "execution".to_string(),
                compile_time_ms,
                execution_time_ms: None,
                peak_memory_kb: None,
                stdout: None,
                error: Some(format!("Executor error: {e}")),
            };
        }
    };

    let stdout = if stdout_path.is_file() {
        fs::read_to_string(&stdout_path).unwrap_or_default()
    } else {
        String::new()
    };

    let stderr = if stderr_path.is_file() {
        fs::read_to_string(&stderr_path).unwrap_or_default()
    } else {
        String::new()
    };

    let _ = fs::remove_dir_all(&workspace_dir);

    let exec_time_ms = (run_result.wall_time_us / 1000).max(1);
    let peak_mem_kb = (run_result.peak_memory_bytes.unwrap_or(0) / 1024).max(1);

    if matches!(run_result.reason, RunReason::Exited)
        && run_result.exit_code == Some(0)
        && stdout.contains(PROBE_TOKEN_MARKER)
    {
        ToolchainDiagnosticResult {
            success: true,
            profile_id: profile_id.to_string(),
            language: kind.to_string(),
            source_mode: Some(toolchain.source_mode),
            version: Some(toolchain.version),
            phase: "execution".to_string(),
            compile_time_ms,
            execution_time_ms: Some(exec_time_ms),
            peak_memory_kb: Some(peak_mem_kb),
            stdout: Some(stdout.trim().to_string()),
            error: None,
        }
    } else {
        let err_detail = run_result
            .diagnostic
            .or_else(|| {
                if !stderr.trim().is_empty() {
                    Some(stderr)
                } else {
                    None
                }
            })
            .unwrap_or_else(|| {
                format!(
                    "Process execution failed (reason: {:?}, exit code: {:?})",
                    run_result.reason, run_result.exit_code
                )
            });

        ToolchainDiagnosticResult {
            success: false,
            profile_id: profile_id.to_string(),
            language: kind.to_string(),
            source_mode: Some(toolchain.source_mode),
            version: Some(toolchain.version),
            phase: "execution".to_string(),
            compile_time_ms,
            execution_time_ms: Some(exec_time_ms),
            peak_memory_kb: Some(peak_mem_kb),
            stdout: Some(stdout.trim().to_string()),
            error: Some(err_detail),
        }
    }
}
