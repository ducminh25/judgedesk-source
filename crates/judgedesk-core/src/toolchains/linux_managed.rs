use super::discovery::ResolvedToolchain;
use judgedesk_native_executor::protocol::linux_sandbox_paths::TOOLCHAIN_ROOT;
use std::path::{Component, Path, PathBuf};

pub fn compiler_visible_path(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| "Compiler path is outside the granted package")?;
    if relative
        .components()
        .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("Compiler path escapes the granted package".into());
    }
    Ok(Path::new(TOOLCHAIN_ROOT).join(relative))
}

pub fn is_managed_linux_toolchain(toolchain: &ResolvedToolchain) -> bool {
    cfg!(target_os = "linux")
        && toolchain.source_mode == "managed"
        && toolchain.package_root.is_some()
}

/// Apply only to managed Linux packages with a pinned complete sysroot. Local
/// compiler behavior and Windows/macOS compilation contracts are unchanged.
pub fn compiler_support_args(
    kind: &str,
    root: &Path,
    linking: bool,
) -> Result<Vec<String>, String> {
    let sysroot = root.join("sysroot");
    let bin = root.join("bin");
    if !sysroot.is_dir() || !bin.is_dir() {
        return Err(
            "MANAGED_PACKAGE_CORRUPT: Linux compiler sysroot or helpers are missing".into(),
        );
    }
    match kind {
        "cpp" | "c" => {
            let mut args = vec![
                format!("--sysroot={}", sysroot.display()),
                format!("-B{}/", bin.display()),
            ];
            if linking {
                args.push("-static-libgcc".into());
                if kind == "cpp" {
                    args.push("-static-libstdc++".into());
                }
            }
            Ok(args)
        }
        "pascal" => {
            let visible_sysroot = compiler_visible_path(root, &sysroot)?;
            Ok(vec![
                format!("-XR{}", visible_sysroot.display()),
                // -XR adjusts FPC search paths, not absolute paths inside ld
                // scripts such as the sysroot's glibc GROUP directive.
                format!("-k--sysroot={}", visible_sysroot.display()),
                format!("-FD{}", compiler_visible_path(root, &bin)?.display()),
                format!(
                    "-Fl{}",
                    visible_sysroot.join("usr/lib/x86_64-linux-gnu").display()
                ),
                format!(
                    "-Fl{}",
                    visible_sysroot.join("lib/x86_64-linux-gnu").display()
                ),
            ])
        }
        _ => Err("Linux managed compiler support does not apply to this language".into()),
    }
}
