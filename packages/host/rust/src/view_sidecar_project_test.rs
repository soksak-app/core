use super::register_view_source_with_start;
use crate::framework::Channel;
use crate::sidecars::session_retention_test::mounted_project_wire;
use crate::sidecars::{Failure, Message, Owner};
use crate::surfaces::ViewStart;
use crate::windows::WindowData;
use std::sync::Arc;

#[derive(Clone)]
struct MountedOwner(Arc<WindowData>);
impl Owner for MountedOwner {
    fn key(&self) -> String {
        "mounted-window".into()
    }
    fn root(&self) -> Result<String, String> {
        Ok(self.0.root.lock().unwrap().clone())
    }
    fn deliver(&self, _message: Message) {}
    fn deliver_failure(&self, _failure: Failure) {}
}
fn start(root: &str) -> ViewStart {
    serde_json::from_value(serde_json::json!({"origin":{"directory":null},"project":{"id":"project","root":root},"diagnostics":null,"section":null})).unwrap()
}
fn mount(data: &WindowData, root: &str) -> super::ViewOrigin {
    let start = start(root);
    let script = super::surface_start_script(
        "probe-surface",
        &start,
        &soksak_sok::log_policy::LogPolicy::default().classes(),
    )
    .unwrap();
    assert!(
        script.contains(root),
        "the actual immutable page-start script owns this project"
    );
    register_view_source_with_start(
        &data.view_source_origins,
        data.documents.views(),
        &data.view_source_events,
        "probe-surface",
        "probe",
        &start,
    )
    .unwrap()
}
fn require_root(current: &str, replace: bool) {
    let folder = crate::test_folder::Folder::new();
    let data = Arc::new(WindowData::default());
    data.view_source_events.install(Channel::new(|_| Ok(())));
    *data.root.lock().unwrap() = "/fixture/project-a".into();
    let first = mount(&data, "/fixture/project-a");
    let wanted = if replace {
        data.documents
            .views()
            .forget_if_current("probe-surface", &first);
        data.view_source_origins
            .end_view("probe-surface", first.generation);
        let next = mount(&data, "/fixture/project-b");
        assert_ne!(first.generation, next.generation);
        assert!(!data.documents.views().is_current("probe-surface", &first));
        "/fixture/project-b"
    } else {
        "/fixture/project-a"
    };
    *data.root.lock().unwrap() = current.into();
    let (sidecars, read) = mounted_project_wire::<MountedOwner>(folder.path());
    let generation = data
        .view_source_origins
        .current_view("probe-surface")
        .unwrap();
    let result = super::view_sidecar_send(
        &data, &sidecars, &MountedOwner(data.clone()),
        serde_json::from_value(serde_json::json!({"source":"probe-surface", "generation":generation,
            "sidecar":"fixture-sidecar", "surface":"probe-surface", "body":{"operation":"list"},"cids":[]})).unwrap(),
    );
    assert!(
        result.is_ok(),
        "current mount lost its captured project: {result:?}"
    );
    assert_eq!(
        read()["root"],
        wanted,
        "actual outbound root must belong to this exact committed mount, not the current window project"
    );
}
#[test]
fn mounted_view_sidecar_keeps_project_after_window_clear() {
    require_root("", false);
}
#[test]
fn mounted_view_sidecar_never_borrows_other_current_project() {
    require_root("/fixture/project-b", false);
}
#[test]
fn recreated_mounted_view_sidecar_uses_new_project() {
    require_root("/fixture/project-c", true);
}

#[test]
fn a_queued_original_view_ipc_is_rejected_after_same_surface_replacement() {
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
#[test]
fn a_mounted_view_cannot_create_a_session_after_retiring_during_actual_service_startup() {
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
    let original = mount(&data, "/fixture/project-a");
    let packet = serde_json::json!({"source":"probe-surface","generation":original.generation,"sidecar":"fixture-sidecar",
      "surface":"probe-surface","body":{"operation":"retired-A"},"cids":[]});
    let sender_data = data.clone();
    let sender_sidecars = sidecars.clone();
    let sender = std::thread::spawn(move || {
        super::view_sidecar_send(
            &sender_data,
            &sender_sidecars,
            &MountedOwner(sender_data.clone()),
            serde_json::from_value(packet).unwrap(),
        )
    });
    // The REAL service has read hello, but has not answered it. Therefore the
    // host send passed its first source check and is inside process startup.
    let hello = received.recv_timeout(std::time::Duration::from_secs(5));
    let admitted = hello
        .as_ref()
        .is_ok_and(|message| message["operation"] == "hello");
    if admitted {
        data.documents
            .views()
            .forget_if_current("probe-surface", &original);
        data.view_source_origins
            .end_view("probe-surface", original.generation);
        let replacement = mount(&data, "/fixture/project-b");
        assert_ne!(original.generation, replacement.generation);
        *data.root.lock().unwrap() = "/fixture/project-b".into();
    }
    release.send(()).unwrap();
    let result = sender
        .join()
        .expect("the real sender finishes after the owned hello response");
    sidecars.stop();
    service.join().expect("the maintained service shuts down");
    assert!(
        admitted,
        "fixture never reached actual service startup: {hello:?}"
    );
    let late = received
        .try_iter()
        .filter(|message| message["surface"] == "probe-surface")
        .collect::<Vec<_>>();
    assert!(
        result.is_err() && late.is_empty(),
        "retired source created a new session after startup resumed: result={result:?} actual_wire={late:?}"
    );
}

#[test]
fn a_full_outbox_does_not_create_a_mounted_session() {
    let folder = crate::test_folder::Folder::new();
    let data = Arc::new(WindowData::default());
    data.view_source_events.install(Channel::new(|_| Ok(())));
    let original = mount(&data, "/fixture/project-a");
    let (sidecars, retained) = crate::sidecars::session_retention_test::mounted_full_project_wire::<
        MountedOwner,
    >(folder.path());
    let result = super::view_sidecar_send(&data, &sidecars, &MountedOwner(data.clone()),
        serde_json::from_value(serde_json::json!({"source":"probe-surface","generation":original.generation,
            "sidecar":"fixture-sidecar","surface":"probe-surface","body":{"operation":"full"},"cids":[]})).unwrap());
    assert!(
        result
            .as_ref()
            .is_err_and(|error| error.contains("not keeping up")),
        "actual enqueue must be refused: {result:?}"
    );
    assert!(
        !retained(),
        "failed enqueue created owner/root/process surface records"
    );
}

#[test]
fn a_background_request_cannot_change_the_root_committed_during_its_startup() {
    let executable = crate::test_folder::Folder::new();
    let config = crate::test_folder::Folder::new();
    let (release, gate) = std::sync::mpsc::channel();
    let (received, service) =
        crate::sidecars::session_retention_test::service_with_hello_gate(config.path(), Some(gate));
    let (sidecars, read_ready) = crate::sidecars::session_retention_test::background_race_sidecars::<
        MountedOwner,
    >(executable.path(), config.path());
    let sidecars = Arc::new(sidecars);
    let data = Arc::new(WindowData::default());
    *data.root.lock().unwrap() = "/fixture/project-a".into();
    let send_data = data.clone();
    let send_sidecars = sidecars.clone();
    let sender = std::thread::spawn(move || {
        let body =
            serde_json::value::RawValue::from_string(r#"{"operation":"older-A"}"#.into()).unwrap();
        send_sidecars.send_from_page(
            &MountedOwner(send_data),
            "fixture-sidecar",
            "probe-surface",
            &body,
            &[],
        )
    });
    let hello = received.recv_timeout(std::time::Duration::from_secs(5));
    let admitted = hello
        .as_ref()
        .is_ok_and(|message| message["operation"] == "hello");
    let newer = if admitted {
        *data.root.lock().unwrap() = "/fixture/project-b".into();
        let body =
            serde_json::value::RawValue::from_string(r#"{"operation":"newer-B"}"#.into()).unwrap();
        sidecars.send_from_page(
            &MountedOwner(data.clone()),
            "fixture-ready",
            "probe-surface",
            &body,
            &[],
        )
    } else {
        Err("fixture never entered startup".into())
    };
    let ready_wire = if newer.is_ok() {
        Some(read_ready())
    } else {
        None
    };
    release.send(()).unwrap();
    let older = sender.join().unwrap();
    sidecars.stop();
    service.join().unwrap();
    let late = received
        .try_iter()
        .filter(|message| message["surface"] == "probe-surface")
        .collect::<Vec<_>>();
    assert!(
        admitted && newer.is_ok(),
        "actual competing producer setup failed: hello={hello:?}, newer={newer:?}"
    );
    assert_eq!(ready_wire.unwrap()["root"], "/fixture/project-b");
    assert!(
        older.is_err() && late.is_empty(),
        "older startup borrowed or overwrote another admitted root: older={older:?}, wire={late:?}"
    );
}

#[test]
fn generic_window_boundary_refuses_a_mounted_view_without_original_authority() {
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

#[test]
fn background_startup_cannot_enter_a_surface_that_mounted_without_sending() {
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
        result.is_err() && !retained && late.is_empty(),
        "background request crossed a new mount: result={result:?}, retained={retained}, wire={late:?}"
    );
}

#[test]
fn background_startup_cannot_resurrect_after_a_mount_started_and_retired() {
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
        result.is_err() && !retained && late.is_empty(),
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
