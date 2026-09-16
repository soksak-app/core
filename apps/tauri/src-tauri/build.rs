fn main() {
    // 캡처 코드는 Objective-C 로 작성한다. ScreenCaptureKit 은 프레임을 delegate 객체의
    // 메서드로 전달한다.
    #[cfg(target_os = "macos")]
    {
        println!("cargo:rerun-if-changed=src/capture.m");
        cc::Build::new()
            .file("src/capture.m")
            .flag("-fobjc-arc")
            .compile("spcapture");
        // native/darwin 라이브러리는 pkg-config 의 soksak-darwin 으로 찾는다.
        pkg_config::Config::new()
            .statik(true)
            .probe("soksak-darwin")
            .expect("soksak-darwin must be built and listed in PKG_CONFIG_PATH");
        for framework in ["Cocoa", "ScreenCaptureKit", "CoreMedia", "CoreVideo"] {
            println!("cargo:rustc-link-lib=framework={framework}");
        }
    }
    tauri_build::build()
}
