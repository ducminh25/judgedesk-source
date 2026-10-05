#[path = "../crates/judgedesk-core/build_support.rs"]
mod build_support;

fn main() {
    // This package declares no Cargo features; its linked core owns its own set.
    if let Err(error) = build_support::generate_identity(&[]) {
        eprintln!("{error}");
        std::process::exit(1);
    }
    tauri_build::build()
}
