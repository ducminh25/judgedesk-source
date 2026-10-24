use std::{env, fs, path::PathBuf, process::Command};

pub fn generate_identity(features: &[&str]) -> Result<(), Box<dyn std::error::Error>> {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR")?);
    let root = if manifest.ends_with("src-tauri") {
        manifest.parent().ok_or("missing application root")?
    } else {
        manifest
            .parent()
            .and_then(|p| p.parent())
            .ok_or("missing application root")?
    };
    let target = env::var("TARGET")?;
    if manifest.ends_with("src-tauri")
        && env::var("PROFILE")? == "release"
        && env::var("JUDGEDESK_BUILD_MODE").as_deref() != Ok("packaged")
    {
        return Err("BUILD_IDENTITY: Tauri release builds require packaged provenance; use scripts/build-packaged.js".into());
    }
    // The owner supplies compiler-selected features. Cargo leaves unrelated parent
    // CARGO_FEATURE_* variables in the environment, including disabled features.
    let features = features.join(",");
    for name in [
        "JUDGEDESK_BUILD_MODE",
        "JUDGEDESK_APP_VERSION",
        "JUDGEDESK_GIT_COMMIT",
        "JUDGEDESK_BUILD_SOURCE_STATE",
        "JUDGEDESK_BUILD_NUMBER",
        "JUDGEDESK_BUILD_TIMESTAMP",
        "SOURCE_DATE_EPOCH",
        "JUDGEDESK_LINUX_EDITION",
    ] {
        println!("cargo:rerun-if-env-changed={name}");
    }
    println!(
        "cargo:rerun-if-changed={}",
        root.join("package.json").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        root.join("scripts/build-metadata.js").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        root.join("scripts/build-server-target.js").display()
    );
    let out_dir = PathBuf::from(env::var("OUT_DIR")?);
    if env::var("JUDGEDESK_BUILD_MODE").as_deref() == Ok("packaged") {
        let versions = Command::new("node")
            .arg(root.join("scripts/check-release-version.js"))
            .current_dir(root)
            .output()?;
        if !versions.status.success() {
            return Err(format!(
                "BUILD_IDENTITY application version gate failed: {}",
                String::from_utf8_lossy(&versions.stderr)
            )
            .into());
        }
    }
    // Deliberately absent: Cargo refreshes Git/dirty/untracked identity on every invocation,
    // including linked worktrees/ref changes. Never restore a stale metadata fixture binary.
    println!(
        "cargo:rerun-if-changed={}",
        out_dir.join("refresh-build-identity").display()
    );
    let output = Command::new("node")
        .arg(root.join("scripts/build-metadata.js"))
        .arg(root)
        .arg(target)
        .arg(features)
        .output()?;
    if !output.status.success() {
        return Err(format!(
            "BUILD_IDENTITY generation failed: {}",
            String::from_utf8_lossy(&output.stderr)
        )
        .into());
    }
    fs::write(out_dir.join("build_identity.rs"), output.stdout)?;
    Ok(())
}
