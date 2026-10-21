//! The sidecar requests of a plugin host page (docs/plans/plugin-host-routes.md rules 2 and 3).

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
            Some("/fixture/root")
        ),
        Ok("/fixture/root".to_string())
    );
    assert_eq!(
        plugin_send_root("probe", "fixture-sidecar", session, true, None),
        Err("plugin host probe: project project-a is not held by this window".to_string())
    );
    assert_eq!(
        plugin_send_root("probe", "fixture-sidecar", session, true, Some("")),
        Err("plugin host probe: project project-a has no folder".to_string())
    );
    assert_eq!(
        plugin_send_root(
            "probe",
            "fixture-sidecar",
            session,
            false,
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
