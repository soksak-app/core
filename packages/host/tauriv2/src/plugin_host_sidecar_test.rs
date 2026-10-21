//! The sidecar requests of a plugin host page (docs/plans/plugin-host-routes.md rules 2, 3 and 7, F229-1, F229-8).

// contract: plugin-host.sidecar.page-start-close
#[test]
fn the_page_start_closes_plugin_host_sessions_only() {
    use crate::plugin_host_sidecar::parse_session;
    // The page start closes the sessions of plugin hosts (rule 7). A surface and a state session are not plugin host sessions.
    assert_eq!(
        parse_session("plugin:probe:project-a:fixture-sidecar"),
        Some(("probe", "project-a", "fixture-sidecar"))
    );
    assert_eq!(parse_session("s1"), None);
    assert_eq!(parse_session("state:files:project-a"), None);
    assert_eq!(parse_session("plugin:probe:project-a"), None);
}

// contract: plugin-host.sidecar.send-checks, plugin-host.sidecar.surface-refusal
#[test]
fn a_sidecar_request_of_a_host_is_checked_before_its_send() {
    use crate::plugin_host_sidecar::{parse_session, plugin_send_root, refuse_surface_send};
    let session = "plugin:probe:project-a:fixture-sidecar";
    assert_eq!(
        plugin_send_root(
            "probe",
            "fixture-sidecar",
            session,
            true,
            true,
            Some("/fixture/root")
        ),
        Ok("/fixture/root".to_string())
    );
    assert_eq!(
        plugin_send_root("probe", "fixture-sidecar", session, true, true, None),
        Err("plugin host probe: project project-a is not held by this window".to_string())
    );
    assert_eq!(
        plugin_send_root("probe", "fixture-sidecar", session, true, true, Some("")),
        Err("plugin host probe: project project-a has no folder".to_string())
    );
    assert_eq!(
        plugin_send_root(
            "probe",
            "fixture-sidecar",
            session,
            false,
            true,
            Some("/fixture/root")
        ),
        Err("plugin host probe cannot use sidecar fixture-sidecar".to_string())
    );
    assert_eq!(
        plugin_send_root(
            "probe",
            "fixture-sidecar",
            "plugin:other:project-a:fixture-sidecar",
            true,
            true,
            Some("/r")
        ),
        Err(
            "plugin host probe cannot use sidecar session plugin:other:project-a:fixture-sidecar"
                .to_string()
        )
    );
    assert_eq!(
        parse_session(session),
        Some(("probe", "project-a", "fixture-sidecar"))
    );
    assert_eq!(
        parse_session("plugin:probe:project-a:fixture-sidecar:x"),
        None
    );
    assert_eq!(
        refuse_surface_send(session),
        Err(format!(
            "sidecar session {session} is reserved for a plugin host"
        ))
    );
    assert_eq!(refuse_surface_send("tab-1"), Ok(()));
}

// A window that shows no project refuses a plugin send with a named error, whichever project the session names
// (docs/plans/plugin-host-routes.md F229-1).
// contract: plugin-host.sidecar.release-shown-project
#[test]
fn a_plugin_send_is_refused_while_no_project_is_shown() {
    use crate::plugin_host_sidecar::plugin_send_root;
    let session = "plugin:probe:project-a:fixture-sidecar";
    assert_eq!(
        plugin_send_root(
            "probe",
            "fixture-sidecar",
            session,
            true,
            false,
            Some("/fixture/root")
        ),
        Err("plugin host probe: no project is shown".to_string())
    );
}

// The sessions that end with the release of a project are the plugin sessions and the state sessions of that project
// (docs/plans/plugin-host-routes.md rule 7, F229-8).
// contract: plugin-host.sidecar.release-state-session
#[test]
fn a_release_ends_the_plugin_and_state_sessions_of_that_project() {
    use crate::plugin_host_sidecar::{is_project_session, parse_state_session};
    assert_eq!(
        parse_state_session("state:files:project-a"),
        Some(("files", "project-a"))
    );
    assert_eq!(parse_state_session("state:files:project-a:x"), None);
    assert_eq!(parse_state_session("plugin:files:project-a"), None);
    assert!(is_project_session("state:files:project-a", "project-a"));
    assert!(!is_project_session("state:files:project-b", "project-a"));
    assert!(is_project_session(
        "plugin:probe:project-a:fixture-sidecar",
        "project-a"
    ));
    assert!(!is_project_session(
        "plugin:probe:project-b:fixture-sidecar",
        "project-a"
    ));
    assert!(!is_project_session("tab-1", "project-a"));
}
