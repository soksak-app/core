fn main() {
    // The capture is written in Objective-C: the frames arrive as a message, and
    // a message needs an object to arrive at.
    #[cfg(target_os = "macos")]
    {
        println!("cargo:rerun-if-changed=src/capture.m");
        cc::Build::new()
            .file("src/capture.m")
            .flag("-fobjc-arc")
            .compile("spcapture");
        for framework in ["Cocoa", "ScreenCaptureKit", "CoreMedia", "CoreVideo"] {
            println!("cargo:rustc-link-lib=framework={framework}");
        }
    }
    tauri_build::build()
}
