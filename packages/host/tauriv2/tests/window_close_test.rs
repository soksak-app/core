//! 닫히는 창의 논리 표면과 그 문서 영역, 그림 영역을 닫는 순서와 실패 보고, 닫히는 창의 네이티브 주소 사용을
//! 검사한다.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use soksak_host_tauriv2::documents::Documents;
use soksak_host_tauriv2::exposure::native_failure;
use soksak_host_tauriv2::images::Images;
use soksak_host_tauriv2::surfaces::{close_window_surfaces, WindowNative};
use soksak_host_tauriv2::windows::{use_owner, MainStep, NativeFailure};

fn key(surface: &str, name: &str) -> (String, String) {
    (surface.to_string(), name.to_string())
}

// contract: window-close.surfaces.closes-regions-then-surface
#[test]
fn closing_a_window_closes_each_surface_after_its_regions() {
    let documents = Documents::default();
    let images = Images::default();
    for (k, handle) in [(key("tab-1", "page"), 11), (key("tab-2", "page"), 21)] {
        documents.reserve(&k).unwrap();
        assert!(documents.set(&k, handle));
    }
    // 만드는 중인 문서 영역은 닫을 핸들이 없다.
    documents.reserve(&key("tab-2", "pending")).unwrap();
    images
        .reserve(&key("tab-1", "view"), "owner", "sidecar")
        .unwrap();
    assert!(images.set(&key("tab-1", "view"), 12));
    let surfaces = HashMap::from([("tab-2".to_string(), 200), ("tab-1".to_string(), 100)]);
    let mut closed = Vec::new();
    close_window_surfaces(surfaces, &documents, &images, &mut |native| {
        closed.push(native);
        Ok(())
    })
    .unwrap();
    assert_eq!(
        closed,
        vec![
            WindowNative::Document(11),
            WindowNative::Image(12),
            WindowNative::Surface(100),
            WindowNative::Document(21),
            WindowNative::Surface(200),
        ]
    );
    assert!(
        documents.names().is_empty(),
        "the closed surfaces keep document names"
    );
    assert!(
        documents.reserve(&key("tab-2", "pending")).is_ok(),
        "the closed surface keeps its pending document name"
    );
    assert!(
        images.remove_surface("tab-1").is_empty(),
        "the closed surface keeps its images"
    );
}

// contract: window-close.surfaces.reports-every-failure
#[test]
fn closing_a_window_reports_every_failure_and_closes_the_rest() {
    let documents = Documents::default();
    let images = Images::default();
    documents.reserve(&key("tab-1", "page")).unwrap();
    assert!(documents.set(&key("tab-1", "page"), 11));
    let surfaces = HashMap::from([("tab-1".to_string(), 100), ("tab-2".to_string(), 200)]);
    let mut closed = Vec::new();
    let result = close_window_surfaces(surfaces, &documents, &images, &mut |native| {
        closed.push(native);
        match native {
            WindowNative::Document(_) => Err("document failed".into()),
            WindowNative::Surface(200) => Err("surface failed".into()),
            _ => Ok(()),
        }
    });
    assert_eq!(
        closed,
        vec![
            WindowNative::Document(11),
            WindowNative::Surface(100),
            WindowNative::Surface(200),
        ]
    );
    let error = result.unwrap_err();
    assert!(
        error.contains("document failed") && error.contains("surface failed"),
        "{error}"
    );
}

/// 시험의 메인 스레드. 다른 스레드가 보낸 작업은 메인 스레드가 다음 단계를 실행하기 전에 차례대로 실행한다.
#[derive(Default)]
struct FakeMain {
    pending: Mutex<Vec<MainStep>>,
}

impl FakeMain {
    fn run(&self, step: MainStep) -> Result<(), String> {
        let pending = std::mem::take(&mut *self.pending.lock().unwrap());
        for task in pending {
            task();
        }
        step();
        Ok(())
    }
}

/// 시험의 창. 닫기는 runtime 처럼 메인 스레드에서 창을 닫는다.
struct FakeWindow {
    closed: AtomicBool,
    /// 주소를 읽을 때 메인 스레드에 이 창의 닫기를 보낸다.
    close_on_read: AtomicBool,
}

const FAKE_HANDLE: usize = 0x5157;

fn fake_use(main: &Arc<FakeMain>, window: &Arc<FakeWindow>) -> Result<String, NativeFailure> {
    let queue = main.clone();
    let native = window.clone();
    use_owner(
        window.clone(),
        |step| main.run(step),
        move |window: &Arc<FakeWindow>| {
            if window.closed.load(Ordering::SeqCst) {
                return Ok(None);
            }
            if window.close_on_read.swap(false, Ordering::SeqCst) {
                let closed = window.clone();
                queue.pending.lock().unwrap().push(Box::new(move || {
                    closed.closed.store(true, Ordering::SeqCst)
                }));
            }
            Ok(Some(FAKE_HANDLE))
        },
        move |handle| {
            // 네이티브 코드는 받은 창에 메시지를 보낸다. 닫힌 창의 주소를 받으면 그 창에 메시지를 보낸다.
            if native.closed.load(Ordering::SeqCst) {
                return Err(format!(
                    "native code messaged the closed window {handle:#x}"
                ));
            }
            Ok(format!("facts of {handle:#x}"))
        },
    )
}

// 창의 네이티브 주소는 그 주소를 쓰는 메인 스레드 단계에서 읽는다. 읽은 뒤 메인 스레드가 처리한 닫기는
// 그 단계 뒤에 오고, 단계 전에 닫힌 창은 네이티브 코드에 넘기지 않고 Closed 로 답한다.
// contract: window-close.native-window.used-in-reading-step
#[test]
fn a_close_after_the_handle_read_does_not_reach_native_code() {
    let main = Arc::new(FakeMain::default());
    let window = Arc::new(FakeWindow {
        closed: AtomicBool::new(false),
        close_on_read: AtomicBool::new(true),
    });
    assert_eq!(fake_use(&main, &window), Ok("facts of 0x5157".to_string()));
    assert_eq!(fake_use(&main, &window), Err(NativeFailure::Closed));
    assert!(window.closed.load(Ordering::SeqCst));
    // 닫힌 창의 요청은 없는 창의 오류 1003 으로 끝난다.
    let failure = native_failure("w2", -32603)(NativeFailure::Closed);
    assert_eq!(
        (failure.code, failure.message.as_str()),
        (1003, r#"window "w2" does not exist"#)
    );
}
