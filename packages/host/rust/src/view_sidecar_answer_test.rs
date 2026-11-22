//! The view answered send: the reply whose surface and cids equal the request resolves the wait, and a request without cids is
//! refused with the answer text and queues no request line (docs/spec/persistent-services.md#owned-session-messages).

use crate::documents::view_sidecar_project_test::{MountedOwner, mount};
use crate::documents::window_sidecar_answer_test::{SIDECAR, SURFACE, answer_service};
use crate::framework::Channel;
use crate::windows::WindowData;
use std::sync::Arc;
/// The view request of the answered view send: the source generation of the mount of `probe-surface`.
fn view_request(
    generation: u64,
    cids: serde_json::Value,
    answer: bool,
) -> crate::documents::ViewSidecarSendRequest {
    serde_json::from_value(serde_json::json!({
        "source": SURFACE,
        "generation": generation,
        "sidecar": SIDECAR,
        "surface": SURFACE,
        "body": {"op": "open", "session": {"creation": "creation-2"}, "cols": 80, "rows": 24, "params": {}},
        "cids": cids,
        "answer": answer
    }))
    .unwrap()
}

// A view answered send resolves with the body of the reply whose surface and cids equal the request's.
// contract: sidecars.view-answer.resolves-with-the-matching-reply
#[test]
fn a_view_answered_send_resolves_with_the_matching_reply() {
    let executable = crate::test_folder::Folder::new();
    let config = crate::test_folder::Folder::new();
    let (received, service) = answer_service(config.path(), |request| {
        Some(serde_json::json!({
            "surface": request["surface"],
            "cids": request["cids"],
            "body": {"session": "session-2", "creation": "creation-2"}
        }))
    });
    let sidecars = Arc::new(crate::sidecars::session_retention_test::declared::<
        MountedOwner,
    >(executable.path(), config.path()));
    let data = Arc::new(WindowData::default());
    data.view_source_events.install(Channel::new(|_| Ok(())));
    *data.root.lock().unwrap() = "/fixture/project-a".into();
    let origin = mount(&data, "/fixture/project-a");

    let waiter = super::view_sidecar_send_answered(
        &data,
        &sidecars,
        &MountedOwner(data.clone()),
        view_request(origin.generation, serde_json::json!(["p1.6"]), true),
    )
    .unwrap();
    let reply = waiter.wait().unwrap();
    sidecars.stop();
    service.join().unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(reply.get()).unwrap(),
        serde_json::json!({"session": "session-2", "creation": "creation-2"})
    );
    let sent: Vec<_> = received
        .try_iter()
        .filter(|request| request["surface"] == SURFACE)
        .collect();
    assert_eq!(sent.len(), 1, "the view request line: {sent:?}");
    assert_eq!(sent[0]["cids"], serde_json::json!(["p1.6"]));
}

// A view answered send without cids is refused with the answer text, and queues no request line.
// contract: sidecars.view-answer.requires-cids
#[test]
fn a_view_answered_send_without_cids_is_refused_and_queues_nothing() {
    let executable = crate::test_folder::Folder::new();
    let config = crate::test_folder::Folder::new();
    let sidecars = Arc::new(crate::sidecars::session_retention_test::declared::<
        MountedOwner,
    >(executable.path(), config.path()));
    let data = Arc::new(WindowData::default());
    data.view_source_events.install(Channel::new(|_| Ok(())));
    *data.root.lock().unwrap() = "/fixture/project-a".into();
    let origin = mount(&data, "/fixture/project-a");

    let refused = super::view_sidecar_send_answered(
        &data,
        &sidecars,
        &MountedOwner(data.clone()),
        view_request(origin.generation, serde_json::json!([]), true),
    )
    .err();
    sidecars.stop();
    assert_eq!(refused.as_deref(), Some("sidecarSend answer requires cids"));
    assert!(
        !crate::sidecars::session_retention_test::has_surface_session(&sidecars, SURFACE),
        "a refused view answered send recorded a session of the surface"
    );
}
