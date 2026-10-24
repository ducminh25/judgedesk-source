use judgedesk_core::toolchains::content_integrity::verify_content_index;
use judgedesk_core::toolchains::discovery::{compute_binary_sha256_hex, read_package_receipt};
use serde_json::json;
use std::fs;
use std::path::PathBuf;

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("judgedesk-content-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("bin")).unwrap();
        fs::write(root.join("bin/runtime"), b"valid-runtime").unwrap();
        Self(root)
    }
    fn index(&self) -> String {
        let metadata = fs::metadata(self.0.join("bin/runtime")).unwrap();
        #[cfg(unix)]
        let executable = {
            use std::os::unix::fs::PermissionsExt;
            metadata.permissions().mode() & 0o111 != 0
        };
        #[cfg(not(unix))]
        let executable = false;
        let index = json!({"schemaVersion":1,"entries":[
            {"path":"bin","kind":"directory"},
            {"path":"bin/runtime","kind":"file","sizeBytes":metadata.len(),
             "executable":executable,"sha256":compute_binary_sha256_hex(&self.0.join("bin/runtime")).unwrap()}
        ]});
        fs::write(
            self.0.join(".judgedesk-content.json"),
            serde_json::to_vec(&index).unwrap(),
        )
        .unwrap();
        compute_binary_sha256_hex(&self.0.join(".judgedesk-content.json")).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn content_hashes_keep_standard_sha256_vectors_across_implementations() {
    let fixture = Fixture::new();
    for (input, expected) in [
        (
            Vec::new(),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        ),
        (
            b"abc".to_vec(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        ),
        (
            vec![b'a'; 1_000_000],
            "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
        ),
    ] {
        fs::write(fixture.0.join("bin/runtime"), input).unwrap();
        assert_eq!(
            compute_binary_sha256_hex(&fixture.0.join("bin/runtime")).unwrap(),
            expected
        );
    }
}

#[test]
fn indexed_package_accepts_exact_content_and_rejects_same_size_tampering() {
    let fixture = Fixture::new();
    let digest = fixture.index();
    assert!(verify_content_index(&fixture.0, &digest, false).is_ok());
    fs::write(fixture.0.join("bin/runtime"), b"other-runtime").unwrap();
    assert!(verify_content_index(&fixture.0, &digest, false).is_err());
}

#[test]
fn rapid_same_size_rewrites_are_never_trusted_from_metadata_alone() {
    let fixture = Fixture::new();
    let digest = fixture.index();
    for _ in 0..32 {
        fs::write(fixture.0.join("bin/runtime"), b"valid-runtime").unwrap();
        assert!(verify_content_index(&fixture.0, &digest, false).is_ok());
        fs::write(fixture.0.join("bin/runtime"), b"other-runtime").unwrap();
        assert!(verify_content_index(&fixture.0, &digest, false).is_err());
    }
}

#[test]
fn self_reported_index_cannot_replace_the_trusted_digest() {
    let fixture = Fixture::new();
    let trusted = fixture.index();
    fs::write(fixture.0.join("bin/runtime"), b"malicious-runtime").unwrap();
    let replacement = fixture.index();
    assert_ne!(trusted, replacement);
    assert!(verify_content_index(&fixture.0, &trusted, false).is_err());
}

#[test]
fn extra_files_and_missing_files_are_not_ready() {
    let fixture = Fixture::new();
    let digest = fixture.index();
    fs::write(fixture.0.join("extra"), b"not-in-index").unwrap();
    assert!(verify_content_index(&fixture.0, &digest, false).is_err());
    fs::remove_file(fixture.0.join("extra")).unwrap();
    fs::remove_file(fixture.0.join("bin/runtime")).unwrap();
    assert!(verify_content_index(&fixture.0, &digest, false).is_err());
}

#[test]
fn import_marker_is_only_permitted_in_an_executor_cache() {
    let fixture = Fixture::new();
    let digest = fixture.index();
    fs::write(fixture.0.join(".judgedesk-import-complete"), b"marker").unwrap();
    assert!(verify_content_index(&fixture.0, &digest, false).is_err());
    assert!(verify_content_index(&fixture.0, &digest, true).is_ok());
}

#[test]
fn receipt_package_identity_cannot_escape_the_import_directory() {
    let fixture = Fixture::new();
    let receipt_path = fixture.0.join(".judgedesk-package.json");
    for id in ["../../outside", "/absolute", "bad\\path", ".hidden"] {
        fs::write(
            &receipt_path,
            serde_json::to_vec(&json!({
                "schemaVersion":1,"packageId":id,"version":"1.0",
                "archiveSha256":"a".repeat(64),"entrypointComponentId":"runtime","components":[]
            }))
            .unwrap(),
        )
        .unwrap();
        assert!(
            read_package_receipt(&fixture.0).is_none(),
            "unsafe receipt accepted: {id}"
        );
    }
}

#[cfg(unix)]
#[test]
fn replacing_an_inode_with_preserved_mtime_invalidates_verified_content() {
    let fixture = Fixture::new();
    let digest = fixture.index();
    assert!(verify_content_index(&fixture.0, &digest, false).is_ok());
    let original = fixture.0.join("bin/runtime");
    let modified = fs::metadata(&original).unwrap().modified().unwrap();
    let replacement = fixture.0.join("replacement");
    fs::write(&replacement, b"other-runtime").unwrap();
    fs::File::open(&replacement)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(modified))
        .unwrap();
    fs::rename(replacement, original).unwrap();
    assert!(verify_content_index(&fixture.0, &digest, false).is_err());
}

#[cfg(unix)]
#[test]
fn mode_drift_and_symbolic_links_are_rejected() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let fixture = Fixture::new();
    let digest = fixture.index();
    fs::set_permissions(
        fixture.0.join("bin/runtime"),
        fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    assert!(verify_content_index(&fixture.0, &digest, false).is_err());
    fs::remove_file(fixture.0.join("bin/runtime")).unwrap();
    symlink("/etc/passwd", fixture.0.join("bin/runtime")).unwrap();
    assert!(verify_content_index(&fixture.0, &digest, false).is_err());
}

#[test]
fn receipt_reader_rejects_oversized_documents() {
    let fixture = Fixture::new();
    let mut receipt = serde_json::to_vec(&json!({"schemaVersion":1,"packageId":"fixture-linux-x64","version":"1.0","archiveSha256":"a".repeat(64),"entrypointComponentId":"runtime","components":[]})).unwrap();
    receipt.resize(16 * 1024 + 1, b' ');
    fs::write(fixture.0.join(".judgedesk-package.json"), receipt).unwrap();
    assert!(read_package_receipt(&fixture.0).is_none());
}
#[cfg(unix)]
#[test]
fn receipt_reader_rejects_symbolic_links() {
    let fixture = Fixture::new();
    let target = fixture.0.join("receipt-target");
    fs::write(&target, serde_json::to_vec(&json!({"schemaVersion":1,"packageId":"fixture-linux-x64","version":"1.0","archiveSha256":"a".repeat(64),"entrypointComponentId":"runtime","components":[]})).unwrap()).unwrap();
    std::os::unix::fs::symlink(&target, fixture.0.join(".judgedesk-package.json")).unwrap();
    assert!(read_package_receipt(&fixture.0).is_none());
}
#[test]
fn managed_cache_identity_separates_linux_package_contents() {
    use judgedesk_core::toolchains::discovery::managed_cache_id;
    let a = managed_cache_id("gcc-linux-x64", "14.2.0", &"a".repeat(64));
    let b = managed_cache_id("gcc-linux-x64", "14.2.0", &"b".repeat(64));
    if cfg!(target_os = "linux") {
        assert_ne!(a, b);
        assert!(a.ends_with(&"a".repeat(64)));
    } else {
        assert_eq!(a, "gcc-linux-x64_14.2.0");
        assert_eq!(a, b);
    }
}

#[cfg(target_os = "linux")]
#[test]
fn broken_installed_package_is_visible_and_does_not_select_another_copy() {
    use judgedesk_core::toolchains::discovery::{
        find_managed_toolchain_in, managed_package_name_for,
    };
    let fixture = Fixture::new();
    let package = fixture.0.join(managed_package_name_for("cpp"));
    fs::create_dir_all(&package).unwrap();
    fs::write(package.join(".judgedesk-package.json"), b"broken").unwrap();
    let found = find_managed_toolchain_in(&fixture.0, "cpp")
        .expect("corrupt selected package must remain visible");
    assert!(!found.ready);
    assert_eq!(found.package_root.as_ref(), Some(&package));
    assert!(found
        .diagnostic
        .unwrap()
        .contains("MANAGED_PACKAGE_CORRUPT"));
}
