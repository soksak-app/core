fn main() {
    // 빌드 스크립트는 호스트 플랫폼에서 실행되므로 대상 운영체제는 환경 변수로 확인한다.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        // native/darwin 라이브러리는 pkg-config 의 soksak-darwin 으로 찾는다.
        pkg_config::Config::new()
            .statik(true)
            .probe("soksak-darwin")
            .expect("soksak-darwin must be built and listed in PKG_CONFIG_PATH");
    }
}
