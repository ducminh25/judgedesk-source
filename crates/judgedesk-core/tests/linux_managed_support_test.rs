use judgedesk_core::toolchains::linux_managed::{compiler_support_args, compiler_visible_path};
use judgedesk_native_executor::protocol::linux_sandbox_paths::TOOLCHAIN_ROOT;
use std::fs;

#[test]
fn linux_full_pins_sysroot_and_helpers_without_static_glibc_linkage() {
    let root = std::env::temp_dir().join(format!("judgedesk-linux-full-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(root.join("sysroot")).unwrap();
    fs::create_dir(root.join("bin")).unwrap();
    let result = compiler_support_args("cpp", &root, true).unwrap();
    assert!(result.contains(&format!("--sysroot={}", root.join("sysroot").display())));
    assert!(result.contains(&"-static-libstdc++".to_owned()));
    assert!(result.contains(&"-static-libgcc".to_owned()));
    assert!(!result.contains(&"-static".to_owned()));
    let pch = compiler_support_args("cpp", &root, false).unwrap();
    assert!(!pch.iter().any(|flag| flag.starts_with("-static")));
    let pascal = compiler_support_args("pascal", &root, true).unwrap();
    assert!(pascal.contains(&format!(
        "-k--sysroot={}",
        std::path::Path::new(TOOLCHAIN_ROOT)
            .join("sysroot")
            .display()
    )));
    assert!(pascal.contains(&format!(
        "-XR{}",
        std::path::Path::new(TOOLCHAIN_ROOT)
            .join("sysroot")
            .display()
    )));
    assert!(compiler_support_args("java", &root, true).is_err());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn fpc_units_use_short_granted_view_and_reject_root_escape() {
    let root = std::env::temp_dir()
        .join("deep long directory kiểm thử")
        .join("x".repeat(100));
    let units = root.join("lib/fpc/3.2.2/units/x86_64-linux/rtl");
    let visible = compiler_visible_path(&root, &units).unwrap();
    assert_eq!(
        visible,
        std::path::Path::new(TOOLCHAIN_ROOT).join("lib/fpc/3.2.2/units/x86_64-linux/rtl")
    );
    assert!(visible.as_os_str().len() < 100);
    assert!(compiler_visible_path(&root, &root.join("../outside")).is_err());
    assert!(compiler_visible_path(&root, std::path::Path::new("/outside")).is_err());
}

#[test]
fn missing_full_sysroot_is_a_configuration_error_without_host_fallback() {
    let missing = std::env::temp_dir().join(format!("judgedesk-missing-{}", uuid::Uuid::new_v4()));
    assert!(compiler_support_args("cpp", &missing, true).is_err());
}
