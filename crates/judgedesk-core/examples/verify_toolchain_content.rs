//! Read-only release diagnostic: verify each package twice to measure first and
//! repeated discovery cost against the trust catalog compiled into this binary.
use judgedesk_core::toolchains::discovery::read_package_receipt;
use judgedesk_core::toolchains::package_trust::verify_managed_package;
use std::path::PathBuf;

fn main() -> Result<(), String> {
    let root = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .ok_or("Usage: verify_toolchain_content <expanded-toolchains-directory>")?;
    for pass in 1..=2 {
        for id in [
            "gcc-linux-x64",
            "python-linux-x64",
            "fpc-linux-x64",
            "temurin21-linux-x64",
            "scratch-linux-x64",
        ] {
            let package = root.join(id);
            let receipt =
                read_package_receipt(&package).ok_or_else(|| format!("Missing receipt: {id}"))?;
            let started = std::time::Instant::now();
            let indexed = verify_managed_package(&package, &receipt, false)?;
            println!(
                "{}",
                serde_json::json!({"pass":pass,"packageId":id,"indexed":indexed,"elapsedMs":started.elapsed().as_millis()})
            );
        }
    }
    Ok(())
}
