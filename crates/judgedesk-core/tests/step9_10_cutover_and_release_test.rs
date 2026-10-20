use judgedesk_core::executor_client::TreeGuardContract;
use judgedesk_core::server::{
    start_embedded_server_with_tree_guard, start_embedded_server_with_tree_guard_and_pid,
};
use judgedesk_native_executor::protocol::EXECUTOR_VERSION;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

static TEST_DIR_COUNTER: AtomicU64 = AtomicU64::new(0);
const OWNERSHIP_MARKER: &str = "judgedesk-test-owned\n";

struct TempTestDir(PathBuf);

impl TempTestDir {
    fn new(label: &str) -> Self {
        let id = TEST_DIR_COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("jdm4-{label}-{}-{id}", std::process::id()));
        let _ = fs::create_dir_all(&path);
        let _ = fs::write(path.join(".judgedesk-test-root"), OWNERSHIP_MARKER);
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
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

fn repo_root() -> PathBuf {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest_dir
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.to_path_buf())
        .unwrap_or(manifest_dir)
}

fn write_tree_guard_file(dir: &Path, generation: &str) -> PathBuf {
    let file_path = dir.join(if cfg!(windows) {
        "process-tree.guard"
    } else {
        "process-tree.generation"
    });
    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&file_path).expect("open tree guard file");
    file.write_all(format!("JUDGEDESK_PROCESS_TREE/1\ngeneration={generation}\n").as_bytes())
        .expect("write tree guard contents");
    file.sync_all().expect("sync tree guard file");
    file_path
}

#[test]
fn wp10_2_default_backend_is_rust_with_explicit_node_rollback_and_no_fallback() {
    let root = repo_root();
    let backend_rs =
        fs::read_to_string(root.join("src-tauri/src/backend.rs")).expect("read backend.rs");

    assert!(
        backend_rs.contains("let Some(value) = value else {\n        return Ok(BackendMode::ExperimentalRust);\n    };"),
        "WP10.2: backend_mode_from_env(None) must default to BackendMode::ExperimentalRust"
    );
    assert!(
        backend_rs.contains("Some(\"0\") => Ok(BackendMode::NodeSidecar)"),
        "WP10.2: JUDGEDESK_PURE_RUST_CORE=0 must explicitly select BackendMode::NodeSidecar rollback"
    );
    assert!(
        backend_rs.contains("value.eq_ignore_ascii_case(\"false\") => Ok(BackendMode::NodeSidecar)"),
        "WP10.2: JUDGEDESK_PURE_RUST_CORE=false must explicitly select BackendMode::NodeSidecar rollback"
    );
    assert!(
        backend_rs.contains(".assign_backend(pid)"),
        "WP10.2/V9.3: embedded Rust backend must register its native executor PID with InstanceCoordinator"
    );
    let spawn_source = backend_rs
        .split_once("pub fn spawn")
        .and_then(|(_, tail)| tail.split_once("fn wait_for_termination"))
        .map(|(body, _)| body)
        .expect("locate production backend spawn function");
    assert!(
        !spawn_source.contains("falling back to Pure Rust")
            && !spawn_source.contains("falling back to Node"),
        "WP10.2: backend.rs spawn must never silently fallback between Rust and Node"
    );
}

#[test]
fn wp10_3_eight_file_and_core_crate_version_lockstep_is_1_6_0() {
    assert_eq!(
        env!("CARGO_PKG_VERSION"),
        "1.6.0",
        "WP10.3: crates/judgedesk-core version must be 1.6.0"
    );
    assert_eq!(
        EXECUTOR_VERSION, "1.6.0",
        "WP10.3: judgedesk-native-executor EXECUTOR_VERSION must be 1.6.0"
    );

    let root = repo_root();
    let pkg_json: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(root.join("package.json")).expect("read package.json"),
    )
    .expect("parse package.json");
    assert_eq!(pkg_json["version"], "1.6.0");

    let tauri_conf: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(root.join("src-tauri/tauri.conf.json")).expect("read tauri.conf.json"),
    )
    .expect("parse tauri.conf.json");
    assert_eq!(tauri_conf["version"], "1.6.0");

    let version_ts = fs::read_to_string(root.join("src/version.ts")).expect("read src/version.ts");
    assert!(
        version_ts.contains("export const APP_VERSION = \"1.6.0\";"),
        "src/version.ts must export APP_VERSION = 1.6.0"
    );

    let check_ok = Command::new("node")
        .current_dir(&root)
        .env("GITHUB_REF_NAME", "v1.6.0")
        .args(["scripts/check-release-version.js"])
        .output()
        .expect("run check-release-version.js v1.6.0");
    assert!(
        check_ok.status.success(),
        "check-release-version.js v1.6.0 failed: {}",
        String::from_utf8_lossy(&check_ok.stderr)
    );

    let check_stale_tag = Command::new("node")
        .current_dir(&root)
        .env("GITHUB_REF_NAME", "v1.5.5")
        .args(["scripts/check-release-version.js"])
        .output()
        .expect("run check-release-version.js v1.5.5");
    assert!(
        !check_stale_tag.status.success(),
        "check-release-version.js must reject stale v1.5.5 git tag after v1.6.0 bump"
    );
}

#[test]
fn v9_1_to_g10_desktop_launch_and_gate_scripts_enforce_rust_default_without_node_sea_requirement() {
    let root = repo_root();
    let pkg_json: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(root.join("package.json")).expect("read package.json"),
    )
    .expect("parse package.json");
    let test_desktop = pkg_json["scripts"]["test:desktop"]
        .as_str()
        .expect("test:desktop script");
    assert!(
        test_desktop.contains("npm run build:executor") && !test_desktop.contains("npm run build:server"),
        "V9.1/WP10.6: test:desktop must build native executor for Rust-only desktop launch without requiring Node SEA build:server"
    );

    let win_gate = fs::read_to_string(root.join("scripts/windows-single-instance-gate.ps1"))
        .expect("read windows-single-instance-gate.ps1");
    assert!(
        win_gate.contains("JUDGEDESK_PURE_RUST_CORE"),
        "V9.1/V9.2: windows-single-instance-gate.ps1 must support default embedded Rust mode (expectedServerCount=0) and explicit Node rollback"
    );

    let mac_sup_gate = fs::read_to_string(root.join("scripts/macos-process-supervisor-gate.sh"))
        .expect("read macos-process-supervisor-gate.sh");
    assert!(
        mac_sup_gate.contains("JUDGEDESK_PURE_RUST_CORE"),
        "V9.3/G9: macos-process-supervisor-gate.sh must support default embedded Rust mode and explicit Node rollback"
    );

    let mac_chk_gate = fs::read_to_string(root.join("scripts/macos-packaged-checker-gate.mjs"))
        .expect("read macos-packaged-checker-gate.mjs");
    assert!(
        mac_chk_gate.contains("JUDGEDESK_PURE_RUST_CORE"),
        "V9.3/G9: macos-packaged-checker-gate.mjs must support default embedded Rust mode and explicit Node rollback"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn g9_g10_embedded_rust_server_with_tree_guard_reports_rust_backend_and_drains_cleanly() {
    let temp = TempTestDir::new("embedded-tree-guard");
    let generation = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
    let guard_path = write_tree_guard_file(temp.path(), generation);
    let contract = TreeGuardContract::new(guard_path.clone(), generation.to_string())
        .expect("valid tree guard contract");
    let api_token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".to_string();

    let (addr, _maybe_pid, handle) =
        start_embedded_server_with_tree_guard_and_pid(0, contract.clone(), api_token.clone())
            .await
            .expect("start embedded server with tree guard and pid");

    // Verify GET /api/status with session token
    let mut stream = TcpStream::connect(addr).expect("connect to embedded server");
    let get_req = format!(
        "GET /api/status HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nX-JudgeDesk-Session: {api_token}\r\nConnection: close\r\n\r\n",
        addr.port()
    );
    stream
        .write_all(get_req.as_bytes())
        .expect("write GET /api/status");
    let mut resp_bytes = Vec::new();
    stream
        .read_to_end(&mut resp_bytes)
        .expect("read GET /api/status");
    let resp_str = String::from_utf8_lossy(&resp_bytes);
    assert!(
        resp_str.starts_with("HTTP/1.1 200 ") || resp_str.starts_with("HTTP/1.0 200 "),
        "GET /api/status must return 200 OK: {resp_str}"
    );
    let (_, body) = resp_str.split_once("\r\n\r\n").expect("split HTTP headers");
    let status_json: serde_json::Value = serde_json::from_str(body).expect("parse status JSON");
    assert_eq!(status_json["build"]["backend"], "rust");
    assert_eq!(status_json["isServerMode"], false);

    // Also verify backwards-compatible start_embedded_server_with_tree_guard wrapper
    let mut shutdown_stream =
        TcpStream::connect(addr).expect("connect to embedded server for shutdown");
    let post_req = format!(
        "POST /api/shutdown HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nX-JudgeDesk-Session: {api_token}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        addr.port()
    );
    shutdown_stream
        .write_all(post_req.as_bytes())
        .expect("write POST /api/shutdown");
    let mut shutdown_resp = Vec::new();
    shutdown_stream
        .read_to_end(&mut shutdown_resp)
        .expect("read POST /api/shutdown");
    let shutdown_str = String::from_utf8_lossy(&shutdown_resp);
    assert!(
        shutdown_str.contains("{\"success\":true}"),
        "POST /api/shutdown must acknowledge with success: true, got: {shutdown_str}"
    );
    let _ = tokio::time::timeout(std::time::Duration::from_secs(5), handle)
        .await
        .expect("embedded server task must exit within 5s of shutdown");

    let (addr2, handle2) = start_embedded_server_with_tree_guard(0, contract, api_token.clone())
        .await
        .expect("start embedded server via wrapper");
    let mut s2 = TcpStream::connect(addr2).expect("connect wrapper server");
    let post_req2 = format!(
        "POST /api/shutdown HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nX-JudgeDesk-Session: {api_token}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        addr2.port()
    );
    s2.write_all(post_req2.as_bytes()).expect("write shutdown2");
    let _ = tokio::time::timeout(std::time::Duration::from_secs(5), handle2)
        .await
        .expect("wrapper server task must exit within 5s of shutdown");
}
