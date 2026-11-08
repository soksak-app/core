//! A view sidecar send carries the original safe source generation of its own session, and neither a retired generation
//! nor the generic window boundary acquires a mounted view. The same cases run in the Go host.
use super::view_sidecar_project_test::{MountedOwner, mount};
use crate::framework::Channel;
use crate::windows::WindowData;
use std::sync::Arc;

// contract: sidecars.view-send.requires-a-safe-generation-and-its-own-surface
#[test]
fn view_sidecar_send_requires_the_original_safe_generation_and_own_session() {
    let parse = |raw: &str| {
        serde_json::from_str::<super::ViewSidecarSendRequest>(raw)
            .map_err(|error| error.to_string())
            .and_then(|request| request.check())
    };
    let valid = r#"{"source":"probe-surface","generation":1,"sidecar":"fixture-sidecar","surface":"probe-surface","body":{},"cids":[]}"#;
    assert_eq!(parse(valid), Ok(()), "{valid}");
    for raw in [
        r#"{"source":"probe-surface","sidecar":"fixture-sidecar","surface":"probe-surface","body":{},"cids":[]}"#,
        r#"{"source":"probe-surface","generation":0,"sidecar":"fixture-sidecar","surface":"probe-surface","body":{},"cids":[]}"#,
        r#"{"source":"probe-surface","generation":9007199254740992,"sidecar":"fixture-sidecar","surface":"probe-surface","body":{},"cids":[]}"#,
        r#"{"source":"probe-surface","generation":"1","sidecar":"fixture-sidecar","surface":"probe-surface","body":{},"cids":[]}"#,
        r#"{"source":"probe-surface","generation":null,"sidecar":"fixture-sidecar","surface":"probe-surface","body":{},"cids":[]}"#,
        r#"{"source":"probe-surface","generation":1,"sidecar":"fixture-sidecar","surface":"other-session","body":{},"cids":[]}"#,
    ] {
        assert!(
            parse(raw).is_err(),
            "invalid source authority accepted: {raw}"
        );
    }
}

// contract: sidecars.view-send.retired-generation-sends-nothing
#[test]
fn view_sidecar_send_never_borrows_the_successor_generation_or_mount_root() {
    let folder = crate::test_folder::Folder::new();
    let data = Arc::new(WindowData::default());
    data.view_source_events.install(Channel::new(|_| Ok(())));
    *data.root.lock().unwrap() = "/fixture/project-a".into();
    let old = mount(&data, "/fixture/project-a");
    // The private IPC packet is captured while A is valid, before the host
    // delivers it. Replacement must not reinterpret it as B's authority.
    let packet = serde_json::json!({"source":"probe-surface","generation":old.generation,"sidecar":"fixture-sidecar",
        "surface":"probe-surface","body":{"operation":"old-A"},"cids":[]});
    data.documents
        .views()
        .forget_if_current("probe-surface", &old);
    data.view_source_origins
        .end_view("probe-surface", old.generation);
    let next = mount(&data, "/fixture/project-b");
    assert_ne!(old.generation, next.generation);
    *data.root.lock().unwrap() = "/fixture/project-c".into();
    let (sidecars, read) = crate::sidecars::session_retention_test::mounted_project_probe_wire::<
        MountedOwner,
    >(folder.path());
    let result = super::view_sidecar_send(
        &data,
        &sidecars,
        &MountedOwner(data.clone()),
        serde_json::from_value(packet).unwrap(),
    );
    let outbound = read();
    assert!(
        result.is_err() && outbound.is_none(),
        "retired original IPC must reject without creating B or A session: result={result:?} actual_outbound={outbound:?}"
    );
}

// contract: sidecars.window-send.mounted-view-surface-is-refused
#[test]
fn window_sidecar_send_cannot_implicitly_acquire_a_mounted_view_generation() {
    let folder = crate::test_folder::Folder::new();
    let data = Arc::new(WindowData::default());
    data.view_source_events.install(Channel::new(|_| Ok(())));
    mount(&data, "/fixture/project-a");
    let (sidecars, read) = crate::sidecars::session_retention_test::mounted_project_probe_wire::<
        MountedOwner,
    >(folder.path());
    let body =
        serde_json::value::RawValue::from_string(r#"{"operation":"generic"}"#.into()).unwrap();
    let result = super::window_sidecar_send(
        &data,
        &sidecars,
        &MountedOwner(data.clone()),
        "fixture-sidecar",
        "probe-surface",
        &body,
        &[],
    );
    assert!(
        result
            .as_ref()
            .is_err_and(|error| error.contains("requires original view source authority")),
        "generic boundary must refuse mounted source: {result:?}"
    );
    assert!(read().is_none(), "generic boundary forwarded mounted work");
}
