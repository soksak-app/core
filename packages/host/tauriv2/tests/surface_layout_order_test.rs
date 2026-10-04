//! 표면 동기화가 배치를 시작하고 창 덮개를 놓고 표면을 맞추는 순서와, 실패할 때 시작한 배치를 남기지 않는지 검사한다.

use std::cell::RefCell;

use soksak_host_tauriv2::surfaces::run_layout;

fn run(
    overlays: Result<(), String>,
    steps: Result<u32, String>,
) -> (Result<u32, String>, Vec<&'static str>) {
    let calls = RefCell::new(Vec::new());
    let result = run_layout(
        || {
            calls.borrow_mut().push("overlays");
            overlays
        },
        || {
            calls.borrow_mut().push("begin");
            Ok(())
        },
        || {
            calls.borrow_mut().push("titlebar");
            Ok(())
        },
        |_: &()| {
            calls.borrow_mut().push("steps");
            steps
        },
        |()| {
            calls.borrow_mut().push("restore");
            Ok(())
        },
        || calls.borrow_mut().push("cancel"),
    );
    (result.map(|(value, ())| value), calls.into_inner())
}

// 배치를 시작한 뒤의 실패는 그 배치를 취소한다. 배치가 시작되지 않았다면 취소할 것이 없다.
fn begun_layout_ends(calls: &[&str]) -> bool {
    !calls.contains(&"begin") || calls.contains(&"cancel") || calls.contains(&"steps")
}

// contract: surfaces.sync.failure-leaves-no-begun-layout
#[test]
fn a_refused_window_overlay_leaves_no_begun_layout() {
    let (result, calls) = run(Err("overlay refused".into()), Ok(1));
    assert_eq!(result, Err("overlay refused".to_string()));
    assert!(begun_layout_ends(&calls), "calls {calls:?}");
    assert!(!calls.contains(&"steps"), "calls {calls:?}");
}

// contract: surfaces.sync.failure-leaves-no-begun-layout
#[test]
fn a_failed_surface_step_cancels_the_begun_layout() {
    let (result, calls) = run(Ok(()), Err("surface failed".into()));
    assert_eq!(result, Err("surface failed".to_string()));
    assert_eq!(calls.last(), Some(&"cancel"), "calls {calls:?}");
}

// contract: surfaces.sync.failure-leaves-no-begun-layout
#[test]
fn a_successful_sync_does_not_cancel() {
    let (result, calls) = run(Ok(()), Ok(7));
    assert_eq!(result, Ok(7));
    assert!(!calls.contains(&"cancel"), "calls {calls:?}");
}

// contract: surfaces.sync.titlebar.set-in-begun-layout
#[test]
fn the_titlebar_is_set_in_the_begun_layout_before_the_surfaces() {
    let calls = RefCell::new(Vec::new());
    let layout = |titlebar: Result<f64, String>,
                  surfaces: Result<f64, String>,
                  restore: Result<(), String>| {
        run_layout(
            || {
                calls.borrow_mut().push("overlays");
                Ok(())
            },
            || {
                calls.borrow_mut().push("begin");
                Ok(())
            },
            || {
                calls.borrow_mut().push("titlebar");
                titlebar
            },
            |row: &f64| {
                calls.borrow_mut().push("surfaces");
                surfaces.map(|value| value + row)
            },
            |_row: f64| {
                calls.borrow_mut().push("restore");
                restore
            },
            || calls.borrow_mut().push("cancel"),
        )
    };
    assert_eq!(
        layout(Ok(54.0), Ok(1.0), Ok(())),
        Ok((55.0, 54.0)),
        "the surfaces step reads the title bar answer and the layout returns it"
    );
    assert_eq!(
        calls.take(),
        vec!["overlays", "begin", "titlebar", "surfaces"]
    );
    let refused = "the window has no standard buttons or content view for a title bar";
    assert_eq!(
        layout(Err(refused.into()), Ok(1.0), Ok(())),
        Err(refused.to_string())
    );
    assert_eq!(
        calls.take(),
        vec!["overlays", "begin", "titlebar", "cancel"]
    );
    assert_eq!(
        layout(Ok(54.0), Err("surface failed".into()), Ok(())),
        Err("surface failed".to_string())
    );
    assert_eq!(
        calls.take(),
        vec!["overlays", "begin", "titlebar", "surfaces", "restore", "cancel"]
    );
    assert_eq!(
        layout(
            Ok(54.0),
            Err("surface failed".into()),
            Err("restore failed".into())
        ),
        Err("surface failed; restoring the title bar: restore failed".to_string())
    );
}
