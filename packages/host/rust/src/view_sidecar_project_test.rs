use super::register_view_source_with_start;
use crate::framework::Channel;
use crate::sidecars::session_retention_test::mounted_project_wire;
use crate::sidecars::{Failure, Message, Owner};
use crate::surfaces::ViewStart;
use crate::windows::WindowData;
use std::sync::Arc;

#[derive(Clone)]
pub(super) struct MountedOwner(pub(super) Arc<WindowData>);
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
pub(super) fn start(root: &str) -> ViewStart {
    serde_json::from_value(serde_json::json!({"origin":{"directory":null},"project":{"id":"project","root":root},"diagnostics":null,"section":null})).unwrap()
}
pub(super) fn mount(data: &WindowData, root: &str) -> super::ViewOrigin {
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
