use judgedesk_core::toolchains::package_import::{
    commit_verified_directory, recover_previous_directory,
};
use std::fs;

#[cfg(not(target_os = "linux"))]
#[test]
fn marker_write_failure_cleans_the_stage_and_preserves_previous_cache() {
    use judgedesk_core::toolchains::discovery::{
        ensure_cached_managed_toolchain, managed_cache_id, ToolchainPackageReceipt,
    };
    let root =
        std::env::temp_dir().join(format!("judgedesk-marker-failure-{}", uuid::Uuid::new_v4()));
    let source = root.join("source");
    let platform = root.join("platform");
    fs::create_dir_all(source.join(".judgedesk-import-complete")).unwrap();
    fs::write(source.join("payload"), b"new data").unwrap();
    let receipt = ToolchainPackageReceipt {
        schema_version: 1,
        package_id: "import-test-package".into(),
        version: "1.0.0".into(),
        archive_sha256: "a".repeat(64),
        entrypoint_component_id: "runtime".into(),
        components: vec![],
    };
    let destination = platform.join("toolchains").join(managed_cache_id(
        &receipt.package_id,
        &receipt.version,
        &receipt.archive_sha256,
    ));
    fs::create_dir_all(&destination).unwrap();
    fs::write(destination.join("previous-evidence"), b"keep me").unwrap();
    let error = ensure_cached_managed_toolchain(&platform, &source, &receipt).unwrap_err();
    assert!(error.contains("failed to write import marker"), "{error}");
    assert_eq!(
        fs::read(destination.join("previous-evidence")).unwrap(),
        b"keep me"
    );
    assert!(!fs::read_dir(platform.join("toolchains"))
        .unwrap()
        .any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains("staging")));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn committing_a_verified_stage_replaces_the_old_tree_and_cleans_backup() {
    let root = std::env::temp_dir().join(format!("judgedesk-import-{}", uuid::Uuid::new_v4()));
    let destination = root.join("package");
    let staged = root.join("staged");
    fs::create_dir_all(&destination).unwrap();
    fs::create_dir(&staged).unwrap();
    fs::write(destination.join("value"), b"old").unwrap();
    fs::write(staged.join("value"), b"verified-new").unwrap();
    commit_verified_directory(&staged, &destination).unwrap();
    assert_eq!(
        fs::read(destination.join("value")).unwrap(),
        b"verified-new"
    );
    assert!(!root.join("package.previous").exists());
    assert!(!staged.exists());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn recovering_an_interrupted_activation_restores_the_previous_package() {
    let root = std::env::temp_dir().join(format!(
        "judgedesk-import-recovery-{}",
        uuid::Uuid::new_v4()
    ));
    let destination = root.join("package");
    fs::create_dir_all(root.join("package.previous")).unwrap();
    fs::write(root.join("package.previous/value"), b"previous").unwrap();
    recover_previous_directory(&destination).unwrap();
    assert_eq!(fs::read(destination.join("value")).unwrap(), b"previous");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn missing_or_unrelated_staging_trees_cannot_remove_the_current_package() {
    let root =
        std::env::temp_dir().join(format!("judgedesk-import-invalid-{}", uuid::Uuid::new_v4()));
    let destination = root.join("package");
    fs::create_dir_all(root.join("outside/staged")).unwrap();
    fs::create_dir(&destination).unwrap();
    fs::write(destination.join("value"), b"keep").unwrap();
    assert!(commit_verified_directory(&root.join("outside/staged"), &destination).is_err());
    assert!(commit_verified_directory(&root.join("missing"), &destination).is_err());
    assert_eq!(fs::read(destination.join("value")).unwrap(), b"keep");
    fs::remove_dir_all(root).unwrap();
}
