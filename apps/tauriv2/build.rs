fn main() {
    #[cfg(target_os = "macos")]
    {
        // native/darwin 라이브러리는 pkg-config 의 soksak-darwin 으로 찾는다.
        pkg_config::Config::new()
            .statik(true)
            .probe("soksak-darwin")
            .expect("soksak-darwin must be built and listed in PKG_CONFIG_PATH");
    }
    tauri_build::build()
}
