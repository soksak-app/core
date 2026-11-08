//! A window sidecar request admitted while no view is mounted keeps its absence ticket only for its own request and
//! cannot enter a view that mounts while the sidecar process starts. The same cases run in the Go host.
use super::register_view_source_with_start;
use super::view_sidecar_project_test::{MountedOwner, mount, start};
use crate::framework::Channel;
use crate::windows::WindowData;
use std::sync::Arc;

#[test]
fn window_sidecar_admission_cannot_enter_a_view_mounted_during_process_start() {
    let executable = crate::test_folder::Folder::new();
    let config = crate::test_folder::Folder::new();
    let (release, gate) = std::sync::mpsc::channel();
    let (received, service) =
        crate::sidecars::session_retention_test::service_with_hello_gate(config.path(), Some(gate));
    let sidecars = Arc::new(crate::sidecars::session_retention_test::declared::<
        MountedOwner,
    >(executable.path(), config.path()));
    let data = Arc::new(WindowData::default());
    data.view_source_events.install(Channel::new(|_| Ok(())));
    *data.root.lock().unwrap() = "/fixture/project-a".into();
    let send_data = data.clone();
    let send_sidecars = sidecars.clone();
    let sender = std::thread::spawn(move || {
        let body =
            serde_json::value::RawValue::from_string(r#"{"operation":"background-A"}"#.into())
                .unwrap();
        super::window_sidecar_send(
            &send_data,
            &send_sidecars,
            &MountedOwner(send_data.clone()),
            "fixture-sidecar",
            "probe-surface",
            &body,
            &[],
        )
    });
    let hello = received.recv_timeout(std::time::Duration::from_secs(5));
    let entered = hello
        .as_ref()
        .is_ok_and(|message| message["operation"] == "hello");
    if entered {
        mount(&data, "/fixture/project-b");
    }
    release.send(()).unwrap();
    let result = sender.join().unwrap();
    assert_eq!(
        data.view_source_origins.pending_background_calls(),
        0,
        "completed/refused request retained its ticket"
    );
    let retained =
        crate::sidecars::session_retention_test::has_surface_session(&sidecars, "probe-surface");
    sidecars.stop();
    service.join().unwrap();
    let late = received
        .try_iter()
        .filter(|message| message["surface"] == "probe-surface")
        .collect::<Vec<_>>();
    assert!(entered, "fixture did not enter actual startup: {hello:?}");
    assert!(
        result
            .as_ref()
            .is_err_and(|error| error.contains("changed ownership"))
            && !retained
            && late.is_empty(),
        "background request crossed a new mount: result={result:?}, retained={retained}, wire={late:?}"
    );
}

#[test]
fn window_sidecar_admission_cannot_revive_after_mounted_view_retires() {
    let executable = crate::test_folder::Folder::new();
    let config = crate::test_folder::Folder::new();
    let (release, gate) = std::sync::mpsc::channel();
    let (received, service) =
        crate::sidecars::session_retention_test::service_with_hello_gate(config.path(), Some(gate));
    let sidecars = Arc::new(crate::sidecars::session_retention_test::declared::<
        MountedOwner,
    >(executable.path(), config.path()));
    let data = Arc::new(WindowData::default());
    data.view_source_events.install(Channel::new(|_| Ok(())));
    *data.root.lock().unwrap() = "/fixture/project-a".into();
    let send_data = data.clone();
    let send_sidecars = sidecars.clone();
    let sender = std::thread::spawn(move || {
        let body =
            serde_json::value::RawValue::from_string(r#"{"operation":"background-A"}"#.into())
                .unwrap();
        super::window_sidecar_send(
            &send_data,
            &send_sidecars,
            &MountedOwner(send_data.clone()),
            "fixture-sidecar",
            "probe-surface",
            &body,
            &[],
        )
    });
    let hello = received.recv_timeout(std::time::Duration::from_secs(5));
    let entered = hello
        .as_ref()
        .is_ok_and(|message| message["operation"] == "hello");
    if entered {
        let mounted = mount(&data, "/fixture/project-b");
        data.documents
            .views()
            .forget_if_current("probe-surface", &mounted);
        data.view_source_origins
            .end_view("probe-surface", mounted.generation);
    }
    release.send(()).unwrap();
    let result = sender.join().unwrap();
    assert_eq!(
        data.view_source_origins.pending_background_calls(),
        0,
        "completed/refused request retained its ticket"
    );
    let retained =
        crate::sidecars::session_retention_test::has_surface_session(&sidecars, "probe-surface");
    sidecars.stop();
    service.join().unwrap();
    let late = received
        .try_iter()
        .filter(|message| message["surface"] == "probe-surface")
        .collect::<Vec<_>>();
    assert!(entered, "fixture did not enter actual startup: {hello:?}");
    assert!(
        result
            .as_ref()
            .is_err_and(|error| error.contains("changed ownership"))
            && !retained
            && late.is_empty(),
        "background request crossed a new mount: result={result:?}, retained={retained}, wire={late:?}"
    );
}

#[test]
fn background_startup_keeps_authority_when_an_unrelated_surface_mounts() {
    let executable = crate::test_folder::Folder::new();
    let config = crate::test_folder::Folder::new();
    let (release, gate) = std::sync::mpsc::channel();
    let (received, service) =
        crate::sidecars::session_retention_test::service_with_hello_gate(config.path(), Some(gate));
    let sidecars = Arc::new(crate::sidecars::session_retention_test::declared::<
        MountedOwner,
    >(executable.path(), config.path()));
    let data = Arc::new(WindowData::default());
    data.view_source_events.install(Channel::new(|_| Ok(())));
    *data.root.lock().unwrap() = "/fixture/project-a".into();
    let send_data = data.clone();
    let send_sidecars = sidecars.clone();
    let sender = std::thread::spawn(move || {
        let body =
            serde_json::value::RawValue::from_string(r#"{"operation":"background-A"}"#.into())
                .unwrap();
        super::window_sidecar_send(
            &send_data,
            &send_sidecars,
            &MountedOwner(send_data.clone()),
            "fixture-sidecar",
            "probe-surface",
            &body,
            &[],
        )
    });
    let hello = received.recv_timeout(std::time::Duration::from_secs(5));
    let entered = hello
        .as_ref()
        .is_ok_and(|message| message["operation"] == "hello");
    if entered {
        register_view_source_with_start(
            &data.view_source_origins,
            data.documents.views(),
            &data.view_source_events,
            "unrelated-surface",
            "probe",
            &start("/fixture/project-b"),
        )
        .unwrap();
    }
    release.send(()).unwrap();
    let result = sender.join().unwrap();
    assert_eq!(
        data.view_source_origins.pending_background_calls(),
        0,
        "completed/refused request retained its ticket"
    );
    let retained =
        crate::sidecars::session_retention_test::has_surface_session(&sidecars, "probe-surface");
    sidecars.stop();
    service.join().unwrap();
    let late = received
        .try_iter()
        .filter(|message| message["surface"] == "probe-surface")
        .collect::<Vec<_>>();
    assert!(entered, "fixture did not enter actual startup: {hello:?}");
    assert!(
        result.is_ok() && retained && late.len() == 1,
        "unrelated mount invalidated background authority: result={result:?}, retained={retained}, wire={late:?}"
    );
}

#[test]
fn background_ticket_is_released_after_pre_enqueue_errors() {
    let folder = crate::test_folder::Folder::new();
    let data = Arc::new(WindowData::default());
    let (sidecars, read) = crate::sidecars::session_retention_test::mounted_project_probe_wire::<
        MountedOwner,
    >(folder.path());
    let body =
        serde_json::value::RawValue::from_string(r#"{"operation":"no-project"}"#.into()).unwrap();
    let error = super::window_sidecar_send(
        &data,
        &sidecars,
        &MountedOwner(data.clone()),
        "fixture-sidecar",
        "probe-surface",
        &body,
        &[],
    );
    assert!(
        error
            .as_ref()
            .is_err_and(|error| error.contains("has no project")),
        "expected actual no-project refusal: {error:?}"
    );
    assert!(read().is_none());
    assert_eq!(data.view_source_origins.pending_background_calls(), 0);
    *data.root.lock().unwrap() = "/fixture/project-a".into();
    let (full, retained) = crate::sidecars::session_retention_test::mounted_full_project_wire::<
        MountedOwner,
    >(folder.path());
    let error = super::window_sidecar_send(
        &data,
        &full,
        &MountedOwner(data.clone()),
        "fixture-sidecar",
        "probe-surface",
        &body,
        &[],
    );
    assert!(
        error
            .as_ref()
            .is_err_and(|error| error.contains("not keeping up")),
        "expected actual full-outbox refusal: {error:?}"
    );
    assert!(!retained());
    assert_eq!(data.view_source_origins.pending_background_calls(), 0);
}
