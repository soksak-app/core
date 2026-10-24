use super::DeclaredSourceOrigins;

#[test]
fn the_atomic_origin_snapshot_keeps_the_floor_and_only_current_plugin_hosts() {
    let origins = DeclaredSourceOrigins::default();
    let old = origins
        .issue_plugin_host("probe")
        .expect("first origin is issued");
    let current = origins
        .issue_plugin_host("probe")
        .expect("replacement origin is issued");
    assert_eq!((old, current), (1, 2));
    assert!(
        !origins.end_plugin_host("probe", old),
        "a delayed end cannot remove the replacement"
    );

    let seeded = origins.snapshot();
    assert_eq!(seeded.floor, 2);
    assert_eq!(seeded.plugin_hosts.get("probe"), Some(&2));
    assert!(seeded.views.is_empty());

    assert!(origins.end_plugin_host("probe", current));
    let ended = origins.snapshot();
    assert_eq!(
        ended.floor, 2,
        "ending a source does not lower the generation floor"
    );
    assert!(ended.plugin_hosts.is_empty());
}

#[test]
fn issuing_a_generation_past_the_javascript_safe_integer_limit_changes_no_state() {
    let origins = DeclaredSourceOrigins::default();
    origins.lock().floor = 9_007_199_254_740_991;

    let result = origins.issue_plugin_host("probe");

    assert_eq!(
        result,
        Err("declared source generation exceeds the JavaScript safe integer limit".into())
    );
    let snapshot = origins.snapshot();
    assert_eq!(snapshot.floor, 9_007_199_254_740_991);
    assert!(snapshot.plugin_hosts.is_empty());
    assert!(snapshot.views.is_empty());

    let view_origins = DeclaredSourceOrigins::default();
    view_origins.lock().floor = 9_007_199_254_740_991;
    assert_eq!(
        view_origins.issue_view("surface"),
        Err("declared source generation exceeds the JavaScript safe integer limit".into())
    );
    let snapshot = view_origins.snapshot();
    assert_eq!(snapshot.floor, 9_007_199_254_740_991);
    assert!(snapshot.views.is_empty());
}
