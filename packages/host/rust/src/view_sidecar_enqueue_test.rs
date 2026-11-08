//! A mounted view send cannot create a sidecar session once its generation retired, or when the outbox refuses the line.
//! The same cases run in the Go host.
use super::view_sidecar_project_test::{MountedOwner, mount};
use crate::framework::Channel;
use crate::windows::WindowData;
use std::sync::Arc;

// contract: sidecars.view-send.generation-retired-during-start-creates-no-session
#[test]
fn mounted_sidecar_enqueue_cannot_create_session_after_its_generation_retires() {
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
    let retained =
        crate::sidecars::session_retention_test::has_surface_session(&sidecars, "probe-surface");
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
        result.is_err() && !retained && late.is_empty(),
        "retired source created a new session after startup resumed: result={result:?} retained={retained} actual_wire={late:?}"
    );
}

// contract: sidecars.view-send.full-queue-creates-no-session
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
