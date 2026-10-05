use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, Once};
use std::time::{SystemTime, UNIX_EPOCH};

static INIT_TEST_ENV: Once = Once::new();
static TEST_ENVIRONMENT_LOCK: Mutex<()> = Mutex::new(());
const OWNERSHIP_MARKER: &str = "judgedesk-test-owned\n";

pub struct OwnedTestEnvironment {
    root: PathBuf,
    _lock: MutexGuard<'static, ()>,
}

struct EnvironmentRestore(Vec<(&'static str, Option<OsString>)>);

impl Drop for EnvironmentRestore {
    fn drop(&mut self) {
        for (name, previous) in self.0.drain(..).rev() {
            match previous {
                Some(value) => std::env::set_var(name, value),
                None => std::env::remove_var(name),
            }
        }
    }
}

impl OwnedTestEnvironment {
    pub fn new() -> Self {
        let lock = TEST_ENVIRONMENT_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        let root =
            std::env::temp_dir().join(format!("jd_test_core_{}_{}", std::process::id(), nonce));
        let local_app_data = root.join("local");
        let roaming_app_data = root.join("roaming");
        let temp = root.join("temp");

        std::fs::create_dir_all(&local_app_data).expect("create owned LOCALAPPDATA test root");
        std::fs::create_dir_all(&roaming_app_data).expect("create owned APPDATA test root");
        std::fs::create_dir_all(&temp).expect("create owned TEMP test root");
        std::fs::write(root.join(".judgedesk-test-root"), OWNERSHIP_MARKER)
            .expect("mark owned Rust core test root");

        #[cfg(unix)]
        let root = std::fs::canonicalize(&root).unwrap_or(root);

        Self { root, _lock: lock }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn with_isolated_roots<T>(&self, operation: impl FnOnce() -> T) -> T {
        let replacements = [
            ("LOCALAPPDATA", self.root.join("local").into_os_string()),
            ("APPDATA", self.root.join("roaming").into_os_string()),
            ("TEMP", self.root.join("temp").into_os_string()),
            ("TMP", self.root.join("temp").into_os_string()),
            ("TMPDIR", self.root.join("temp").into_os_string()),
        ];
        let previous_environment = replacements
            .iter()
            .map(|(name, _)| (*name, std::env::var_os(name)))
            .collect();
        let _restore = EnvironmentRestore(previous_environment);
        for (name, value) in replacements {
            std::env::set_var(name, value);
        }
        operation()
    }

    fn cleanup(&mut self) -> Result<(), String> {
        let marker_path = self.root.join(".judgedesk-test-root");
        let marker = std::fs::read_to_string(&marker_path).map_err(|error| {
            format!(
                "read owned test root marker {}: {error}",
                marker_path.display()
            )
        })?;
        if marker != OWNERSHIP_MARKER {
            return Err(format!(
                "refusing to remove unmarked Rust core test root {}",
                self.root.display()
            ));
        }
        std::fs::remove_dir_all(&self.root).map_err(|error| {
            format!(
                "remove owned Rust core test root {}: {error}",
                self.root.display()
            )
        })?;
        if self.root.exists() {
            return Err(format!(
                "owned Rust core test root still exists after cleanup: {}",
                self.root.display()
            ));
        }
        Ok(())
    }
}

impl Drop for OwnedTestEnvironment {
    fn drop(&mut self) {
        if let Err(error) = self.cleanup() {
            if std::thread::panicking() {
                eprintln!("Rust core test environment cleanup failed during unwind: {error}");
            } else {
                panic!("Rust core test environment cleanup failed: {error}");
            }
        }
    }
}

pub fn ensure_test_environment() {
    INIT_TEST_ENV.call_once(|| {
        #[cfg(target_os = "macos")]
        {
            init_macos_tree_guard();
        }
        init_executor_binary();
    });
}

#[cfg(target_os = "macos")]
fn init_macos_tree_guard() {
    use std::fs::{self, OpenOptions};
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;

    if std::env::var_os("JUDGEDESK_TREE_GUARD_REQUIRED").as_deref()
        == Some(std::ffi::OsStr::new("1"))
    {
        if let Some(path) = std::env::var_os("JUDGEDESK_TREE_GUARD_PATH") {
            if Path::new(&path).is_file() {
                return;
            }
        }
    }

    let dir =
        std::env::temp_dir().join(format!("judgedesk-test-tree-guard-{}", std::process::id()));
    let _ = fs::create_dir_all(&dir);
    let guard_path = dir.join("process-tree.generation");
    let generation = format!("{:064x}", std::process::id());

    let _ = fs::remove_file(&guard_path);
    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .mode(0o600)
        .open(&guard_path)
        .expect("create test tree guard file");
    file.write_all(format!("JUDGEDESK_PROCESS_TREE/1\ngeneration={generation}\n").as_bytes())
        .expect("write test tree guard generation");
    file.sync_all().expect("sync test tree guard file");

    std::env::set_var("JUDGEDESK_TREE_GUARD_REQUIRED", "1");
    std::env::set_var("JUDGEDESK_TREE_GUARD_PATH", &guard_path);
    std::env::set_var("JUDGEDESK_TREE_GUARD_GENERATION", &generation);
}

#[allow(dead_code)]
pub fn executor_binary_path() -> PathBuf {
    ensure_test_environment();
    if let Some(path) = std::env::var_os("JUDGEDESK_EXECUTOR_PATH") {
        let p = PathBuf::from(path);
        if p.is_file() {
            return p;
        }
    }
    let binary_name = if cfg!(windows) {
        "judgedesk-native-executor.exe"
    } else {
        "judgedesk-native-executor"
    };

    let candidates = [
        PathBuf::from(format!("../../native-executor/target/debug/{binary_name}")),
        PathBuf::from(format!("../native-executor/target/debug/{binary_name}")),
        PathBuf::from(format!("native-executor/target/debug/{binary_name}")),
        PathBuf::from(format!("../../target/debug/{binary_name}")),
        PathBuf::from(format!("../target/debug/{binary_name}")),
    ];

    for candidate in &candidates {
        if candidate.is_file() {
            if let Ok(abs) = std::fs::canonicalize(candidate) {
                return abs;
            }
        }
    }
    panic!("judgedesk-native-executor binary not found; build native-executor first");
}

fn init_executor_binary() {
    if let Some(path) = std::env::var_os("JUDGEDESK_EXECUTOR_PATH") {
        if Path::new(&path).is_file() {
            return;
        }
    }

    let binary_name = if cfg!(windows) {
        "judgedesk-native-executor.exe"
    } else {
        "judgedesk-native-executor"
    };

    let candidates = [
        PathBuf::from(format!("../native-executor/target/debug/{binary_name}")),
        PathBuf::from(format!("../native-executor/target/release/{binary_name}")),
        PathBuf::from(format!("../../native-executor/target/debug/{binary_name}")),
        PathBuf::from(format!(
            "../../native-executor/target/release/{binary_name}"
        )),
        PathBuf::from(format!("native-executor/target/debug/{binary_name}")),
        PathBuf::from(format!("native-executor/target/release/{binary_name}")),
        PathBuf::from(format!("target/debug/{binary_name}")),
        PathBuf::from(format!("target/release/{binary_name}")),
    ];

    for candidate in &candidates {
        if candidate.is_file() {
            if let Ok(abs) = std::fs::canonicalize(candidate) {
                std::env::set_var("JUDGEDESK_EXECUTOR_PATH", abs);
                return;
            }
        }
    }

    let manifest_path = if Path::new("../native-executor/Cargo.toml").is_file() {
        "../native-executor/Cargo.toml"
    } else if Path::new("../../native-executor/Cargo.toml").is_file() {
        "../../native-executor/Cargo.toml"
    } else if Path::new("native-executor/Cargo.toml").is_file() {
        "native-executor/Cargo.toml"
    } else {
        return;
    };

    let status = std::process::Command::new("cargo")
        .args(["build", "--locked", "--manifest-path", manifest_path])
        .status();

    if let Ok(status) = status {
        if status.success() {
            for candidate in &candidates {
                if candidate.is_file() {
                    if let Ok(abs) = std::fs::canonicalize(candidate) {
                        std::env::set_var("JUDGEDESK_EXECUTOR_PATH", abs);
                        return;
                    }
                }
            }
        }
    }
}
