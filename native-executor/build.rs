use std::env;
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant};

type BuildResult<T> = Result<T, Box<dyn std::error::Error>>;

const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_IDENTITY_BYTES: usize = 64 * 1024 * 1024;
const MAX_SOURCE_ENTRIES: usize = 4096;
const MAX_OUTPUT_BYTES: u64 = 4096;
const TOOL_TIMEOUT: Duration = Duration::from_secs(30);

fn main() -> BuildResult<()> {
    let manifest_dir =
        PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").ok_or("missing manifest directory")?);
    let repository_dir = manifest_dir
        .parent()
        .ok_or("missing repository directory")?;
    let source_dir = manifest_dir.join("src");
    let mut source_files = Vec::new();
    let mut source_entries = 0;
    collect_sources(&source_dir, 0, &mut source_entries, &mut source_files)?;
    source_files.sort();

    let mut identity = Vec::new();
    append_file(
        &mut identity,
        "../shared/linux_sandbox_paths.rs",
        &repository_dir.join("shared/linux_sandbox_paths.rs"),
    )?;
    append_entry(&mut identity, "format", b"judgedesk-native-build-v1")?;
    for path in source_files {
        let relative = path
            .strip_prefix(&manifest_dir)?
            .to_str()
            .ok_or("non-UTF-8 source path")?
            .replace('\\', "/");
        append_file(&mut identity, &relative, &path)?;
    }
    for name in ["Cargo.toml", "Cargo.lock", "build.rs"] {
        append_file(&mut identity, name, &manifest_dir.join(name))?;
    }
    append_file(
        &mut identity,
        "../rust-toolchain.toml",
        &repository_dir.join("rust-toolchain.toml"),
    )?;

    for variable in ["CARGO_CFG_TARGET_OS", "CARGO_CFG_TARGET_ARCH"] {
        println!("cargo:rerun-if-env-changed={variable}");
        let value = env::var(variable)?;
        if value.is_empty()
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        {
            return Err(format!("invalid compiler target value: {variable}").into());
        }
        append_entry(&mut identity, variable, value.as_bytes())?;
    }
    // Cargo compiles the build script with the crate's selected features. An
    // inherited CARGO_FEATURE_* variable cannot change this compiler decision.
    append_entry(
        &mut identity,
        "feature:executor",
        if cfg!(feature = "executor") {
            b"1"
        } else {
            b"0"
        },
    )?;

    println!("cargo:rerun-if-env-changed=RUSTC");
    let rustc = env::var_os("RUSTC").ok_or("missing compiler selected by Cargo")?;
    let mut compiler = Command::new(rustc);
    compiler.arg("--version").current_dir(&manifest_dir);
    let compiler_version = run_tool(compiler, None)?;
    let version = std::str::from_utf8(&compiler_version)?.trim();
    if !version.starts_with("rustc ") || version.contains(['\r', '\n']) {
        return Err("invalid selected compiler version output".into());
    }
    append_entry(&mut identity, "rustc --version", version.as_bytes())?;

    let fingerprint = sha256(identity)?;
    println!("cargo:rustc-env=JUDGEDESK_NATIVE_BUILD_FINGERPRINT={fingerprint}");
    Ok(())
}

fn collect_sources(
    directory: &Path,
    depth: usize,
    entries: &mut usize,
    sources: &mut Vec<PathBuf>,
) -> BuildResult<()> {
    let metadata = fs::symlink_metadata(directory)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() || depth > 64 {
        return Err("native source directory must be a bounded regular directory".into());
    }
    watch_input(directory)?;
    for entry in fs::read_dir(directory)? {
        *entries += 1;
        if *entries > MAX_SOURCE_ENTRIES {
            return Err("native source tree exceeds entry limit".into());
        }
        let path = entry?.path();
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.file_type().is_symlink() {
            return Err(format!("native source must not be a symlink: {}", path.display()).into());
        }
        if metadata.is_dir() {
            collect_sources(&path, depth + 1, entries, sources)?;
        } else if !metadata.is_file() {
            return Err(format!("native source must be a regular file: {}", path.display()).into());
        } else if path.extension().is_some_and(|extension| extension == "rs") {
            sources.push(path);
        }
    }
    Ok(())
}

fn append_file(identity: &mut Vec<u8>, name: &str, path: &Path) -> BuildResult<()> {
    if name.contains(['\r', '\n']) {
        return Err("native source path contains a line break".into());
    }
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > MAX_FILE_BYTES {
        return Err(format!(
            "native identity input must be a bounded regular file: {}",
            path.display()
        )
        .into());
    }
    let mut bytes = Vec::new();
    File::open(path)?
        .take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err("native identity input exceeds file limit".into());
    }
    watch_input(path)?;
    append_entry(identity, name, &bytes)
}

fn watch_input(path: &Path) -> BuildResult<()> {
    let path = path
        .to_str()
        .ok_or("non-UTF-8 native identity input path")?;
    if path.contains(['\r', '\n']) {
        return Err("native identity input path contains a line break".into());
    }
    println!("cargo:rerun-if-changed={path}");
    Ok(())
}

fn append_entry(identity: &mut Vec<u8>, name: &str, bytes: &[u8]) -> BuildResult<()> {
    let entry_size = 16usize
        .checked_add(name.len())
        .and_then(|size| size.checked_add(bytes.len()))
        .ok_or("native identity size overflow")?;
    if identity
        .len()
        .checked_add(entry_size)
        .is_none_or(|size| size > MAX_IDENTITY_BYTES)
    {
        return Err("native identity exceeds total input limit".into());
    }
    // Length prefixes bind both names and raw bytes without delimiter ambiguity.
    identity.extend_from_slice(&(name.len() as u64).to_le_bytes());
    identity.extend_from_slice(name.as_bytes());
    identity.extend_from_slice(&(bytes.len() as u64).to_le_bytes());
    identity.extend_from_slice(bytes);
    Ok(())
}

fn sha256(bytes: Vec<u8>) -> BuildResult<String> {
    let mut command = hash_command()?;
    command.env_clear();
    #[cfg(windows)]
    command.env(
        "SystemRoot",
        env::var_os("SystemRoot").ok_or("missing Windows system directory")?,
    );
    let output = run_tool(command, Some(bytes))?;
    let output = std::str::from_utf8(&output)?;
    let mut fields = output.split_whitespace();
    let digest = fields.next().ok_or("missing SHA-256 digest")?;
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("system hashing tool returned an invalid SHA-256 digest".into());
    }
    if fields.next().is_some_and(|name| name != "-") || fields.next().is_some() {
        return Err("system hashing tool returned unexpected output".into());
    }
    Ok(digest.to_owned())
}

fn hash_command() -> BuildResult<Command> {
    #[cfg(windows)]
    let path = {
        println!("cargo:rerun-if-env-changed=SystemRoot");
        let root =
            PathBuf::from(env::var_os("SystemRoot").ok_or("missing Windows system directory")?);
        if !root.is_absolute() {
            return Err("Windows system directory must be absolute".into());
        }
        root.join("System32/WindowsPowerShell/v1.0/powershell.exe")
    };
    #[cfg(target_os = "macos")]
    let path = PathBuf::from("/usr/bin/shasum");
    #[cfg(all(unix, not(target_os = "macos")))]
    let path = PathBuf::from("/usr/bin/sha256sum");
    #[cfg(not(any(windows, unix)))]
    return Err("no verified SHA-256 tool for this build host".into());

    let metadata = fs::symlink_metadata(&path)?;
    if !path.is_absolute() || metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("system SHA-256 tool must be an absolute regular executable".into());
    }
    let command = Command::new(path);
    #[cfg(any(windows, target_os = "macos"))]
    let mut command = command;
    #[cfg(windows)]
    command.args([
        "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
        "$ErrorActionPreference = 'Stop'; $inputStream = [Console]::OpenStandardInput(); $algorithm = [System.Security.Cryptography.SHA256]::Create(); try { [Console]::WriteLine([BitConverter]::ToString($algorithm.ComputeHash($inputStream)).Replace('-', '').ToLowerInvariant()) } finally { $algorithm.Dispose(); $inputStream.Dispose() }",
    ]);
    #[cfg(target_os = "macos")]
    command.args(["-a", "256"]);
    Ok(command)
}

fn run_tool(mut command: Command, input: Option<Vec<u8>>) -> BuildResult<Vec<u8>> {
    command
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = command.spawn()?;
    let stdout = child
        .stdout
        .take()
        .ok_or("missing system tool output pipe")?;
    let reader = thread::spawn(move || -> io::Result<Vec<u8>> {
        let mut output = Vec::new();
        stdout.take(MAX_OUTPUT_BYTES + 1).read_to_end(&mut output)?;
        Ok(output)
    });
    let writer = input.map(|bytes| {
        let stdin = child.stdin.take();
        thread::spawn(move || -> io::Result<()> {
            stdin
                .ok_or_else(|| io::Error::other("missing system tool input pipe"))?
                .write_all(&bytes)
        })
    });
    let deadline = Instant::now() + TOOL_TIMEOUT;
    let status: BuildResult<ExitStatus> = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
            Ok(None) => break Err("system identity tool timed out".into()),
            Err(error) => break Err(error.into()),
        }
    };
    if status.is_err() {
        child.kill()?;
        child.wait()?;
    }
    let output = reader
        .join()
        .map_err(|_| "system tool output reader failed")??;
    let written = writer.map(|writer| writer.join().map_err(|_| "system tool input writer failed"));
    let status = status?;
    if !status.success() {
        return Err(format!("system identity tool failed: {status}").into());
    }
    if let Some(written) = written {
        written??;
    }
    if output.len() as u64 > MAX_OUTPUT_BYTES {
        return Err("system identity tool exceeds output limit".into());
    }
    Ok(output)
}
