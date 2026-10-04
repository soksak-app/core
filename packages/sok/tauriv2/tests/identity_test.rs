//! 애플리케이션 식별자(docs/spec/projects.md#persistence)를 검사한다.

use soksak_sok::identity::identity;

// contract: cli.identity.build-identifier
#[test]
fn the_build_identifier_follows_the_build() {
    if cfg!(feature = "diagnostics") {
        assert_eq!(identity(), "app.soksak.tauri.dev");
    } else {
        assert_eq!(identity(), "app.soksak.tauri");
    }
}
