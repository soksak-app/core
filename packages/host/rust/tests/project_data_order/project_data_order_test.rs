//! Project ownership and page-selected project publication ordering.

use super::*;
use crate::framework::InvokeBody;
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

/// Decodes the argument request of a call with payload as a host call does, and commits the shown project of data.
use crate::test_framework::DISPLAY_NAME;

fn project_shown_decoder_fixture(data: &WindowData, payload: &Value) -> Result<(), String> {
    let request = crate::arguments::Argument::<ProjectShown>::from_body(
        "project_shown_decoder_fixture",
        "request",
        &InvokeBody::Json(payload),
    )?;
    commit_project_shown(data, request.0.project.as_ref(), DISPLAY_NAME, |_| Ok(()))
}

/// Reads the committed project of the window: the shown id and its root, or none when the window shows no project.
fn committed_project(data: &WindowData) -> Result<Option<crate::surfaces::SurfaceProject>, String> {
    let id = data.shown.lock().unwrap().clone();
    if id.is_empty() {
        return Ok(None);
    }
    let root = data.root.lock().unwrap().clone();
    if root.is_empty() {
        return Err(format!(
            "window shows project {id} without a committed root"
        ));
    }
    Ok(Some(crate::surfaces::SurfaceProject { id, root }))
}

// contract: host-calls.decode.messages
// contract: projects.shown.requires-project-field
#[test]
fn malformed_project_shown_arguments_are_rejected_before_committing_project_state() {
    let data = Arc::new(WindowData::default());
    *data.shown.lock().unwrap() = "project-old".into();
    *data.root.lock().unwrap() = "/projects/old".into();
    data.projects
        .lock()
        .unwrap()
        .insert("project-next".into(), "/projects/next".into());
    data.staged_projects
        .lock()
        .unwrap()
        .insert("project-next".into());
    for (request, expected) in [
        (
            json!(true),
            "argument request must be an object, not a boolean",
        ),
        (json!({}), "argument request.project is missing"),
        (
            json!({
                "project": {"id": 5, "root": "/projects/next", "title": "Next"}
            }),
            "argument request.project.id must be a string, not a number",
        ),
    ] {
        let response = project_shown_decoder_fixture(&data, &json!({"request": request}));
        assert_eq!(response.unwrap_err(), expected);
        assert_eq!(*data.shown.lock().unwrap(), "project-old");
        assert_eq!(*data.root.lock().unwrap(), "/projects/old");
        assert_eq!(
            data.projects
                .lock()
                .unwrap()
                .get("project-next")
                .map(String::as_str),
            Some("/projects/next")
        );
        assert!(
            data.staged_projects
                .lock()
                .unwrap()
                .contains("project-next")
        );
    }

    let response = project_shown_decoder_fixture(&data, &json!({"request": {"project": null}}));
    assert!(
        response.is_ok(),
        "explicit null is a valid no-project selection: {response:?}"
    );
    assert!(data.shown.lock().unwrap().is_empty());
    assert!(data.root.lock().unwrap().is_empty());
}

// contract: project.open-ready-shown-order
#[test]
fn opening_an_existing_project_keeps_the_committed_project_until_page_selection() {
    let data = WindowData::default();
    *data.shown.lock().unwrap() = "project-old".into();
    *data.root.lock().unwrap() = "/projects/old".into();
    data.projects
        .lock()
        .unwrap()
        .insert("project-next".into(), "/projects/next".into());
    data.staged_projects
        .lock()
        .unwrap()
        .insert("project-next".into());
    let staged = register_project_open(&data, "project-next", "/projects/next", false);

    assert_eq!(*data.shown.lock().unwrap(), "project-old");
    assert_eq!(*data.root.lock().unwrap(), "/projects/old");
    assert!(staged);
    assert_eq!(
        data.projects
            .lock()
            .unwrap()
            .get("project-next")
            .map(String::as_str),
        Some("/projects/next")
    );
    assert!(
        data.staged_projects
            .lock()
            .unwrap()
            .contains("project-next")
    );
}

// contract: project.open.staged-until-shown
// contract: project.open.registers-owner-without-commit
#[test]
fn a_pending_owner_stays_staged_across_open_until_project_shown_commits_it() {
    // The window title ends with the display name of the framework.
    crate::test_framework::application();
    let data = WindowData::default();
    assert!(register_project_open(
        &data,
        "project-next",
        "/projects/next",
        true
    ));
    assert!(register_project_open(
        &data,
        "project-next",
        "/projects/next",
        false
    ));
    let title = Mutex::new(String::new());

    commit_project_shown(
        &data,
        Some(&ShownProject {
            id: "project-next".into(),
            root: "/projects/next".into(),
            title: "Next".into(),
        }),
        DISPLAY_NAME,
        |value| {
            *title.lock().unwrap() = value.into();
            Ok(())
        },
    )
    .unwrap();

    assert_eq!(*data.shown.lock().unwrap(), "project-next");
    assert_eq!(*data.root.lock().unwrap(), "/projects/next");
    assert!(
        !data
            .staged_projects
            .lock()
            .unwrap()
            .contains("project-next")
    );
    assert_eq!(*title.lock().unwrap(), format!("Next / {DISPLAY_NAME}"));
    assert!(!register_project_open(
        &data,
        "project-next",
        "/projects/next",
        false
    ));
}

// contract: project.open-ready-shown-order
// contract: project.shown-commits-after-page-ready
#[test]
fn an_unready_host_catches_up_old_project_until_the_page_commits_the_new_project() {
    let data = WindowData::default();
    data.projects.lock().unwrap().extend([
        ("project-old".into(), "/projects/old".into()),
        ("project-next".into(), "/projects/next".into()),
    ]);
    *data.shown.lock().unwrap() = "project-old".into();
    *data.root.lock().unwrap() = "/projects/old".into();

    assert!(register_project_open(
        &data,
        "project-next",
        "/projects/next",
        true
    ));
    assert_eq!(
        committed_project(&data).unwrap(),
        Some(crate::surfaces::SurfaceProject {
            id: "project-old".into(),
            root: "/projects/old".into(),
        })
    );

    commit_project_shown(
        &data,
        Some(&ShownProject {
            id: "project-next".into(),
            root: "/projects/next".into(),
            title: "Next".into(),
        }),
        DISPLAY_NAME,
        |_| Ok(()),
    )
    .unwrap();

    assert_eq!(
        committed_project(&data).unwrap(),
        Some(crate::surfaces::SurfaceProject {
            id: "project-next".into(),
            root: "/projects/next".into(),
        })
    );
}

// contract: project.open.prepare-before-show
#[test]
fn reopening_the_shown_id_keeps_its_committed_root_for_ready_catch_up() {
    let data = WindowData::default();
    data.projects
        .lock()
        .unwrap()
        .insert("project-current".into(), "/projects/old".into());
    *data.shown.lock().unwrap() = "project-current".into();
    *data.root.lock().unwrap() = "/projects/old".into();

    let staged = register_project_open(&data, "project-current", "/projects/new", false);

    assert!(!staged);
    assert_eq!(
        committed_project(&data).unwrap(),
        Some(crate::surfaces::SurfaceProject {
            id: "project-current".into(),
            root: "/projects/old".into(),
        })
    );

    commit_project_shown(
        &data,
        Some(&ShownProject {
            id: "project-current".into(),
            root: "/projects/new".into(),
            title: "Current".into(),
        }),
        DISPLAY_NAME,
        |_| Ok(()),
    )
    .unwrap();
    assert_eq!(
        committed_project(&data).unwrap(),
        Some(crate::surfaces::SurfaceProject {
            id: "project-current".into(),
            root: "/projects/new".into(),
        })
    );
}

// contract: projects.shown-validates-before-commit
#[test]
fn a_root_mismatch_does_not_mutate_committed_or_staged_project_state() {
    let data = WindowData::default();
    *data.shown.lock().unwrap() = "project-old".into();
    *data.root.lock().unwrap() = "/projects/old".into();
    data.projects
        .lock()
        .unwrap()
        .insert("project-next".into(), "/projects/next".into());
    data.staged_projects
        .lock()
        .unwrap()
        .insert("project-next".into());
    let titled = AtomicBool::new(false);

    let error = commit_project_shown(
        &data,
        Some(&ShownProject {
            id: "project-next".into(),
            root: "/projects/other".into(),
            title: "Next".into(),
        }),
        DISPLAY_NAME,
        |_| {
            titled.store(true, Ordering::SeqCst);
            Ok(())
        },
    )
    .unwrap_err();

    assert!(error.contains("root does not match"));
    assert_eq!(*data.shown.lock().unwrap(), "project-old");
    assert_eq!(*data.root.lock().unwrap(), "/projects/old");
    assert!(
        data.staged_projects
            .lock()
            .unwrap()
            .contains("project-next")
    );
    assert!(!titled.load(Ordering::SeqCst));
}

// contract: project.shown-commits-after-page-ready
#[test]
fn showing_no_project_clears_committed_state_and_preserves_other_staged_owners() {
    // The window title ends with the display name of the framework.
    crate::test_framework::application();
    let data = WindowData::default();
    *data.shown.lock().unwrap() = "project-old".into();
    *data.root.lock().unwrap() = "/projects/old".into();
    data.staged_projects
        .lock()
        .unwrap()
        .insert("project-next".into());
    let title = Mutex::new(String::new());

    commit_project_shown(&data, None, DISPLAY_NAME, |value| {
        *title.lock().unwrap() = value.into();
        Ok(())
    })
    .unwrap();

    assert!(data.shown.lock().unwrap().is_empty());
    assert!(data.root.lock().unwrap().is_empty());
    assert_eq!(*title.lock().unwrap(), window_title(DISPLAY_NAME));
    assert!(
        data.staged_projects
            .lock()
            .unwrap()
            .contains("project-next")
    );
}

// contract: projects.release-rolls-back-staged-owner
#[test]
fn releasing_a_pending_project_removes_its_owner_reservation() {
    let data = WindowData::default();
    assert!(register_project_open(
        &data,
        "project-next",
        "/projects/next",
        true
    ));

    release_project_reservation(&data, "project-next");

    assert!(!data.projects.lock().unwrap().contains_key("project-next"));
    assert!(
        !data
            .staged_projects
            .lock()
            .unwrap()
            .contains("project-next")
    );
}

// contract: projects.open.geometry-failure-closes-before-reservation
#[test]
fn a_new_window_is_closed_when_geometry_setup_fails_before_reservation() {
    let data = WindowData::default();
    *data.shown.lock().unwrap() = "project-old".into();
    *data.root.lock().unwrap() = "/projects/old".into();
    data.projects
        .lock()
        .unwrap()
        .insert("project-old".into(), "/projects/old".into());
    let registry = Windows::default();
    registry
        .owners
        .lock()
        .unwrap()
        .insert("project-old".into(), "main".into());
    let closed = AtomicBool::new(false);

    let error = configure_project_window(
        Some(Geometry {
            x: 10,
            y: 20,
            width: 900.0,
            height: 700.0,
        }),
        true,
        |_| Err("set_size failed".into()),
        || panic!("new window failure must not restore a previous window"),
        || {
            closed.store(true, Ordering::SeqCst);
            Ok(())
        },
    )
    .unwrap_err();

    assert_eq!(error, "set_size failed");
    assert!(closed.load(Ordering::SeqCst));
    assert_eq!(*data.shown.lock().unwrap(), "project-old");
    assert_eq!(*data.root.lock().unwrap(), "/projects/old");
    assert!(data.projects.lock().unwrap().contains_key("project-old"));
    assert!(!data.projects.lock().unwrap().contains_key("project-next"));
    assert!(
        !data
            .staged_projects
            .lock()
            .unwrap()
            .contains("project-next")
    );
    assert_eq!(
        registry
            .owners
            .lock()
            .unwrap()
            .get("project-old")
            .map(String::as_str),
        Some("main")
    );
    assert!(!registry.owners.lock().unwrap().contains_key("project-next"));

    let restored = AtomicBool::new(false);
    let closed = AtomicBool::new(false);
    assert_eq!(
        configure_project_window(
            Some(Geometry {
                x: 10,
                y: 20,
                width: 900.0,
                height: 700.0,
            }),
            false,
            |_| Err("set_position failed".into()),
            || {
                restored.store(true, Ordering::SeqCst);
                Ok(())
            },
            || {
                closed.store(true, Ordering::SeqCst);
                Ok(())
            },
        )
        .unwrap_err(),
        "set_position failed"
    );
    assert!(restored.load(Ordering::SeqCst));
    assert!(!closed.load(Ordering::SeqCst));
}

// contract: project.shown.ignores-unknown-fields
#[test]
fn project_shown_ignores_unknown_outer_fields() {
    let decoded = serde_json::from_value::<ProjectShown>(json!({
        "project": null,
        "unknown": true,
    }));

    assert!(
        decoded.is_ok(),
        "unknown outer field was rejected: {decoded:?}"
    );
}

// contract: project.shown.ignores-unknown-fields
#[test]
fn shown_project_ignores_unknown_nested_fields() {
    let decoded = serde_json::from_value::<ProjectShown>(json!({
        "project": {
            "id": "project-one",
            "root": "/tmp/project-one",
            "title": "One",
            "unknown": true,
        },
    }));

    assert!(
        decoded.is_ok(),
        "unknown nested field was rejected: {decoded:?}"
    );
}
