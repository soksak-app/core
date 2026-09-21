use std::env;

fn main() {
    let os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();

    if os == "macos" {
        println!("cargo:rerun-if-changed=src/platform/darwin/frame.m");
        println!("cargo:rerun-if-changed=src/platform/darwin/frame.h");
        cc::Build::new()
            .file("src/platform/darwin/frame.m")
            .flag("-fobjc-arc")
            .flag("-Wall")
            .warnings_into_errors(true)
            .include("src/platform/darwin")
            .compile("frame");

        // Link frameworks and objc
        println!("cargo:rustc-link-lib=objc");
        println!("cargo:rustc-link-lib=framework=IOSurface");
        println!("cargo:rustc-link-lib=framework=CoreGraphics");
        println!("cargo:rustc-link-lib=framework=CoreText");
        println!("cargo:rustc-link-lib=framework=CoreFoundation");
        println!("cargo:rustc-link-lib=framework=Foundation");
    }
}
