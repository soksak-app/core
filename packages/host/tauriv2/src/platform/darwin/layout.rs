//! 표면 배치 트랜잭션.

use std::ffi::{c_char, c_void, CStr};

use block2::{Block, RcBlock};
use tauri::webview::PlatformWebview;

use super::super::Handle;

/// 창의 표면 배치 트랜잭션 ticket 을 시작한다. 시작 허용 여부는 ready 에 전달한다.
pub fn begin(window: Handle, ticket: u64, ready: Box<dyn Fn(bool)>) {
    extern "C" {
        fn surfaceLayoutBegin(owner: *mut c_void, ticket: u64, ready: &Block<dyn Fn(i32)>);
    }
    let ready = RcBlock::new(move |allowed: i32| ready(allowed != 0));
    unsafe { surfaceLayoutBegin(window as *mut c_void, ticket, &ready) }
}

/// 표면 배치 트랜잭션 ticket 을 확정하고 확정 여부를 반환한다.
pub fn commit(window: Handle, ticket: u64) -> bool {
    extern "C" {
        fn surfaceLayoutCommit(owner: *mut c_void, ticket: u64) -> bool;
    }
    unsafe { surfaceLayoutCommit(window as *mut c_void, ticket) }
}

/// 창의 진행 중인 표면 배치 트랜잭션을 취소한다.
pub fn cancel(window: Handle) {
    extern "C" {
        fn surfaceLayoutCancel(owner: *mut c_void);
    }
    unsafe { surfaceLayoutCancel(window as *mut c_void) }
}

/// 열린 배치를 커밋하기 전에 앱 문서의 표시 준비를 확인한다.
pub fn after_presentation(view: &PlatformWebview, done: Box<dyn Fn()>) {
    extern "C" {
        fn surfaceLayoutAfterPresentation(view: *mut c_void, done: &Block<dyn Fn()>);
    }
    let done = RcBlock::new(done);
    unsafe { surfaceLayoutAfterPresentation(view.inner().cast(), &done) }
}

/// 창에 열린 표면 배치 트랜잭션이 없는 상태에서 메인 문서와 표시 중인 앱 문서의 렌더링 완료를 확인한
/// 뒤 그 화면의 표시 시각(ms)으로 done 을 호출한다.
pub fn after_settled(view: &PlatformWebview, done: Box<dyn Fn(Result<f64, String>)>) {
    extern "C" {
        fn surfaceLayoutAfterSettled(view: *mut c_void, done: &Block<dyn Fn(f64, *const c_char)>);
    }
    let done = RcBlock::new(move |displayed: f64, error: *const c_char| {
        if error.is_null() {
            done(Ok(displayed));
        } else {
            let message = unsafe { CStr::from_ptr(error) }
                .to_string_lossy()
                .into_owned();
            done(Err(message));
        }
    });
    unsafe { surfaceLayoutAfterSettled(view.inner().cast(), &done) }
}
