fn main() {
    // 빌드 스크립트는 호스트 플랫폼에서 실행되므로 대상 운영체제는 환경 변수로 확인한다.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        // native/darwin 라이브러리는 pkg-config 의 soksak-darwin 으로 찾는다.
        let library = pkg_config::Config::new()
            .statik(true)
            .probe("soksak-darwin")
            .expect("soksak-darwin must be built and listed in PKG_CONFIG_PATH");
        // cargo 는 링크하는 정적 라이브러리를 추적하지 않으므로 라이브러리가 바뀌면 다시 링크하게 한다.
        for directory in &library.link_paths {
            println!(
                "cargo:rerun-if-changed={}",
                directory.join("libsoksak-darwin.a").display()
            );
        }
    }
}
