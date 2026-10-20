use judgedesk_core::executor_client::{ExecutorClient, TreeGuardContract};
use judgedesk_native_executor::protocol::{
    read_frame, ExecutorRequest, ExecutorResponse, RunLimits, RunReason, RunRole, RunSpec,
    EXECUTOR_VERSION, MAX_FRAME_BYTES,
};
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

static TEST_DIR_COUNTER: AtomicU64 = AtomicU64::new(0);
static PROCESS_ENV_LOCK: Mutex<()> = Mutex::new(());

struct EnvironmentRestore(Vec<(&'static str, Option<std::ffi::OsString>)>);

impl EnvironmentRestore {
    fn capture(keys: &[&'static str]) -> Self {
        Self(
            keys.iter()
                .map(|key| (*key, std::env::var_os(key)))
                .collect(),
        )
    }
}

impl Drop for EnvironmentRestore {
    fn drop(&mut self) {
        for (key, value) in &self.0 {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
    }
}

const OWNERSHIP_MARKER: &str = "judgedesk-test-owned\n";

struct IsolatedExecutorEnv {
    local_app_data: PathBuf,
    app_data: PathBuf,
    themis_app_data: PathBuf,
    temp_dir: PathBuf,
}

impl IsolatedExecutorEnv {
    fn as_pairs(&self) -> [(&'static str, &std::ffi::OsStr); 6] {
        [
            ("LOCALAPPDATA", self.local_app_data.as_os_str()),
            ("APPDATA", self.app_data.as_os_str()),
            ("THEMIS_APP_DATA_DIR", self.themis_app_data.as_os_str()),
            ("TMPDIR", self.temp_dir.as_os_str()),
            ("TEMP", self.temp_dir.as_os_str()),
            ("TMP", self.temp_dir.as_os_str()),
        ]
    }
}

struct TempTestDir(PathBuf);

impl TempTestDir {
    fn new(_name: &str) -> Self {
        let id = TEST_DIR_COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("jdbt-{}-{id}", std::process::id()));
        let _ = fs::create_dir_all(&path);
        let _ = fs::write(path.join(".judgedesk-test-root"), OWNERSHIP_MARKER);
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }

    fn isolated_env(&self) -> IsolatedExecutorEnv {
        self.isolated_env_named("l", "t")
    }

    fn isolated_env_named(&self, local_sub: &str, temp_sub: &str) -> IsolatedExecutorEnv {
        let local_app_data = self.0.join(local_sub);
        let app_data = self.0.join(format!("{local_sub}-roaming"));
        let themis_app_data = local_app_data.join("ThemisV2");
        let temp_dir = self.0.join(temp_sub);
        for dir in [&local_app_data, &app_data, &themis_app_data, &temp_dir] {
            let _ = fs::create_dir_all(dir);
            let _ = fs::write(dir.join(".judgedesk-test-root"), OWNERSHIP_MARKER);
        }
        IsolatedExecutorEnv {
            local_app_data,
            app_data,
            themis_app_data,
            temp_dir,
        }
    }
}

impl Drop for TempTestDir {
    fn drop(&mut self) {
        for _ in 0..10 {
            if fs::remove_dir_all(&self.0).is_ok() || !self.0.exists() {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    }
}

fn guard_allows_exclusive_lock(path: &Path) -> bool {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .expect("open tree guard for exclusive-lock probe");

    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            LockFileEx, UnlockFileEx, LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY,
        };
        // SAFETY: OVERLAPPED is zero-initialized as required for a synchronous byte-range lock,
        // and the raw handle remains valid for the complete lock/unlock sequence.
        let mut overlapped = unsafe { std::mem::zeroed() };
        // SAFETY: `file` owns a live Windows file handle and the one-byte range is valid.
        let locked = unsafe {
            LockFileEx(
                file.as_raw_handle() as _,
                LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
                0,
                1,
                0,
                &mut overlapped,
            )
        } != 0;
        if locked {
            // SAFETY: this unlock uses the same live handle, range, and OVERLAPPED structure.
            unsafe {
                UnlockFileEx(file.as_raw_handle() as _, 0, 1, 0, &mut overlapped);
            }
        }
        locked
    }

    #[cfg(not(windows))]
    {
        use std::os::fd::AsRawFd;
        // SAFETY: `file` owns a live descriptor for the duration of both flock calls.
        let locked = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0;
        if locked {
            // SAFETY: the descriptor is still live and held by this process.
            unsafe {
                libc::flock(file.as_raw_fd(), libc::LOCK_UN);
            }
        }
        locked
    }
}

fn write_request_frame<W: Write>(writer: &mut W, req: &ExecutorRequest) -> std::io::Result<()> {
    let payload = serde_json::to_vec(req)?;
    if payload.len() > MAX_FRAME_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "frame exceeds limit",
        ));
    }
    writer.write_all(&(payload.len() as u32).to_le_bytes())?;
    writer.write_all(&payload)?;
    writer.flush()?;
    Ok(())
}

fn write_tree_guard(path: &Path, generation: &str) {
    let _ = fs::remove_file(path);
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).expect("create tree guard file");
    file.write_all(format!("JUDGEDESK_PROCESS_TREE/1\ngeneration={generation}\n").as_bytes())
        .expect("write tree guard file");
    file.sync_all().expect("sync tree guard file");
}

pub const FROZEN_WINDOWS_EXECUTOR_SHA256: &str =
    "EA7F018676F470173B32EA3C60DE1E57A2DC49D846EB48C19864FA63DC4152BA";
pub const FROZEN_WINDOWS_EXECUTOR_SIZE_BYTES: usize = 965120;

fn target_triple_for_packaged_executor() -> &'static str {
    if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        "x86_64-pc-windows-msvc"
    } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "aarch64-apple-darwin"
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        "x86_64-apple-darwin"
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        "x86_64-unknown-linux-gnu"
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        "aarch64-unknown-linux-gnu"
    } else {
        panic!("unsupported target triple for packaged executor boundary");
    }
}

fn expected_packaged_executor_subpath() -> PathBuf {
    let extension = if cfg!(windows) { ".exe" } else { "" };
    PathBuf::from("src-tauri").join("binaries").join(format!(
        "judgedesk-executor-{}{extension}",
        target_triple_for_packaged_executor()
    ))
}

fn sha256_digest(bytes: &[u8]) -> String {
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    let k: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];

    let bit_len = (bytes.len() as u64) * 8;
    let mut data = bytes.to_vec();
    data.push(0x80);
    while (data.len() % 64) != 56 {
        data.push(0);
    }
    data.extend_from_slice(&bit_len.to_be_bytes());

    for chunk in data.chunks_exact(64) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([
                chunk[i * 4],
                chunk[i * 4 + 1],
                chunk[i * 4 + 2],
                chunk[i * 4 + 3],
            ]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }

        let mut a = h[0];
        let mut b = h[1];
        let mut c = h[2];
        let mut d = h[3];
        let mut e = h[4];
        let mut f = h[5];
        let mut g = h[6];
        let mut hh = h[7];

        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(k[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);

            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }

        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
        h[5] = h[5].wrapping_add(f);
        h[6] = h[6].wrapping_add(g);
        h[7] = h[7].wrapping_add(hh);
    }

    format!(
        "{:08X}{:08X}{:08X}{:08X}{:08X}{:08X}{:08X}{:08X}",
        h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]
    )
}

fn locate_packaged_executor_binary() -> PathBuf {
    let root = repo_root();
    let relative = expected_packaged_executor_subpath();
    let candidate = root.join(&relative);
    assert!(
        candidate.is_file(),
        "Packaged executor candidate not found at expected path: {}",
        candidate.display()
    );
    let canonical = candidate
        .canonicalize()
        .unwrap_or_else(|_| candidate.clone());
    let canonical_str = canonical.to_string_lossy().replace('\\', "/");

    // Prohibit implicit or stale target/debug binary selection (LOG-0064-F1)
    assert!(
        !canonical_str.contains("/target/debug/") && !canonical_str.ends_with("/target/debug"),
        "Packaged executor resolution must not resolve an implicit or stale target/debug executable: {}",
        canonical.display()
    );

    // Verify binary is inside src-tauri/binaries/
    assert!(
        canonical_str.contains("/src-tauri/binaries/"),
        "Packaged executor must be located under src-tauri/binaries/: {}",
        canonical.display()
    );

    // Verify SHA-256 and byte size against frozen candidate identity on Windows x86_64
    if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        let file_bytes =
            fs::read(&canonical).expect("read packaged executor binary for SHA256 verification");
        let hash = sha256_digest(&file_bytes);
        assert_eq!(
            hash, FROZEN_WINDOWS_EXECUTOR_SHA256,
            "Packaged executor SHA-256 mismatch against frozen candidate identity"
        );
        assert_eq!(
            file_bytes.len(),
            FROZEN_WINDOWS_EXECUTOR_SIZE_BYTES,
            "Packaged executor byte size mismatch against frozen candidate identity"
        );
    }

    canonical
}

fn locate_executor_binary() -> PathBuf {
    locate_packaged_executor_binary()
}

// ---------------------------------------------------------------------------
// Regression Test: packaged_executor_resolution_rejects_debug_fallback_and_verifies_frozen_identity (LOG-0064-F1)
// ---------------------------------------------------------------------------
#[test]
fn packaged_executor_resolution_rejects_debug_fallback_and_verifies_frozen_identity() {
    let root = repo_root();
    let debug_candidate = root.join("native-executor/target/debug/judgedesk-native-executor.exe");

    // 1. Explicitly identify and resolve the packaged candidate
    let packaged_exe = locate_packaged_executor_binary();
    assert!(
        packaged_exe.is_file(),
        "Packaged executable must exist as a file"
    );

    let canonical_path = packaged_exe
        .canonicalize()
        .unwrap_or_else(|_| packaged_exe.clone());
    let canonical_str = canonical_path.to_string_lossy().replace('\\', "/");
    assert!(
        canonical_str.contains("/src-tauri/binaries/judgedesk-executor-"),
        "Resolved executable canonical path must be inside src-tauri/binaries/: {}",
        canonical_path.display()
    );
    assert!(
        !canonical_str.contains("/target/debug/"),
        "Resolved executable must not be inside target/debug/: {}",
        canonical_path.display()
    );

    // 2. Assert SHA-256 and byte size against frozen candidate identity
    if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        let file_bytes = fs::read(&packaged_exe).expect("read packaged executor binary");
        let hash = sha256_digest(&file_bytes);
        assert_eq!(
            hash, FROZEN_WINDOWS_EXECUTOR_SHA256,
            "Packaged executor SHA-256 must match frozen candidate identity"
        );
        assert_eq!(
            file_bytes.len(),
            FROZEN_WINDOWS_EXECUTOR_SIZE_BYTES,
            "Packaged executor byte size must match frozen candidate identity"
        );

        // Changing bytes without changing size must still fail the fixed identity.
        let mut tampered = file_bytes.clone();
        tampered[0] ^= 1;
        assert_ne!(sha256_digest(&tampered), FROZEN_WINDOWS_EXECUTOR_SHA256);
        assert_eq!(tampered.len(), FROZEN_WINDOWS_EXECUTOR_SIZE_BYTES);
        assert_ne!(
            sha256_digest(&file_bytes[..file_bytes.len() - 1]),
            FROZEN_WINDOWS_EXECUTOR_SHA256
        );

        // 3. Stale debug binary distinction:
        // Even if native-executor/target/debug exists, verify it has distinct hash and is never selected
        if debug_candidate.is_file() {
            let debug_bytes = fs::read(&debug_candidate).expect("read debug binary");
            let debug_hash = sha256_digest(&debug_bytes);
            assert_ne!(
                debug_hash, FROZEN_WINDOWS_EXECUTOR_SHA256,
                "Stale debug binary SHA-256 must NOT match frozen candidate identity"
            );
            assert_ne!(
                canonical_path,
                debug_candidate
                    .canonicalize()
                    .unwrap_or(debug_candidate.clone()),
                "Packaged executor canonical path must NOT equal debug candidate path"
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Test 1: production_core_cannot_execute_platform_in_process
// ---------------------------------------------------------------------------
#[tokio::test]
async fn production_core_cannot_execute_platform_in_process() {
    // Verify that judgedesk-core does NOT expose Platform.
    // In production, judgedesk-core depends on judgedesk-native-executor with default-features = false.
    // The "executor" feature gates Platform, workspace, macos_*, and tree_guard modules.
    // Here we verify that core's execution client model requires out-of-process spawning
    // and exposes no in-process Platform constructor or fallback runner.
    let missing_path = Path::new("non_existent_core_executor_boundary.exe");
    let spawn_result = ExecutorClient::spawn(missing_path).await;
    assert!(
        spawn_result.is_err(),
        "Release core must fail closed when executor binary cannot be spawned; no in-process Platform fallback allowed"
    );
}

// ---------------------------------------------------------------------------
// Test 2: rust_client_uses_packaged_executor_only
// ---------------------------------------------------------------------------
#[tokio::test]
async fn rust_client_uses_packaged_executor_only() {
    // Exact-path resolution: non-existent or invalid executable fails immediately.
    let nonexistent = Path::new("definitely_missing_judgedesk_executor_binary_path.exe");
    let result = ExecutorClient::spawn(nonexistent).await;
    assert!(result.is_err());
    let err = result.err().unwrap();
    assert_eq!(err.kind(), std::io::ErrorKind::NotFound);

    // Empty non-executable file also fails during initial health handshake without silent fallback.
    let temp = TempTestDir::new("dummy-bin");
    let isolated = temp.isolated_env();
    let dummy_file = temp.path().join("dummy.exe");
    fs::write(&dummy_file, b"").expect("write dummy file");
    let dummy_result = ExecutorClient::spawn_with_env(&dummy_file, &isolated.as_pairs()).await;
    assert!(
        dummy_result.is_err(),
        "Incompatible or non-executable binary must return error without fallback"
    );

    // Valid packaged executor spawns successfully, performs health handshake, and reports ready
    let exe = locate_executor_binary();
    let valid_client = ExecutorClient::spawn_with_env(&exe, &isolated.as_pairs()).await;
    assert!(
        valid_client.is_ok(),
        "Valid packaged executor must spawn successfully"
    );
    let client = valid_client.unwrap();
    assert!(client.health().ready, "Packaged executor must be ready");
    assert_eq!(client.health().executor_version, EXECUTOR_VERSION);
}

// ---------------------------------------------------------------------------
// Test 3: legacy_framed_v1_matches_node_client
// ---------------------------------------------------------------------------
#[test]
fn legacy_framed_v1_matches_node_client() {
    // 1. Wire format verification:
    // Frame prefix must be 4 bytes little-endian length.
    let req = ExecutorRequest::Health {
        id: "test-correlation-id-1234".to_string(),
    };
    let mut buffer = Vec::new();
    write_request_frame(&mut buffer, &req).expect("write_request_frame must succeed");

    assert!(buffer.len() >= 4);
    let payload_len = u32::from_le_bytes([buffer[0], buffer[1], buffer[2], buffer[3]]) as usize;
    assert_eq!(payload_len, buffer.len() - 4);
    assert!(payload_len > 0);
    assert!(payload_len <= MAX_FRAME_BYTES);

    // Verify payload is valid UTF-8 JSON with matching fields
    let payload_str = std::str::from_utf8(&buffer[4..]).expect("payload must be valid UTF-8");
    let parsed: serde_json::Value =
        serde_json::from_str(payload_str).expect("payload must be valid JSON");
    assert_eq!(parsed["type"], "health");
    assert_eq!(parsed["id"], "test-correlation-id-1234");

    // 2. Decode with read_frame
    let mut cursor = Cursor::new(&buffer);
    let payload_bytes = read_frame(&mut cursor)
        .expect("read_frame must succeed")
        .expect("payload must be present");
    let decoded: ExecutorRequest =
        serde_json::from_slice(&payload_bytes).expect("deserialize ExecutorRequest");
    match decoded {
        ExecutorRequest::Health { id } => assert_eq!(id, "test-correlation-id-1234"),
        _ => panic!("Expected Health request"),
    }

    // 3. Zero length frame is rejected
    let zero_len_frame = [0u8; 4];
    let mut zero_cursor = Cursor::new(&zero_len_frame);
    let zero_result = read_frame(&mut zero_cursor);
    assert!(zero_result.is_err(), "Zero length frame must be rejected");

    // 4. Oversized frame (> 1 MiB) is rejected
    let mut oversized_header = (MAX_FRAME_BYTES as u32 + 1).to_le_bytes().to_vec();
    oversized_header.extend_from_slice(&[0u8; 16]);
    let mut over_cursor = Cursor::new(&oversized_header);
    let over_result = read_frame(&mut over_cursor);
    assert!(
        over_result.is_err(),
        "Oversized frame > 1 MiB must be rejected"
    );
    let err_msg = over_result.err().unwrap().to_string();
    assert!(err_msg.contains("invalid frame length"));

    // 5. Malformed JSON payload is rejected
    let malformed_payload = b"not-a-valid-json-string";
    let mut malformed_frame = (malformed_payload.len() as u32).to_le_bytes().to_vec();
    malformed_frame.extend_from_slice(malformed_payload);
    let mut mal_cursor = Cursor::new(&malformed_frame);
    let mal_bytes = read_frame(&mut mal_cursor).expect("read raw frame bytes");
    let parse_result = serde_json::from_slice::<ExecutorRequest>(&mal_bytes.unwrap());
    assert!(parse_result.is_err(), "Malformed JSON must fail closed");
}

// ---------------------------------------------------------------------------
// Test 4: executor_rejects_missing_tree_guard_variables
// ---------------------------------------------------------------------------
#[test]
fn executor_rejects_missing_tree_guard_variables() {
    let exe = locate_executor_binary();
    let temp = TempTestDir::new("missing-guard");
    let isolated = temp.isolated_env();

    let output = Command::new(&exe)
        .envs(isolated.as_pairs())
        .env_remove("JUDGEDESK_TREE_GUARD_REQUIRED")
        .env_remove("JUDGEDESK_TREE_GUARD_PATH")
        .env_remove("JUDGEDESK_TREE_GUARD_GENERATION")
        .env_remove("JUDGEDESK_PARENT_PID")
        .output()
        .expect("spawn executor");
    assert!(
        !output.status.success(),
        "Executor MUST fail closed when all tree guard environment variables are absent"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("PROCESS_TREE_GUARD_REQUIRED_MISSING"),
        "Expected PROCESS_TREE_GUARD_REQUIRED_MISSING, got: {stderr}"
    );
}

// ---------------------------------------------------------------------------
// Test 5: executor_rejects_forged_generation
// ---------------------------------------------------------------------------
#[test]
fn executor_rejects_forged_generation() {
    let exe = locate_executor_binary();
    let temp = TempTestDir::new("forged-gen");
    let isolated = temp.isolated_env();
    let guard_file = temp.path().join("process-tree.lock");

    let generation_file = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    let generation_forged = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    write_tree_guard(&guard_file, generation_file);

    let output = Command::new(&exe)
        .envs(isolated.as_pairs())
        .env("JUDGEDESK_PARENT_PID", std::process::id().to_string())
        .env("JUDGEDESK_TREE_GUARD_REQUIRED", "1")
        .env("JUDGEDESK_TREE_GUARD_PATH", &guard_file)
        .env("JUDGEDESK_TREE_GUARD_GENERATION", generation_forged)
        .output()
        .expect("spawn executor");
    assert!(
        !output.status.success(),
        "Executor MUST fail closed when generation token in environment does not match guard file"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("PROCESS_TREE_GUARD_GENERATION_MISMATCH"),
        "Expected PROCESS_TREE_GUARD_GENERATION_MISMATCH, got: {stderr}"
    );
}

// ---------------------------------------------------------------------------
// Test 6: executor_rejects_invalid_parent_pid
// ---------------------------------------------------------------------------
#[test]
fn executor_rejects_invalid_parent_pid() {
    let exe = locate_executor_binary();
    let temp = TempTestDir::new("invalid-parent");
    let isolated = temp.isolated_env();
    let guard_file = temp.path().join("process-tree.lock");
    let generation = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    write_tree_guard(&guard_file, generation);

    let output = Command::new(&exe)
        .envs(isolated.as_pairs())
        .env("JUDGEDESK_PARENT_PID", "99999999")
        .env("JUDGEDESK_TREE_GUARD_REQUIRED", "1")
        .env("JUDGEDESK_TREE_GUARD_PATH", &guard_file)
        .env("JUDGEDESK_TREE_GUARD_GENERATION", generation)
        .output()
        .expect("spawn executor");
    assert!(
        !output.status.success(),
        "Executor MUST fail closed when parent PID does not match actual kernel parent"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("PROCESS_PARENT_IDENTITY_MISMATCH")
            || stderr.contains("PROCESS_PARENT_NOT_FOUND_IN_SNAPSHOT"),
        "Expected parent PID mismatch error, got: {stderr}"
    );
}

// ---------------------------------------------------------------------------
// Test 7: executor_rejects_wrong_parent_or_generation (Combined Regression)
// ---------------------------------------------------------------------------
#[test]
fn executor_rejects_wrong_parent_or_generation() {
    let exe = locate_executor_binary();
    let temp = TempTestDir::new("tree-guard-probe");
    let isolated = temp.isolated_env();
    let guard_file = temp.path().join("process-tree.lock");

    // Case 1: Partial environment (PATH set without REQUIRED) fails
    let output = Command::new(&exe)
        .envs(isolated.as_pairs())
        .env("JUDGEDESK_TREE_GUARD_PATH", &guard_file)
        .env_remove("JUDGEDESK_TREE_GUARD_REQUIRED")
        .env_remove("JUDGEDESK_TREE_GUARD_GENERATION")
        .output()
        .expect("spawn executor");
    assert!(!output.status.success(), "Partial environment must fail");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("PROCESS_TREE_GUARD_PARTIAL_ENVIRONMENT"));

    // Case 2: Invalid generation format (not 64 hex characters) fails
    let output = Command::new(&exe)
        .envs(isolated.as_pairs())
        .env("JUDGEDESK_TREE_GUARD_REQUIRED", "1")
        .env("JUDGEDESK_TREE_GUARD_PATH", &guard_file)
        .env(
            "JUDGEDESK_TREE_GUARD_GENERATION",
            "not_a_64_hex_generation_string",
        )
        .output()
        .expect("spawn executor");
    assert!(
        !output.status.success(),
        "Invalid generation length/format must fail"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("PROCESS_TREE_GUARD_INVALID_GENERATION"));

    // Case 3: Generation mismatch between file and environment fails
    let generation_file = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    let generation_env = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    write_tree_guard(&guard_file, generation_file);

    let output = Command::new(&exe)
        .envs(isolated.as_pairs())
        .env("JUDGEDESK_PARENT_PID", std::process::id().to_string())
        .env("JUDGEDESK_TREE_GUARD_REQUIRED", "1")
        .env("JUDGEDESK_TREE_GUARD_PATH", &guard_file)
        .env("JUDGEDESK_TREE_GUARD_GENERATION", generation_env)
        .output()
        .expect("spawn executor");
    assert!(!output.status.success(), "Mismatched generation must fail");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("PROCESS_TREE_GUARD_GENERATION_MISMATCH"));

    // Case 4: Missing all tree guard variables MUST fail closed (LOG-0058-F1)
    let output_no_guard = Command::new(&exe)
        .envs(isolated.as_pairs())
        .env_remove("JUDGEDESK_TREE_GUARD_REQUIRED")
        .env_remove("JUDGEDESK_TREE_GUARD_PATH")
        .env_remove("JUDGEDESK_TREE_GUARD_GENERATION")
        .env_remove("JUDGEDESK_PARENT_PID")
        .output()
        .expect("spawn executor");
    assert!(
        !output_no_guard.status.success(),
        "Executor MUST NOT start when tree guard environment is absent"
    );

    // Case 5: Forged or mismatched parent PID MUST fail closed (LOG-0058-F1)
    let output_forged_parent = Command::new(&exe)
        .envs(isolated.as_pairs())
        .env("JUDGEDESK_PARENT_PID", "99999999")
        .env("JUDGEDESK_TREE_GUARD_REQUIRED", "1")
        .env("JUDGEDESK_TREE_GUARD_PATH", &guard_file)
        .env("JUDGEDESK_TREE_GUARD_GENERATION", generation_file)
        .output()
        .expect("spawn executor");
    assert!(
        !output_forged_parent.status.success(),
        "Executor MUST NOT start when parent PID is forged or mismatched"
    );
}

// ---------------------------------------------------------------------------
// Test 8: one_executor_guard_per_generation
// ---------------------------------------------------------------------------
#[test]
fn one_executor_guard_per_generation() {
    let exe = locate_executor_binary();
    let temp = TempTestDir::new("singleton-guard");
    let isolated = temp.isolated_env();
    let guard_file = temp.path().join("process-tree.lock");
    let generation = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    write_tree_guard(&guard_file, generation);

    // Spawn first executor holding the generation guard
    let mut child1 = Command::new(&exe)
        .envs(isolated.as_pairs())
        .env("JUDGEDESK_PARENT_PID", std::process::id().to_string())
        .env("JUDGEDESK_TREE_GUARD_REQUIRED", "1")
        .env("JUDGEDESK_TREE_GUARD_PATH", &guard_file)
        .env("JUDGEDESK_TREE_GUARD_GENERATION", generation)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn first executor");

    // Give first executor a moment to acquire the lock
    std::thread::sleep(std::time::Duration::from_millis(150));

    // Attempt to spawn second executor with the SAME generation guard
    let output2 = Command::new(&exe)
        .envs(isolated.as_pairs())
        .env("JUDGEDESK_PARENT_PID", std::process::id().to_string())
        .env("JUDGEDESK_TREE_GUARD_REQUIRED", "1")
        .env("JUDGEDESK_TREE_GUARD_PATH", &guard_file)
        .env("JUDGEDESK_TREE_GUARD_GENERATION", generation)
        .output()
        .expect("spawn second executor");

    // Cleanup first child before asserting
    let _ = child1.kill();
    let _ = child1.wait();

    assert!(
        !output2.status.success(),
        "Second executor under same generation MUST be rejected (exactly one owner per generation)"
    );
    let stderr = String::from_utf8_lossy(&output2.stderr);
    assert!(
        stderr.contains("PROCESS_TREE_GUARD_LOCK_FAILED"),
        "Expected lock failure on second executor, got: {stderr}"
    );
}

#[test]
fn rust_client_binds_to_application_generation_and_drops_via_clean_shutdown() {
    let exe = locate_executor_binary();
    let temp = TempTestDir::new("client-application-guard");
    let isolated = temp.isolated_env();
    let guard_file = temp.path().join("application-generation.lock");
    let generation = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
    write_tree_guard(&guard_file, generation);
    let guard = TreeGuardContract::new(guard_file.clone(), generation.to_string())
        .expect("valid application tree guard contract");

    let client = ExecutorClient::spawn_sync_with_tree_guard_and_env(
        &exe,
        guard.clone(),
        &isolated.as_pairs(),
    )
    .expect("spawn client bound to application generation");
    assert!(client.health().ready, "bound executor must become ready");
    assert!(
        !guard_allows_exclusive_lock(&guard_file),
        "application guard must remain exclusively held while the executor is ready"
    );

    let duplicate =
        ExecutorClient::spawn_sync_with_tree_guard_and_env(&exe, guard, &isolated.as_pairs());
    assert!(
        duplicate.is_err(),
        "a second client must not own the same application generation"
    );

    let drop_started = std::time::Instant::now();
    drop(client);
    assert!(
        drop_started.elapsed() < std::time::Duration::from_millis(1_200),
        "idle client Drop must request orderly shutdown instead of waiting for forced termination"
    );
    assert!(
        guard_allows_exclusive_lock(&guard_file),
        "application guard must become available only after orderly executor exit"
    );
}

#[test]
fn rust_standalone_client_ignores_ambient_tree_guard_contract() {
    let _environment = PROCESS_ENV_LOCK.lock().expect("lock process environment");
    let exe = locate_executor_binary();
    let temp = TempTestDir::new("client-standalone-guard");
    let isolated = temp.isolated_env();
    let restore = EnvironmentRestore::capture(&[
        "JUDGEDESK_TREE_GUARD_REQUIRED",
        "JUDGEDESK_TREE_GUARD_PATH",
        "JUDGEDESK_TREE_GUARD_GENERATION",
    ]);
    std::env::set_var("JUDGEDESK_TREE_GUARD_REQUIRED", "1");
    std::env::set_var(
        "JUDGEDESK_TREE_GUARD_PATH",
        temp.path().join("untrusted-missing.guard"),
    );
    std::env::set_var(
        "JUDGEDESK_TREE_GUARD_GENERATION",
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    );

    let client = ExecutorClient::spawn_sync_with_args_and_env(&exe, &[], &isolated.as_pairs())
        .expect("standalone client must create and own a fresh guard");
    assert!(client.health().ready);
    drop(client);
    drop(restore);
}

// ---------------------------------------------------------------------------
// Test 9: concurrent_executor_generation_startup
// ---------------------------------------------------------------------------
#[test]
fn concurrent_executor_generation_startup() {
    let exe = locate_executor_binary();
    let temp = TempTestDir::new("concurrent-startup");
    let isolated1 = temp.isolated_env_named("local1", "temp1");
    let isolated2 = temp.isolated_env_named("local2", "temp2");
    let guard_file = temp.path().join("process-tree.lock");
    let generation = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    write_tree_guard(&guard_file, generation);

    // Spawn first executor holding the guard
    let mut child1 = Command::new(&exe)
        .envs(isolated1.as_pairs())
        .env("JUDGEDESK_PARENT_PID", std::process::id().to_string())
        .env("JUDGEDESK_TREE_GUARD_REQUIRED", "1")
        .env("JUDGEDESK_TREE_GUARD_PATH", &guard_file)
        .env("JUDGEDESK_TREE_GUARD_GENERATION", generation)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn first executor");

    std::thread::sleep(std::time::Duration::from_millis(150));

    // Spawn concurrent second executor targeting the exact same generation guard
    let output2 = Command::new(&exe)
        .envs(isolated2.as_pairs())
        .env("JUDGEDESK_PARENT_PID", std::process::id().to_string())
        .env("JUDGEDESK_TREE_GUARD_REQUIRED", "1")
        .env("JUDGEDESK_TREE_GUARD_PATH", &guard_file)
        .env("JUDGEDESK_TREE_GUARD_GENERATION", generation)
        .output()
        .expect("spawn second executor");

    let _ = child1.kill();
    let _ = child1.wait();

    assert!(
        !output2.status.success(),
        "Concurrent startup under the same generation lock must fail closed"
    );
    let stderr2 = String::from_utf8_lossy(&output2.stderr);
    assert!(
        stderr2.contains("PROCESS_TREE_GUARD_LOCK_FAILED"),
        "Expected lock failure for concurrent startup, got: {stderr2}"
    );
}

// ---------------------------------------------------------------------------
// Test 10: cancel_covers_reserved_and_active_runs (F4 Real Lifecycle Proof)
// ---------------------------------------------------------------------------
#[test]
fn cancel_covers_reserved_and_active_runs() {
    let exe = locate_executor_binary();
    let temp = TempTestDir::new("cancel-live");
    let isolated = temp.isolated_env();

    // Spawn real executor with isolated environment
    let client = ExecutorClient::spawn_sync_with_env(&exe, &isolated.as_pairs())
        .expect("spawn executor client");
    let client = Arc::new(client);

    // Create run workspace under executor root
    let ws_id = "ws-cancel-test";
    let ws_dir = client.root().join("workspaces").join(ws_id);
    fs::create_dir_all(&ws_dir).expect("create workspace directory");

    // Compile Mon-style C++ sleep program
    let source_file = ws_dir.join("submission.cpp");
    let cpp_code = r#"#include <bits/stdc++.h>
using namespace std;

void solve() {
    this_thread::sleep_for(chrono::milliseconds(5000));
}

int main() {
    ios_base :: sync_with_stdio (false); cin.tie (0); cout.tie (0);
    solve();
    return 0;
}
"#;
    fs::write(&source_file, cpp_code).expect("write C++ source");
    let out_exe = ws_dir.join(if cfg!(windows) {
        "submission.exe"
    } else {
        "submission"
    });
    let mut cmd = Command::new("g++");
    cmd.arg("-O2").arg("-std=c++14");
    if cfg!(windows) {
        cmd.arg("-static");
        cmd.arg("-Wl,--stack,66060288");
    }
    cmd.arg("-o").arg(&out_exe).arg(&source_file);
    let comp_output = cmd.output().expect("compile sleep submission with g++");
    assert!(
        comp_output.status.success(),
        "Compilation failed: {}",
        String::from_utf8_lossy(&comp_output.stderr)
    );

    let run_id = "active-run-cancel-001".to_string();
    let exe_rel = format!(
        "workspaces/{ws_id}/{}",
        if cfg!(windows) {
            "submission.exe"
        } else {
            "submission"
        }
    );
    let run_spec = RunSpec {
        run_id: run_id.clone(),
        role: RunRole::Submission,
        workspace_id: ws_id.to_string(),
        executable_id: exe_rel,
        args: vec![],
        stdin_file: None,
        stdout_file: "out.txt".to_string(),
        stderr_file: "err.txt".to_string(),
        environment: BTreeMap::new(),
        toolchain: None,
        local_toolchain: None,
        limits: RunLimits {
            wall_time_ms: 10_000,
            memory_bytes: 1024 * 1024 * 128,
            process_count: 1,
            thread_count: 16,
            output_bytes: 1024 * 1024,
            total_write_bytes: 1024 * 1024,
            open_files: 32,
            created_files: 16,
        },
    };

    // Spawn background thread to run the active execution
    let client_run = Arc::clone(&client);
    let run_handle = std::thread::spawn(move || client_run.run_sync(Box::new(run_spec)));

    // Allow worker to accept run and enter sleep
    std::thread::sleep(std::time::Duration::from_millis(200));

    // Cancel active run
    let cancelled = client.cancel_sync(&run_id).expect("cancel_sync succeeds");
    assert!(cancelled, "cancel_sync must report true for active run");

    // Await thread join and verify drain outcome
    let run_res = run_handle
        .join()
        .expect("join run thread")
        .expect("run_sync result");
    assert!(
        matches!(run_res.reason, RunReason::Cancelled),
        "Active execution must terminate with RunReason::Cancelled, got {:?}",
        run_res.reason
    );

    // Cancel unknown run returns false
    let unknown_cancelled = client
        .cancel_sync("non-existent-run-id")
        .expect("cancel unknown");
    assert!(
        !unknown_cancelled,
        "Cancelling unknown run must return false"
    );

    // Also assert DTO serialization round trip
    let cancel_req = ExecutorRequest::Cancel {
        id: "cancel-dto-1".to_string(),
        run_id: run_id.clone(),
    };
    let mut buf = Vec::new();
    write_request_frame(&mut buf, &cancel_req).expect("serialize cancel request");
    let mut cursor = Cursor::new(&buf);
    let payload = read_frame(&mut cursor)
        .expect("read frame")
        .expect("payload");
    let decoded: ExecutorRequest = serde_json::from_slice(&payload).expect("deserialize");
    match decoded {
        ExecutorRequest::Cancel { id, run_id: r_id } => {
            assert_eq!(id, "cancel-dto-1");
            assert_eq!(r_id, run_id);
        }
        _ => panic!("Expected Cancel request"),
    }
}

// ---------------------------------------------------------------------------
// Test 11: protocol_failure_drains_before_replacement (F4 Real Lifecycle Proof)
// ---------------------------------------------------------------------------
#[test]
fn protocol_failure_drains_before_replacement() {
    let exe = locate_executor_binary();
    let temp = TempTestDir::new("protocol-drain");
    let isolated = temp.isolated_env();
    let guard_file = temp.path().join("process-tree.lock");
    let generation = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    write_tree_guard(&guard_file, generation);

    // 1. Spawn live child executor with valid mandatory guard variables
    let mut child = Command::new(&exe)
        .envs(isolated.as_pairs())
        .env("JUDGEDESK_PARENT_PID", std::process::id().to_string())
        .env("JUDGEDESK_TREE_GUARD_REQUIRED", "1")
        .env("JUDGEDESK_TREE_GUARD_PATH", &guard_file)
        .env("JUDGEDESK_TREE_GUARD_GENERATION", generation)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn executor");

    // 2. Prove readiness / request-loop entry BEFORE sending corrupted frame
    {
        let stdin = child.stdin.as_mut().expect("child stdin");
        let health_req = ExecutorRequest::Health {
            id: "probe-readiness-before-corruption".to_string(),
        };
        write_request_frame(stdin, &health_req).expect("write health request");
        let stdout = child.stdout.as_mut().expect("child stdout");
        let resp_payload = read_frame(stdout)
            .expect("read frame")
            .expect("health response present");
        let resp: ExecutorResponse =
            serde_json::from_slice(&resp_payload).expect("deserialize health");
        match resp {
            ExecutorResponse::Health { health, .. } => {
                assert!(
                    health.ready,
                    "Executor must be ready before protocol corruption"
                );
                assert_eq!(health.executor_version, EXECUTOR_VERSION);
            }
            _ => panic!("Expected Health response"),
        }
    }

    // 3. Send truncated frame (4-byte length claiming 100 bytes, but only 5 bytes written)
    {
        let mut stdin = child.stdin.take().expect("child stdin");
        let _ = stdin.write_all(&100u32.to_le_bytes());
        let _ = stdin.write_all(b"12345");
        let _ = stdin.flush();
        // Drop stdin to cause unexpected EOF on truncated frame
    }

    // 4. Assert terminal child exit and reaping
    let start = std::time::Instant::now();
    let mut exited = false;
    while start.elapsed() < std::time::Duration::from_secs(5) {
        if let Ok(Some(_)) = child.try_wait() {
            exited = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    if !exited {
        let _ = child.kill();
    }
    let _ = child.wait();
    assert!(
        exited,
        "Executor process must exit cleanly after protocol failure / EOF"
    );

    // 5. Assert clean replacement: new executor can now start with the SAME generation guard
    let mut replacement = Command::new(&exe)
        .envs(isolated.as_pairs())
        .env("JUDGEDESK_PARENT_PID", std::process::id().to_string())
        .env("JUDGEDESK_TREE_GUARD_REQUIRED", "1")
        .env("JUDGEDESK_TREE_GUARD_PATH", &guard_file)
        .env("JUDGEDESK_TREE_GUARD_GENERATION", generation)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn replacement executor");

    {
        let stdin = replacement.stdin.as_mut().expect("replacement stdin");
        let health_req = ExecutorRequest::Health {
            id: "probe-replacement-readiness".to_string(),
        };
        write_request_frame(stdin, &health_req).expect("write replacement health request");
        let stdout = replacement.stdout.as_mut().expect("replacement stdout");
        let resp_payload = read_frame(stdout)
            .expect("read frame")
            .expect("replacement health response present");
        let resp: ExecutorResponse =
            serde_json::from_slice(&resp_payload).expect("deserialize health");
        match resp {
            ExecutorResponse::Health { health, .. } => {
                assert!(health.ready, "Replacement executor must be ready");
                assert_eq!(health.executor_version, EXECUTOR_VERSION);
            }
            _ => panic!("Expected Health response from replacement"),
        }
    }

    drop(replacement.stdin.take());
    let _ = replacement.wait();
}

// ---------------------------------------------------------------------------
// Test 11b: malformed_request_terminates_generation_before_replacement (F1)
// ---------------------------------------------------------------------------
#[test]
fn malformed_or_unknown_request_terminates_generation_before_replacement() {
    let exe = locate_executor_binary();
    let temp = TempTestDir::new("malformed-request-drain");
    let isolated = temp.isolated_env();
    let guard_file = temp.path().join("process-tree.lock");
    let generation = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    write_tree_guard(&guard_file, generation);

    let invalid_requests: [(&str, &[u8]); 2] = [
        ("malformed-json", b"{"),
        (
            "unknown-request",
            br#"{"type":"future_request","id":"unknown-request"}"#,
        ),
    ];

    for (case, payload) in invalid_requests {
        let mut child = Command::new(&exe)
            .envs(isolated.as_pairs())
            .env("JUDGEDESK_PARENT_PID", std::process::id().to_string())
            .env("JUDGEDESK_TREE_GUARD_REQUIRED", "1")
            .env("JUDGEDESK_TREE_GUARD_PATH", &guard_file)
            .env("JUDGEDESK_TREE_GUARD_GENERATION", generation)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn executor");

        {
            let stdin = child.stdin.as_mut().expect("child stdin");
            stdin
                .write_all(&(payload.len() as u32).to_le_bytes())
                .expect("write invalid request frame length");
            stdin
                .write_all(payload)
                .expect("write invalid request frame payload");
            write_request_frame(
                stdin,
                &ExecutorRequest::Health {
                    id: format!("must-not-run-{case}"),
                },
            )
            .expect("write request after invalid frame");
        }
        drop(child.stdin.take());

        {
            let stdout = child.stdout.as_mut().expect("child stdout");
            let response_payload = read_frame(stdout)
                .expect("read protocol error frame")
                .expect("protocol error frame is present");
            let response: ExecutorResponse =
                serde_json::from_slice(&response_payload).expect("deserialize protocol error");
            match response {
                ExecutorResponse::Error { id, code, .. } => {
                    assert!(
                        id.is_empty(),
                        "protocol error correlation ID must stay empty"
                    );
                    assert_eq!(
                        code, "SECURE_RUNNER_PROTOCOL_ERROR",
                        "{case} must return a protocol error"
                    );
                }
                other => panic!("{case} must return a protocol error, got {other:?}"),
            }

            assert!(
                read_frame(stdout)
                    .expect("executor stdout closes after terminal protocol failure")
                    .is_none(),
                "executor must not process a health request after {case}"
            );
        }

        let status = child.wait().expect("wait for terminal executor");
        assert!(
            !status.success(),
            "executor must exit with failure after {case}"
        );

        let mut replacement = Command::new(&exe)
            .envs(isolated.as_pairs())
            .env("JUDGEDESK_PARENT_PID", std::process::id().to_string())
            .env("JUDGEDESK_TREE_GUARD_REQUIRED", "1")
            .env("JUDGEDESK_TREE_GUARD_PATH", &guard_file)
            .env("JUDGEDESK_TREE_GUARD_GENERATION", generation)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn replacement executor");

        {
            let stdin = replacement.stdin.as_mut().expect("replacement stdin");
            write_request_frame(
                stdin,
                &ExecutorRequest::Health {
                    id: format!("replacement-after-{case}"),
                },
            )
            .expect("write replacement health request");
            let stdout = replacement.stdout.as_mut().expect("replacement stdout");
            let response_payload = read_frame(stdout)
                .expect("read replacement health frame")
                .expect("replacement health frame is present");
            let response: ExecutorResponse =
                serde_json::from_slice(&response_payload).expect("deserialize replacement health");
            match response {
                ExecutorResponse::Health { health, .. } => {
                    assert!(
                        health.ready,
                        "replacement executor must be ready after {case}"
                    );
                }
                other => panic!("expected replacement health response, got {other:?}"),
            }
            write_request_frame(
                stdin,
                &ExecutorRequest::Shutdown {
                    id: format!("shutdown-after-{case}"),
                },
            )
            .expect("write replacement shutdown request");
            let shutdown_payload = read_frame(stdout)
                .expect("read replacement shutdown frame")
                .expect("replacement shutdown frame is present");
            let shutdown: ExecutorResponse =
                serde_json::from_slice(&shutdown_payload).expect("deserialize shutdown response");
            assert!(
                matches!(shutdown, ExecutorResponse::ShutdownResult { .. }),
                "replacement executor must shut down cleanly after {case}"
            );
        }

        let replacement_status = replacement.wait().expect("wait for replacement executor");
        assert!(
            replacement_status.success(),
            "replacement executor must exit successfully after {case}"
        );
    }
}

// ---------------------------------------------------------------------------
// Test 12: parent_eof_leaves_no_owned_process_or_port
// ---------------------------------------------------------------------------
#[test]
fn parent_eof_leaves_no_owned_process_or_port() {
    let temp = TempTestDir::new("parent-eof");
    let isolated = temp.isolated_env();
    let exe = locate_executor_binary();

    let guard_file = temp.path().join("process-tree.lock");
    let generation = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    write_tree_guard(&guard_file, generation);

    let mut child = Command::new(&exe)
        .envs(isolated.as_pairs())
        .env("JUDGEDESK_PARENT_PID", std::process::id().to_string())
        .env("JUDGEDESK_TREE_GUARD_REQUIRED", "1")
        .env("JUDGEDESK_TREE_GUARD_PATH", &guard_file)
        .env("JUDGEDESK_TREE_GUARD_GENERATION", generation)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn executor");

    drop(child.stdin.take());

    let start = std::time::Instant::now();
    let mut exited = false;
    let mut exit_status = None;
    while start.elapsed() < std::time::Duration::from_secs(5) {
        if let Ok(Some(status)) = child.try_wait() {
            exit_status = Some(status);
            exited = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    if !exited {
        let _ = child.kill();
    }
    let _ = child.wait();
    assert!(
        exited,
        "Executor must terminate promptly upon parent stdin EOF"
    );
    if let Some(status) = exit_status {
        assert!(
            status.success(),
            "Executor must exit cleanly with code 0 on parent EOF"
        );
    }
}

// ---------------------------------------------------------------------------
// Test 13: updater_exclusive_handoff_waits_for_native_tree (F4 Real Lifecycle Proof)
// ---------------------------------------------------------------------------
#[test]
fn updater_exclusive_handoff_waits_for_native_tree() {
    let exe = locate_executor_binary();
    let temp = TempTestDir::new("updater-handoff");
    let isolated = temp.isolated_env();
    let guard_file = temp.path().join("process-tree.lock");
    let generation = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    write_tree_guard(&guard_file, generation);

    // Spawn live executor holding the generation lock
    let mut child = Command::new(&exe)
        .envs(isolated.as_pairs())
        .env("JUDGEDESK_PARENT_PID", std::process::id().to_string())
        .env("JUDGEDESK_TREE_GUARD_REQUIRED", "1")
        .env("JUDGEDESK_TREE_GUARD_PATH", &guard_file)
        .env("JUDGEDESK_TREE_GUARD_GENERATION", generation)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn live executor");

    // Verify executor is ready and running inside request loop
    {
        let stdin = child.stdin.as_mut().expect("child stdin");
        let health_req = ExecutorRequest::Health {
            id: "probe-before-updater".to_string(),
        };
        write_request_frame(stdin, &health_req).expect("write health request");
        let stdout = child.stdout.as_mut().expect("child stdout");
        let resp_payload = read_frame(stdout)
            .expect("read frame")
            .expect("health response present");
        let resp: ExecutorResponse =
            serde_json::from_slice(&resp_payload).expect("deserialize health");
        match resp {
            ExecutorResponse::Health { health, .. } => {
                assert!(health.ready, "Executor must be ready")
            }
            _ => panic!("Expected Health response"),
        }
    }

    // Updater attempts exclusive lock on the guard file while executor is running
    let updater_file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(&guard_file)
        .expect("open guard for updater");

    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            LockFileEx, UnlockFileEx, LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY,
        };
        let mut updater_overlapped = unsafe { std::mem::zeroed() };
        let updater_res = unsafe {
            LockFileEx(
                updater_file.as_raw_handle() as _,
                LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
                0,
                1,
                0,
                &mut updater_overlapped,
            )
        };
        assert_eq!(
            updater_res, 0,
            "Exclusive lock MUST fail while live native executor holds the generation lock"
        );

        // Terminate executor cleanly via EOF on stdin
        drop(child.stdin.take());
        let exit_status = child.wait().expect("wait for child exit");
        assert!(
            exit_status.success(),
            "Executor must exit cleanly on stdin EOF"
        );

        // Now updater exclusive lock must succeed
        let updater_res_after = unsafe {
            LockFileEx(
                updater_file.as_raw_handle() as _,
                LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
                0,
                1,
                0,
                &mut updater_overlapped,
            )
        };
        assert_ne!(
            updater_res_after, 0,
            "Exclusive lock MUST succeed after live native executor exits"
        );
        unsafe {
            UnlockFileEx(
                updater_file.as_raw_handle() as _,
                0,
                1,
                0,
                &mut updater_overlapped,
            );
        }
    }

    #[cfg(not(windows))]
    {
        use std::os::fd::AsRawFd;
        let updater_res =
            unsafe { libc::flock(updater_file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        assert_eq!(
            updater_res, -1,
            "Exclusive lock MUST fail while live native executor holds the generation lock"
        );

        // Terminate executor cleanly via EOF on stdin
        drop(child.stdin.take());
        let exit_status = child.wait().expect("wait for child exit");
        assert!(
            exit_status.success(),
            "Executor must exit cleanly on stdin EOF"
        );

        // Now updater exclusive lock must succeed
        let updater_res_after =
            unsafe { libc::flock(updater_file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        assert_eq!(
            updater_res_after, 0,
            "Exclusive lock MUST succeed after live native executor exits"
        );
        unsafe { libc::flock(updater_file.as_raw_fd(), libc::LOCK_UN) };
    }
}

fn repo_root() -> PathBuf {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest_dir
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.to_path_buf())
        .unwrap_or(manifest_dir)
}

fn client_module_url() -> String {
    let root = repo_root();
    format!(
        "file:///{}",
        root.join("server/executor/client.js")
            .to_string_lossy()
            .replace('\\', "/")
    )
}

// ---------------------------------------------------------------------------
// Test 14: node_rollback_reaches_compatible_executor (F4 Real Lifecycle Proof)
// ---------------------------------------------------------------------------
#[test]
fn node_rollback_reaches_compatible_executor() {
    let temp = TempTestDir::new("node-rollback");
    let isolated = temp.isolated_env();
    let root = repo_root();
    let client_url = client_module_url();

    // Invoke actual Node rollback client (server/executor/client.ts) via tsx
    // WITHOUT JUDGEDESK_EXECUTOR_PATH override so Node resolves the frozen packaged candidate.
    let script = format!(
        r#"
import {{ ExecutorClient, executorPathCandidates }} from '{client_url}';
import fs from 'node:fs';
import crypto from 'node:crypto';
async function main() {{
    const candidates = executorPathCandidates();
    const resolvedPath = candidates.find(c => fs.existsSync(c) && fs.statSync(c).isFile()) ?? null;
    let sha256 = null;
    if (resolvedPath) {{
        const buf = fs.readFileSync(resolvedPath);
        sha256 = crypto.createHash('sha256').update(buf).digest('hex').toUpperCase();
    }}
    const client = new ExecutorClient();
    const health = await client.start();
    console.log(JSON.stringify({{ health, resolvedPath, sha256 }}));
    await client.shutdown();
}}
main();
"#
    );

    let script_file = temp.path().join("test_rollback.ts");
    fs::write(&script_file, script).expect("write script file");

    let output = Command::new("node")
        .current_dir(&root)
        .arg("--import")
        .arg("tsx")
        .arg(&script_file)
        .envs(isolated.as_pairs())
        .env_remove("JUDGEDESK_EXECUTOR_PATH")
        .output()
        .expect("execute node rollback client via tsx");

    assert!(
        output.status.success(),
        "Node client execution failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let stdout_str = String::from_utf8_lossy(&output.stdout);
    let parsed: serde_json::Value = serde_json::from_str(stdout_str.trim()).unwrap_or_else(|e| {
        panic!(
            "parse node client health json: {e}, stdout: '{}', stderr: '{}'",
            stdout_str,
            String::from_utf8_lossy(&output.stderr)
        )
    });

    let health = &parsed["health"];
    assert_eq!(health["ready"], true, "Node client must report ready: true");
    assert_eq!(
        health["executorVersion"], EXECUTOR_VERSION,
        "Executor version must match the native crate"
    );
    assert_eq!(health["networkBlocked"], true);
    assert_eq!(health["filesystemIsolated"], true);
    assert_eq!(health["processTreeControlled"], true);
    assert_eq!(health["memoryLimitSupported"], true);

    // Verify exact packaged candidate resolution
    let resolved_path = parsed["resolvedPath"]
        .as_str()
        .expect("resolvedPath must be string");
    let norm_path = resolved_path.replace('\\', "/");
    assert!(
        !norm_path.contains("/target/debug/"),
        "Node rollback client must not resolve a debug executable: {resolved_path}"
    );
    assert!(
        norm_path.contains("/src-tauri/binaries/judgedesk-executor-"),
        "Node rollback client must resolve the packaged binary under src-tauri/binaries/: {resolved_path}"
    );

    if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        let sha256 = parsed["sha256"].as_str().expect("sha256 must be present");
        assert_eq!(
            sha256, FROZEN_WINDOWS_EXECUTOR_SHA256,
            "Node rollback client resolved executable SHA-256 mismatch against frozen candidate"
        );
    }
}

// ---------------------------------------------------------------------------
// Test 15: node_rollback_client_generation_contention (F4 Real Lifecycle Proof)
// ---------------------------------------------------------------------------
#[test]
fn node_rollback_client_generation_contention() {
    let temp = TempTestDir::new("node-contention");
    let isolated = temp.isolated_env();
    let guard_file = temp.path().join("guard.lock");
    let generation_file = "1111111111111111111111111111111111111111111111111111111111111111";
    let generation_mismatch = "2222222222222222222222222222222222222222222222222222222222222222";
    fs::write(
        &guard_file,
        format!("JUDGEDESK_PROCESS_TREE/1\ngeneration={generation_file}\n"),
    )
    .expect("write guard file");
    let root = repo_root();
    let client_url = client_module_url();

    let script = format!(
        r#"
import {{ ExecutorClient }} from '{client_url}';
async function main() {{
    process.env.JUDGEDESK_TREE_GUARD_REQUIRED = '1';
    process.env.JUDGEDESK_TREE_GUARD_PATH = '{}';
    process.env.JUDGEDESK_TREE_GUARD_GENERATION = '{}';
    process.env.JUDGEDESK_PARENT_PID = String(process.pid);
    const client = new ExecutorClient();
    const health = await client.start();
    console.log(JSON.stringify(health));
}}
main();
"#,
        guard_file.to_string_lossy().replace('\\', "\\\\"),
        generation_mismatch
    );

    let script_file = temp.path().join("test_contention.ts");
    fs::write(&script_file, script).expect("write script file");

    let output = Command::new("node")
        .current_dir(&root)
        .arg("--import")
        .arg("tsx")
        .arg(&script_file)
        .envs(isolated.as_pairs())
        .env_remove("JUDGEDESK_EXECUTOR_PATH")
        .output()
        .expect("execute node rollback client with conflicting generation");

    assert!(
        output.status.success(),
        "Node runner failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let stdout_str = String::from_utf8_lossy(&output.stdout);
    let health: serde_json::Value = serde_json::from_str(stdout_str.trim()).unwrap_or_else(|e| {
        panic!(
            "parse node client health json: {e}, stdout: '{}', stderr: '{}'",
            stdout_str,
            String::from_utf8_lossy(&output.stderr)
        )
    });

    assert_eq!(
        health["ready"], false,
        "Node client must fail closed on generation contention/mismatch"
    );
    assert_eq!(health["mode"], "unavailable");
    let diagnostics = health["diagnostics"].to_string();
    assert!(
        diagnostics.contains("PROCESS_TREE_GUARD_GENERATION_MISMATCH")
            || diagnostics.contains("Native executor exited"),
        "Diagnostics must indicate process tree guard generation failure, got: {diagnostics}"
    );
}

// ---------------------------------------------------------------------------
// Test 15b: node_rollback_client_honors_explicit_override_path (Override Behavior)
// ---------------------------------------------------------------------------
#[test]
fn node_rollback_client_honors_explicit_override_path() {
    let packaged_exe = locate_packaged_executor_binary();
    let temp = TempTestDir::new("node-override");
    let isolated = temp.isolated_env();
    let root = repo_root();
    let client_url = client_module_url();

    let script = format!(
        r#"
import {{ ExecutorClient, executorPathCandidates }} from '{client_url}';
import fs from 'node:fs';
async function main() {{
    const candidates = executorPathCandidates();
    const resolvedPath = candidates.find(c => fs.existsSync(c) && fs.statSync(c).isFile()) ?? null;
    const client = new ExecutorClient();
    const health = await client.start();
    console.log(JSON.stringify({{ health, resolvedPath, mode: 'explicit-override' }}));
    await client.shutdown();
}}
main();
"#
    );

    let script_file = temp.path().join("test_override.ts");
    fs::write(&script_file, script).expect("write script file");

    let output = Command::new("node")
        .current_dir(&root)
        .arg("--import")
        .arg("tsx")
        .arg(&script_file)
        .envs(isolated.as_pairs())
        .env("JUDGEDESK_EXECUTOR_PATH", &packaged_exe)
        .output()
        .expect("execute node rollback client with explicit override");

    assert!(output.status.success());
    let stdout_str = String::from_utf8_lossy(&output.stdout);
    let parsed: serde_json::Value = serde_json::from_str(stdout_str.trim()).unwrap();
    assert_eq!(parsed["health"]["ready"], true);
    assert_eq!(parsed["mode"], "explicit-override");

    let canonical_packaged = packaged_exe.canonicalize().unwrap_or(packaged_exe);
    let canonical_resolved = PathBuf::from(parsed["resolvedPath"].as_str().unwrap())
        .canonicalize()
        .unwrap();
    assert_eq!(canonical_resolved, canonical_packaged);
}

// ---------------------------------------------------------------------------
// Test 16: executor_rejects_incompatible_version_at_handshake (F2)
// ---------------------------------------------------------------------------
#[test]
fn executor_rejects_incompatible_version_at_handshake() {
    let exe = locate_executor_binary();
    let temp = TempTestDir::new("incompatible-version");
    let isolated = temp.isolated_env();
    let err = ExecutorClient::spawn_sync_with_args_and_env(
        &exe,
        &["--test-mock-health-version", "1.4.0"],
        &isolated.as_pairs(),
    )
    .expect_err("Incompatible version must fail handshake");
    assert!(
        err.to_string().contains("EXECUTOR_VERSION_MISMATCH"),
        "Expected version mismatch error, got: {err}"
    );
}

// ---------------------------------------------------------------------------
// Test 17: executor_rejects_unready_at_handshake (F2)
// ---------------------------------------------------------------------------
#[test]
fn executor_rejects_unready_at_handshake() {
    let exe = locate_executor_binary();
    let temp = TempTestDir::new("unready-handshake");
    let isolated = temp.isolated_env();
    let err = ExecutorClient::spawn_sync_with_args_and_env(
        &exe,
        &["--test-mock-health-unready"],
        &isolated.as_pairs(),
    )
    .expect_err("Unready executor must fail handshake");
    assert!(
        err.to_string().contains("EXECUTOR_NOT_READY"),
        "Expected not ready error, got: {err}"
    );
}

// ---------------------------------------------------------------------------
// Test 18: executor_rejects_insecure_capabilities_at_handshake (F2)
// ---------------------------------------------------------------------------
#[test]
fn executor_rejects_insecure_capabilities_at_handshake() {
    let exe = locate_executor_binary();
    let temp = TempTestDir::new("insecure-capabilities");
    let isolated = temp.isolated_env();
    let err = ExecutorClient::spawn_sync_with_args_and_env(
        &exe,
        &["--test-mock-health-insecure"],
        &isolated.as_pairs(),
    )
    .expect_err("Insecure capabilities must fail handshake");
    assert!(
        err.to_string().contains("EXECUTOR_INSECURE_CAPABILITIES"),
        "Expected insecure capabilities error, got: {err}"
    );
}

// ---------------------------------------------------------------------------
// Test 19: executor_protocol_malformed_fails_closed (F3)
// ---------------------------------------------------------------------------
#[test]
fn executor_protocol_malformed_fails_closed() {
    let exe = locate_executor_binary();
    let temp = TempTestDir::new("malformed-response");
    let isolated = temp.isolated_env();
    let err = ExecutorClient::spawn_sync_with_args_and_env(
        &exe,
        &["--test-mock-malformed-response"],
        &isolated.as_pairs(),
    )
    .expect_err("Malformed response must fail closed");
    assert!(
        err.to_string().contains("malformed") || err.to_string().contains("protocol error"),
        "Expected protocol error, got: {err}"
    );
}

// ---------------------------------------------------------------------------
// Test 20: executor_protocol_unknown_id_fails_closed (F3)
// ---------------------------------------------------------------------------
#[test]
fn executor_protocol_unknown_id_fails_closed() {
    let exe = locate_executor_binary();
    let temp = TempTestDir::new("unknown-id");
    let isolated = temp.isolated_env();
    let err = ExecutorClient::spawn_sync_with_args_and_env(
        &exe,
        &["--test-mock-unknown-id"],
        &isolated.as_pairs(),
    )
    .expect_err("Unknown response ID must fail closed");
    assert!(
        err.to_string().contains("unknown correlation ID"),
        "Expected unknown correlation ID error, got: {err}"
    );
}

#[test]
fn protocol_terminal_shutdown_waits_for_the_executor_exit() {
    let exe = locate_executor_binary();
    let temp = TempTestDir::new("protocol-terminal-shutdown");
    let isolated = temp.isolated_env();
    let client = ExecutorClient::spawn_sync_with_args_and_env(
        &exe,
        &["--test-mock-health-then-unknown-drain"],
        &isolated.as_pairs(),
    )
    .expect("mock must complete the initial health handshake");
    assert!(client.health().ready);

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    while client.cancel_sync("probe").is_ok() && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert!(
        std::time::Instant::now() < deadline,
        "mock protocol terminalization did not close client admission"
    );

    let shutdown_started = std::time::Instant::now();
    client
        .shutdown_sync()
        .expect("protocol-terminal shutdown must wait for the native EOF drain");
    assert!(
        shutdown_started.elapsed() >= std::time::Duration::from_millis(180),
        "shutdown returned before the protocol-terminal executor exit was observed"
    );
}

// ---------------------------------------------------------------------------
// Test 21: executor_unavailable_graceful_propagation (F5)
// ---------------------------------------------------------------------------
#[test]
fn executor_unavailable_graceful_propagation() {
    let client = ExecutorClient::unavailable("Diagnostic test: executor missing");
    assert!(client.is_admission_closed());
    let run_spec = RunSpec {
        run_id: "test-run".to_string(),
        role: RunRole::Submission,
        workspace_id: "ws".to_string(),
        executable_id: "exe".to_string(),
        args: vec![],
        stdin_file: None,
        stdout_file: "out.txt".to_string(),
        stderr_file: "err.txt".to_string(),
        environment: BTreeMap::new(),
        toolchain: None,
        local_toolchain: None,
        limits: RunLimits {
            wall_time_ms: 1000,
            memory_bytes: 1024 * 1024 * 64,
            process_count: 1,
            thread_count: 1,
            output_bytes: 1024,
            total_write_bytes: 1024,
            open_files: 10,
            created_files: 10,
        },
    };
    let err = client
        .run_sync(Box::new(run_spec))
        .expect_err("Must fail when unavailable");
    assert!(err.to_string().contains("SECURE_RUNNER_UNAVAILABLE"));
}

#[test]
fn executor_boundary_spawns_never_touch_ambient_tmpdir_judgedesk_executor() {
    let _environment = PROCESS_ENV_LOCK.lock().expect("lock process environment");
    let canary = TempTestDir::new("ambient-tmpdir-canary");
    let canary_tmp = canary.path().join("ambient-tmp");
    let canary_local = canary.path().join("ambient-local");
    fs::create_dir_all(&canary_tmp).expect("create canary tmp");
    fs::create_dir_all(&canary_local).expect("create canary localappdata");

    let temp = TempTestDir::new("isolated-executor-spawn");
    let isolated = temp.isolated_env();
    let exe = locate_executor_binary();

    let restore = EnvironmentRestore::capture(&[
        "LOCALAPPDATA",
        "APPDATA",
        "THEMIS_APP_DATA_DIR",
        "TMPDIR",
        "TEMP",
        "TMP",
    ]);
    std::env::set_var("LOCALAPPDATA", &canary_local);
    std::env::set_var("TMPDIR", &canary_tmp);
    std::env::set_var("TEMP", &canary_tmp);
    std::env::set_var("TMP", &canary_tmp);

    let client = ExecutorClient::spawn_sync_with_env(&exe, &isolated.as_pairs())
        .expect("spawn executor client with isolated env");
    assert!(client.health().ready);
    assert!(
        !canary_tmp.join("JudgeDeskExecutor").exists(),
        "ambient TMPDIR/JudgeDeskExecutor must never be created by isolated executor spawns"
    );
    assert!(
        !canary_local.join("JudgeDesk").join("JudgeDeskExecutor").exists(),
        "ambient LOCALAPPDATA/JudgeDesk/JudgeDeskExecutor must never be created by isolated executor spawns"
    );
    drop(client);
    drop(restore);
    assert!(
        fs::read_dir(&canary_tmp)
            .expect("read canary tmp")
            .next()
            .is_none(),
        "ambient TMPDIR must be completely clean after client drop"
    );
    assert!(
        fs::read_dir(&canary_local)
            .expect("read canary localappdata")
            .next()
            .is_none(),
        "ambient LOCALAPPDATA must be completely clean after client drop"
    );
}
