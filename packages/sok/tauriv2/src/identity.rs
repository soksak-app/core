//! 애플리케이션 식별자(docs/spec/projects.md#persistence). 식별자는 기본 설정 폴더의 이름이고 경로 항목의 파일
//! 이름이다. 진단 build 는 release 애플리케이션의 데이터를 쓰지 않도록 .dev 를 붙인다.

/// release build 의 식별자이며 번들 식별자.
pub const RELEASE_IDENTIFIER: &str = "app.soksak.tauri";

/// 이 build 의 식별자.
pub fn identity() -> &'static str {
    if cfg!(feature = "diagnostics") {
        "app.soksak.tauri.dev"
    } else {
        RELEASE_IDENTIFIER
    }
}
