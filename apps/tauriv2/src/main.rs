// soksak 워크벤치를 Tauri v2 애플리케이션으로 실행한다. 호스트 기능은
// soksak-host-tauriv2 가 제공한다.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// 표면 웹뷰가 문서보다 먼저 실행하는 스크립트. 프론트엔드 배치 단계가 생성한다.
const BACKGROUND: &str = include_str!("frontend/background.js");

fn main() {
    soksak_host_tauriv2::run(tauri::generate_context!(), BACKGROUND);
}
