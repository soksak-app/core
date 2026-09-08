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
        println!("cargo:rerun-if-changed=../../native/webview_input_darwin.m");
        println!("cargo:rerun-if-changed=../../native/webview_input_darwin.h");
        println!("cargo:rerun-if-changed=../../native/window_probe_darwin.m");
        println!("cargo:rerun-if-changed=../../native/window_probe_darwin.h");
        println!("cargo:rerun-if-changed=../../native/window_controls_darwin.m");
        println!("cargo:rerun-if-changed=../../native/window_controls_darwin.h");
        println!("cargo:rerun-if-changed=../../native/surface_layout_darwin.m");
        println!("cargo:rerun-if-changed=../../native/surface_layout_darwin.h");
        println!("cargo:rerun-if-changed=../../native/webview_geometry_darwin.m");
        println!("cargo:rerun-if-changed=../../native/webview_geometry_darwin.h");
        cc::Build::new()
            .file("../../native/webview_input_darwin.m")
            .file("../../native/window_probe_darwin.m")
            .file("../../native/window_controls_darwin.m")
            .file("../../native/surface_layout_darwin.m")
            .file("../../native/webview_geometry_darwin.m")
            .flag("-fblocks")
            .compile("spwebviewinput");
        for framework in ["Cocoa", "WebKit", "QuartzCore", "ScreenCaptureKit", "CoreMedia", "CoreVideo"] {
            println!("cargo:rustc-link-lib=framework={framework}");
        }
    }
    tauri_build::build()
}
