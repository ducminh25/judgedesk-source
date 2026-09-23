use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompilationOutput {
    pub status: String, // "OK", "CE"
    pub error: Option<String>,
    pub executable: Option<PathBuf>,
}

pub fn compile_submission(
    language: &str,
    source_path: &Path,
    output_dir: &Path,
) -> CompilationOutput {
    match language {
        "cpp" => {
            let out_exe = output_dir.join(if cfg!(windows) {
                "submission.exe"
            } else {
                "submission"
            });
            let mut cmd = Command::new("g++");
            cmd.arg("-O2").arg("-std=c++14");
            if !cfg!(target_os = "macos") {
                cmd.arg("-static");
            }
            if cfg!(windows) {
                cmd.arg("-Wl,--stack,66060288");
            }
            cmd.arg("-o").arg(&out_exe).arg(source_path);

            match cmd.output() {
                Ok(output) if output.status.success() => CompilationOutput {
                    status: "OK".to_string(),
                    error: None,
                    executable: Some(out_exe),
                },
                Ok(output) => {
                    let err = String::from_utf8_lossy(&output.stderr).to_string();
                    CompilationOutput {
                        status: "CE".to_string(),
                        error: Some(err),
                        executable: None,
                    }
                }
                Err(e) => CompilationOutput {
                    status: "CE".to_string(),
                    error: Some(format!("Failed to launch compiler g++: {e}")),
                    executable: None,
                },
            }
        }
        "c" => {
            let out_exe = output_dir.join(if cfg!(windows) {
                "submission.exe"
            } else {
                "submission"
            });
            let mut cmd = Command::new("gcc");
            cmd.arg("-O2").arg("-std=c11");
            if !cfg!(target_os = "macos") {
                cmd.arg("-static");
            }
            if cfg!(windows) {
                cmd.arg("-Wl,--stack,66060288");
            }
            cmd.arg("-o").arg(&out_exe).arg(source_path);
            if !cfg!(target_os = "macos") {
                cmd.arg("-lm");
            }

            match cmd.output() {
                Ok(output) if output.status.success() => CompilationOutput {
                    status: "OK".to_string(),
                    error: None,
                    executable: Some(out_exe),
                },
                Ok(output) => {
                    let err = String::from_utf8_lossy(&output.stderr).to_string();
                    CompilationOutput {
                        status: "CE".to_string(),
                        error: Some(err),
                        executable: None,
                    }
                }
                Err(e) => CompilationOutput {
                    status: "CE".to_string(),
                    error: Some(format!("Failed to launch compiler gcc: {e}")),
                    executable: None,
                },
            }
        }
        "python" => CompilationOutput {
            status: "OK".to_string(),
            error: None,
            executable: Some(source_path.to_path_buf()),
        },
        "pascal" => {
            let out_exe = output_dir.join(if cfg!(windows) {
                "submission.exe"
            } else {
                "submission"
            });
            let mut cmd = Command::new("fpc");
            cmd.arg("-O2")
                .arg(format!("-o{}", out_exe.display()))
                .arg(source_path);

            match cmd.output() {
                Ok(output) if output.status.success() => CompilationOutput {
                    status: "OK".to_string(),
                    error: None,
                    executable: Some(out_exe),
                },
                Ok(output) => {
                    let err = String::from_utf8_lossy(&output.stderr).to_string();
                    CompilationOutput {
                        status: "CE".to_string(),
                        error: Some(err),
                        executable: None,
                    }
                }
                Err(e) => CompilationOutput {
                    status: "CE".to_string(),
                    error: Some(format!("Failed to launch compiler fpc: {e}")),
                    executable: None,
                },
            }
        }
        _ => CompilationOutput {
            status: "CE".to_string(),
            error: Some(format!("Unsupported language: {language}")),
            executable: None,
        },
    }
}

pub fn compile_checker(checker_path: &Path, output_dir: &Path) -> CompilationOutput {
    let lower = checker_path.to_string_lossy().to_lowercase();
    if lower.ends_with(".exe") || (!cfg!(windows) && !lower.contains('.')) {
        return CompilationOutput {
            status: "OK".to_string(),
            error: None,
            executable: Some(checker_path.to_path_buf()),
        };
    }
    if lower.ends_with(".py") {
        return CompilationOutput {
            status: "OK".to_string(),
            error: None,
            executable: Some(checker_path.to_path_buf()),
        };
    }
    if lower.ends_with(".cpp") || lower.ends_with(".cc") || lower.ends_with(".cxx") {
        let out_exe = output_dir.join(if cfg!(windows) {
            "checker.exe"
        } else {
            "checker"
        });
        let mut cmd = Command::new("g++");
        cmd.arg("-O2").arg("-std=c++14");

        // Check if testlib.h exists next to checker or in judgers/
        if let Some(parent) = checker_path.parent() {
            if parent.join("testlib.h").is_file() {
                cmd.arg("-I").arg(parent);
            }
        }
        if Path::new("judgers").join("testlib.h").is_file() {
            cmd.arg("-I").arg("judgers");
        }

        if !cfg!(target_os = "macos") {
            cmd.arg("-static");
        }
        if cfg!(windows) {
            cmd.arg("-Wl,--stack,66060288");
        }
        cmd.arg("-o").arg(&out_exe).arg(checker_path);

        match cmd.output() {
            Ok(output) if output.status.success() => CompilationOutput {
                status: "OK".to_string(),
                error: None,
                executable: Some(out_exe),
            },
            Ok(output) => {
                let err = String::from_utf8_lossy(&output.stderr).to_string();
                CompilationOutput {
                    status: "CE".to_string(),
                    error: Some(err),
                    executable: None,
                }
            }
            Err(e) => CompilationOutput {
                status: "CE".to_string(),
                error: Some(format!("Failed to launch g++ for checker: {e}")),
                executable: None,
            },
        }
    } else {
        CompilationOutput {
            status: "CE".to_string(),
            error: Some(format!(
                "Unsupported checker format: {}",
                checker_path.display()
            )),
            executable: None,
        }
    }
}
