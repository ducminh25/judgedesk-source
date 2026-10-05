mod build_support;

fn main() {
    const FEATURES: &[&str] = &[
        #[cfg(feature = "default")]
        "default",
        #[cfg(feature = "test-server")]
        "test-server",
    ];
    if let Err(error) = build_support::generate_identity(FEATURES) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
