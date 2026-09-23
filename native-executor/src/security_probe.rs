use std::io::{self, Write};
use std::time::Duration;

pub fn security_probe_child() {
    use std::net::{SocketAddr, TcpStream};
    #[cfg(not(target_os = "macos"))]
    use std::process::Command;

    let sentinel = std::env::args()
        .nth(2)
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::var_os("JUDGEDESK_PROBE_SENTINEL").map(std::path::PathBuf::from));
    let read_blocked = sentinel
        .as_ref()
        .is_some_and(|path| std::fs::read(path).is_err());
    let write_blocked = sentinel
        .as_ref()
        .is_some_and(|path| std::fs::write(path, b"OVERWRITTEN").is_err());
    let address: SocketAddr = "127.0.0.1:9".parse().unwrap();
    let network_blocked = std::panic::catch_unwind(|| {
        let network_error = TcpStream::connect_timeout(&address, Duration::from_millis(500)).err();
        network_error.as_ref().is_some_and(|error| {
            error.kind() == std::io::ErrorKind::PermissionDenied
                || matches!(error.raw_os_error(), Some(13 | 10013 | 10107))
        })
    })
    .unwrap_or(true);
    #[cfg(not(target_os = "macos"))]
    let (process_command, process_args): (&str, &[&str]) = if cfg!(windows) {
        ("cmd.exe", &["/c", "exit", "0"])
    } else {
        ("/bin/sh", &["-c", "exit 0"])
    };
    let probe = serde_json::json!({
        "readBlocked": read_blocked,
        "writeBlocked": write_blocked,
        "networkBlocked": network_blocked,
        "processAttemptStarted": true,
    });
    #[cfg(target_os = "macos")]
    let probe = {
        let mut probe = probe;
        probe["processGroupEscape"] = macos_process_group_escape_probe();
        let forbidden_exec = macos_forbidden_exec_probe();
        probe["forbiddenExecBlockedWithEperm"] =
            serde_json::Value::Bool(forbidden_exec.blocked_with_eperm);
        probe["forbiddenExecDetail"] = serde_json::Value::String(forbidden_exec.detail);
        probe
    };
    println!("{probe}");
    let _ = io::stdout().flush();
    #[cfg(not(target_os = "macos"))]
    {
        let process_blocked = Command::new(process_command)
            .args(process_args)
            .status()
            .is_err();
        if !process_blocked {
            // The parent treats this reserved code as proof that a forbidden child really ran.
            std::process::exit(97);
        }
    }
}

#[cfg(target_os = "macos")]
struct MacosGroupEscapeProbe {
    blocked_with_eperm: bool,
    detail: String,
}

#[cfg(target_os = "macos")]
fn macos_process_group_escape_probe() -> serde_json::Value {
    let setpgid = forked_macos_group_escape_probe("setpgid", || unsafe { libc::setpgid(0, 0) });
    let setsid = forked_macos_group_escape_probe("setsid", || unsafe { libc::setsid() });
    let posix_spawn = macos_posix_spawn_group_escape_probe();
    serde_json::json!({
        "setpgidBlockedWithEperm": setpgid.blocked_with_eperm,
        "setpgidDetail": setpgid.detail,
        "setsidBlockedWithEperm": setsid.blocked_with_eperm,
        "setsidDetail": setsid.detail,
        "posixSpawnGroupBlockedWithEperm": posix_spawn.blocked_with_eperm,
        "posixSpawnGroupDetail": posix_spawn.detail,
    })
}

#[cfg(target_os = "macos")]
fn macos_forbidden_exec_probe() -> MacosGroupEscapeProbe {
    use std::ffi::CString;

    let shell = CString::new("/bin/sh").unwrap();
    let shell_name = CString::new("sh").unwrap();
    let command_flag = CString::new("-c").unwrap();
    let command = CString::new("exit 97").unwrap();
    let environment = unsafe { *libc::_NSGetEnviron() as *const *const libc::c_char };
    let child = unsafe { libc::fork() };
    if child < 0 {
        return MacosGroupEscapeProbe {
            blocked_with_eperm: false,
            detail: format!(
                "forbidden exec probe fork failed: {}",
                io::Error::last_os_error()
            ),
        };
    }
    if child == 0 {
        let arguments = [
            shell_name.as_ptr(),
            command_flag.as_ptr(),
            command.as_ptr(),
            std::ptr::null(),
        ];
        unsafe {
            libc::execve(shell.as_ptr(), arguments.as_ptr(), environment);
            let error = *libc::__error();
            libc::_exit(if error == libc::EPERM {
                0
            } else {
                32 + error.clamp(0, 200)
            });
        }
    }

    match wait_for_macos_probe_child(child) {
        Ok(0) => MacosGroupEscapeProbe {
            blocked_with_eperm: true,
            detail: "blocked with EPERM".into(),
        },
        Ok(97) => MacosGroupEscapeProbe {
            blocked_with_eperm: false,
            detail: "/bin/sh unexpectedly executed".into(),
        },
        Ok(code) if (32..=232).contains(&code) => MacosGroupEscapeProbe {
            blocked_with_eperm: false,
            detail: format!("forbidden exec returned errno {}", code - 32),
        },
        Ok(code) => MacosGroupEscapeProbe {
            blocked_with_eperm: false,
            detail: format!("forbidden exec probe exited with status {code}"),
        },
        Err(error) => MacosGroupEscapeProbe {
            blocked_with_eperm: false,
            detail: format!("forbidden exec probe {error}"),
        },
    }
}

#[cfg(target_os = "macos")]
fn forked_macos_group_escape_probe(
    name: &str,
    operation: impl FnOnce() -> libc::c_int,
) -> MacosGroupEscapeProbe {
    let child = unsafe { libc::fork() };
    if child < 0 {
        return MacosGroupEscapeProbe {
            blocked_with_eperm: false,
            detail: format!("{name} probe fork failed: {}", io::Error::last_os_error()),
        };
    }
    if child == 0 {
        // Only async-signal-safe libc calls are used after fork. Exit zero exclusively when the
        // policy returned EPERM and left the child in its inherited process group.
        let original_group = unsafe { libc::getpgrp() };
        let result = operation();
        let error = if result < 0 {
            unsafe { *libc::__error() }
        } else {
            0
        };
        let group_unchanged = unsafe { libc::getpgrp() } == original_group;
        let exit_code = if result < 0 && error == libc::EPERM && group_unchanged {
            0
        } else if result >= 0 {
            1
        } else if !group_unchanged {
            2
        } else {
            32 + error.clamp(0, 200)
        };
        unsafe {
            libc::_exit(exit_code);
        }
    }

    match wait_for_macos_probe_child(child) {
        Ok(0) => MacosGroupEscapeProbe {
            blocked_with_eperm: true,
            detail: "blocked with EPERM and process group unchanged".into(),
        },
        Ok(1) => MacosGroupEscapeProbe {
            blocked_with_eperm: false,
            detail: format!("{name} unexpectedly succeeded"),
        },
        Ok(2) => MacosGroupEscapeProbe {
            blocked_with_eperm: false,
            detail: format!("{name} failed after changing the process group"),
        },
        Ok(code) if (32..=232).contains(&code) => MacosGroupEscapeProbe {
            blocked_with_eperm: false,
            detail: format!("{name} returned errno {}", code - 32),
        },
        Ok(code) => MacosGroupEscapeProbe {
            blocked_with_eperm: false,
            detail: format!("{name} probe exited with status {code}"),
        },
        Err(error) => MacosGroupEscapeProbe {
            blocked_with_eperm: false,
            detail: format!("{name} probe {error}"),
        },
    }
}

#[cfg(target_os = "macos")]
fn macos_posix_spawn_group_escape_probe() -> MacosGroupEscapeProbe {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let executable = match std::env::current_exe()
        .map_err(|error| error.to_string())
        .and_then(|path| {
            CString::new(path.as_os_str().as_bytes())
                .map_err(|_| "security probe executable contains a NUL byte".to_string())
        }) {
        Ok(executable) => executable,
        Err(error) => {
            return MacosGroupEscapeProbe {
                blocked_with_eperm: false,
                detail: error,
            };
        }
    };
    let argument = CString::new("--security-pgroup-spawn-child").unwrap();
    let mut attributes: libc::posix_spawnattr_t = std::ptr::null_mut();
    let initialized = unsafe { libc::posix_spawnattr_init(&mut attributes) };
    if initialized != 0 {
        return MacosGroupEscapeProbe {
            blocked_with_eperm: false,
            detail: format!("posix_spawnattr_init returned {initialized}"),
        };
    }

    let flags = libc::POSIX_SPAWN_SETPGROUP as libc::c_short;
    let configured = unsafe {
        let flags_result = libc::posix_spawnattr_setflags(&mut attributes, flags);
        if flags_result != 0 {
            flags_result
        } else {
            libc::posix_spawnattr_setpgroup(&mut attributes, 0)
        }
    };
    if configured != 0 {
        unsafe {
            libc::posix_spawnattr_destroy(&mut attributes);
        }
        return MacosGroupEscapeProbe {
            blocked_with_eperm: false,
            detail: format!("posix_spawn group attributes returned {configured}"),
        };
    }

    let mut child = 0;
    let mut arguments = [
        executable.as_ptr().cast_mut(),
        argument.as_ptr().cast_mut(),
        std::ptr::null_mut(),
    ];
    let spawn_result = unsafe {
        libc::posix_spawn(
            &mut child,
            executable.as_ptr(),
            std::ptr::null(),
            &attributes,
            arguments.as_mut_ptr(),
            *libc::_NSGetEnviron(),
        )
    };
    unsafe {
        libc::posix_spawnattr_destroy(&mut attributes);
    }

    if spawn_result == libc::EPERM {
        return MacosGroupEscapeProbe {
            blocked_with_eperm: true,
            detail: "blocked with EPERM".into(),
        };
    }
    if spawn_result != 0 {
        return MacosGroupEscapeProbe {
            blocked_with_eperm: false,
            detail: format!("posix_spawn returned {spawn_result}, expected EPERM"),
        };
    }

    let child_detail = match wait_for_macos_probe_child(child) {
        Ok(code) => format!("; child exit status {code}"),
        Err(error) => format!("; child {error}"),
    };
    MacosGroupEscapeProbe {
        blocked_with_eperm: false,
        detail: format!("posix_spawn unexpectedly created process {child}{child_detail}"),
    }
}

#[cfg(target_os = "macos")]
fn wait_for_macos_probe_child(child: libc::pid_t) -> Result<i32, String> {
    loop {
        let mut status = 0;
        let waited = unsafe { libc::waitpid(child, &mut status, 0) };
        if waited == child {
            if libc::WIFEXITED(status) {
                return Ok(libc::WEXITSTATUS(status));
            }
            return Err(format!("terminated with wait status {status}"));
        }
        if waited < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(format!("waitpid failed: {error}"));
        }
    }
}
