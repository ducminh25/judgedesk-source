#![cfg(target_os = "linux")]

use judgedesk_core::executor_client::ExecutorClient;
use judgedesk_core::server::AppState;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::sync::Arc;

mod common;

fn compiler_wrapper(root: &Path, extra_flags: &str) -> std::path::PathBuf {
    let bin = root.join("custom-gcc/bin");
    fs::create_dir_all(&bin).unwrap();
    let exe = bin.join("g++");
    fs::write(
        &exe,
        format!("#!/bin/sh\nexec /usr/bin/g++ {extra_flags} \"$@\"\n"),
    )
    .unwrap();
    fs::set_permissions(&exe, fs::Permissions::from_mode(0o755)).unwrap();
    exe
}

#[test]
fn executor_does_not_inherit_appimage_loader_paths() {
    let env = common::OwnedTestEnvironment::new();
    let libraries = env.root().join("appimage-libraries");
    fs::create_dir(&libraries).unwrap();
    fs::write(libraries.join("libc.so.6"), b"incompatible bundled library").unwrap();
    let previous = std::env::var_os("LD_LIBRARY_PATH");
    std::env::set_var("LD_LIBRARY_PATH", &libraries);
    let result =
        env.with_isolated_roots(|| ExecutorClient::spawn_sync(&common::executor_binary_path()));
    match previous {
        Some(value) => std::env::set_var("LD_LIBRARY_PATH", value),
        None => std::env::remove_var("LD_LIBRARY_PATH"),
    }
    let platform = result.expect("native executor must use host libraries");
    assert!(platform.health().ready, "{:?}", platform.health());
    platform.shutdown_sync().unwrap();
}

#[test]
fn compiler_probe_does_not_inherit_appimage_loader_paths() {
    let env = common::OwnedTestEnvironment::new();
    let exe = compiler_wrapper(env.root(), "");
    let libraries = env.root().join("appimage-libraries");
    fs::create_dir(&libraries).unwrap();
    fs::write(libraries.join("libc.so.6"), b"incompatible bundled library").unwrap();
    let previous = std::env::var_os("LD_LIBRARY_PATH");
    std::env::set_var("LD_LIBRARY_PATH", &libraries);
    let result = judgedesk_core::toolchains::discovery::query_executable_version(&exe, "cpp");
    match previous {
        Some(value) => std::env::set_var("LD_LIBRARY_PATH", value),
        None => std::env::remove_var("LD_LIBRARY_PATH"),
    }
    assert_ne!(result, "unknown", "host compiler must use host libraries");
}

#[test]
fn compiler_in_home_bin_does_not_grant_the_whole_home() {
    let env = common::OwnedTestEnvironment::new();
    let exe = compiler_wrapper(env.root(), "");
    let fake_home = exe.parent().unwrap().parent().unwrap();
    let previous = std::env::var_os("HOME");
    std::env::set_var("HOME", fake_home);
    let resolved =
        judgedesk_core::toolchains::discovery::resolve_toolchain_for_profile_with_policy_in(
            Some(env.root()),
            "cpp",
            Some("local_path"),
            exe.to_str(),
            judgedesk_core::toolchains::discovery::ExecutionPolicyMode::QuickVerifiedDirect,
            None,
        );
    let nested_home = fake_home.join("alice");
    fs::create_dir(&nested_home).unwrap();
    std::env::set_var("HOME", &nested_home);
    let ancestor_resolved =
        judgedesk_core::toolchains::discovery::resolve_toolchain_for_profile_with_policy_in(
            Some(env.root()),
            "cpp",
            Some("local_path"),
            exe.to_str(),
            judgedesk_core::toolchains::discovery::ExecutionPolicyMode::QuickVerifiedDirect,
            None,
        );
    match previous {
        Some(value) => std::env::set_var("HOME", value),
        None => std::env::remove_var("HOME"),
    }
    assert_eq!(resolved.package_root.as_deref(), exe.parent());
    assert_eq!(ancestor_resolved.package_root.as_deref(), exe.parent());
}

#[test]
fn detected_compiler_is_not_ready_without_a_secure_executor() {
    let env = common::OwnedTestEnvironment::new();
    let exe = compiler_wrapper(env.root(), "");
    let state = AppState::new(Arc::new(ExecutorClient::unavailable("test: no sandbox")));
    let resolved = state.toolchain_observation.resolve_profile(
        &state,
        state.current_toolchain_revision(),
        env.root(),
        "cpp",
        "local_path",
        exe.to_str(),
    );
    assert!(
        !resolved.ready,
        "host-only compilation cannot establish readiness"
    );
    assert!(resolved.diagnostic.unwrap().contains("secure runner"));
}

#[test]
fn compiler_outside_usr_must_link_and_execute_in_the_sandbox() {
    let env = common::OwnedTestEnvironment::new();
    let exe = compiler_wrapper(env.root(), "");
    let platform = env.with_isolated_roots(|| {
        ExecutorClient::spawn_sync(&common::executor_binary_path()).unwrap()
    });
    assert!(platform.health().ready, "{:?}", platform.health());
    let state = AppState::new(Arc::new(platform));
    let resolved = state.toolchain_observation.resolve_profile(
        &state,
        state.current_toolchain_revision(),
        env.root(),
        "cpp",
        "local_path",
        exe.to_str(),
    );
    assert!(resolved.ready, "{:?}", resolved.diagnostic);
    let source = fs::read_to_string(&exe).unwrap();
    // Keep host object compilation working, but make linking the known probe fail.
    fs::write(
        &exe,
        source.replace("/usr/bin/g++ ", "/usr/bin/g++ -nostdlib "),
    )
    .unwrap();
    let broken = state.toolchain_observation.resolve_profile(
        &state,
        state.current_toolchain_revision(),
        env.root(),
        "cpp",
        "local_path",
        exe.to_str(),
    );
    assert!(
        !broken.ready,
        "a successful -c probe must not hide a broken linker"
    );
    assert!(broken.diagnostic.unwrap().contains("compilation"));
}

#[test]
fn version_probe_does_not_wait_for_an_inherited_pipe_in_a_descendant() {
    let env = common::OwnedTestEnvironment::new();
    let exe = env.root().join("version-wrapper");
    fs::write(&exe, "#!/bin/sh\nsleep 3 &\nprintf 'gcc 16.2.1\\n'\n").unwrap();
    fs::set_permissions(&exe, fs::Permissions::from_mode(0o755)).unwrap();
    let started = std::time::Instant::now();
    let version = judgedesk_core::toolchains::discovery::query_executable_version(&exe, "cpp");
    assert_eq!(version, "16.2.1");
    assert!(started.elapsed() < std::time::Duration::from_secs(2));
}

#[test]
fn fixed_bundled_scratch_repairs_both_preserved_and_executor_copies() {
    use judgedesk_core::toolchains::discovery::{
        copy_dir_recursive, ensure_cached_managed_toolchain, preserve_bundled_toolchains_in,
        read_package_receipt,
    };
    let env = common::OwnedTestEnvironment::new();
    let resources = env.root().join("resources");
    let source = resources.join("toolchains/scratch-linux-x64");
    fs::create_dir_all(&source).unwrap();
    let previous = std::env::var_os("THEMIS_RESOURCE_DIR");
    let receipt = serde_json::json!({
        "schemaVersion": 1, "packageId": "scratch-linux-x64", "version": "0.1.7",
        "archiveSha256": "a".repeat(64), "entrypointComponentId": "scratch.runtime",
        "components": [{"id": "scratch.runtime", "kind": "executable",
            "relativePath": "scratch-run", "roles": ["submission-runtime"]}]
    });
    fs::write(source.join(".judgedesk-package.json"), receipt.to_string()).unwrap();
    fs::write(source.join("scratch-run"), b"pristine pkg binary").unwrap();
    // Full must use a genuinely pinned package; a synthetic legacy receipt is
    // intentionally rejected by that edition's production trust boundary.
    if judgedesk_core::toolchains::package_trust::is_linux_full_build() {
        let bundled = std::path::PathBuf::from(previous.as_ref().expect("Full QA resources"))
            .join("toolchains/scratch-linux-x64");
        copy_dir_recursive(&bundled, &source).expect("copy pinned Scratch fixture");
    }
    let expected_runtime = fs::read(source.join("scratch-run")).unwrap();
    let app_data = env.root().join("app_data");
    std::env::set_var("THEMIS_RESOURCE_DIR", &resources);
    assert_eq!(preserve_bundled_toolchains_in(&app_data).unwrap(), 1);
    let preserved = app_data.join("toolchains/scratch-linux-x64");
    let receipt = read_package_receipt(&source).unwrap();
    let cached = ensure_cached_managed_toolchain(env.root(), &preserved, &receipt).unwrap();
    fs::write(preserved.join("scratch-run"), b"damaged preserved binary").unwrap();
    fs::write(cached.join("scratch-run"), b"damaged executor binary").unwrap();
    let repaired = preserve_bundled_toolchains_in(&app_data).unwrap();
    let cached_again = ensure_cached_managed_toolchain(env.root(), &preserved, &receipt).unwrap();
    match previous {
        Some(value) => std::env::set_var("THEMIS_RESOURCE_DIR", value),
        None => std::env::remove_var("THEMIS_RESOURCE_DIR"),
    }
    assert_eq!(
        repaired, 1,
        "a parseable receipt must not bless corrupted executable bytes"
    );
    assert_eq!(
        fs::read(preserved.join("scratch-run")).unwrap(),
        expected_runtime
    );
    assert_eq!(
        fs::read(cached_again.join("scratch-run")).unwrap(),
        expected_runtime
    );
}

#[tokio::test]
async fn broken_linker_is_a_judge_environment_error_not_a_student_ce() {
    use judgedesk_core::engine::{run_judge_session, JudgeSessionConfig, JudgeStreamEvent};
    use judgedesk_core::server::dto::ProfileSelection;
    let env = common::OwnedTestEnvironment::new();
    let exe = compiler_wrapper(env.root(), "-nostdlib");
    let contestants = env.root().join("contestants");
    let tests = env.root().join("tests");
    fs::create_dir_all(contestants.join("alice")).unwrap();
    fs::create_dir_all(tests.join("A/01")).unwrap();
    fs::write(
        contestants.join("alice/A.cpp"),
        "#include <iostream>\nint main(){std::cout << 42;}\n",
    )
    .unwrap();
    fs::write(tests.join("A/01/A.inp"), "").unwrap();
    fs::write(tests.join("A/01/A.out"), "42").unwrap();
    let platform = env.with_isolated_roots(|| {
        ExecutorClient::spawn_sync(&common::executor_binary_path()).unwrap()
    });
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    run_judge_session(
        JudgeSessionConfig {
            thisinh_path: contestants,
            test_path: tests,
            job_id: "linux_linker_regression".into(),
            target_contestants: vec!["alice".into()],
            target_problems: vec!["A".into()],
            problem_configs: Default::default(),
            app_data_dir: Some(env.root().join("app_data")),
            toolchain_selections: [(
                "cpp".into(),
                ProfileSelection {
                    mode: "local_path".into(),
                    local_path: Some(exe.to_string_lossy().into_owned()),
                },
            )]
            .into_iter()
            .collect(),
            cancel_flag: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            platform: Arc::new(platform),
        },
        tx,
    )
    .await;
    let mut results = Vec::new();
    while let Some(event) = rx.recv().await {
        if let JudgeStreamEvent::ProblemCompleted(result) = event {
            results.push(result.problem_result);
        }
    }
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].compile_status, "JE");
    assert!(results[0]
        .compile_error
        .as_ref()
        .unwrap()
        .contains("TOOLCHAIN_NOT_SANDBOX_COMPATIBLE"));
}
