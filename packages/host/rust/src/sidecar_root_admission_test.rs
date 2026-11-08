//! A background sidecar request checks the committed session root again after the sidecar process starts. The same case
//! runs in the Go host.
use super::view_sidecar_project_test::MountedOwner;
use crate::windows::WindowData;
use std::sync::Arc;

#[test]
fn background_sidecar_admission_rechecks_root_after_process_start() {
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
        older
            .as_ref()
            .is_err_and(|error| error.contains("mounted project differs"))
            && late.is_empty(),
        "older startup borrowed or overwrote another admitted root: older={older:?}, wire={late:?}"
    );
}
