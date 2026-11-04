fn main() {
    // The build script runs on the host platform, so the target operating system is read from an environment variable.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        // The native/darwin library is found through the pkg-config package soksak-darwin.
        let library = pkg_config::Config::new()
            .statik(true)
            .probe("soksak-darwin")
            .expect("soksak-darwin must be built and listed in PKG_CONFIG_PATH");
        // cargo does not track the static library that it links, so a change of the library must trigger a relink.
        for directory in &library.link_paths {
            println!(
                "cargo:rerun-if-changed={}",
                directory.join("libsoksak-darwin.a").display()
            );
        }
    }
}
