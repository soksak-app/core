use super::{DeclaredSourceOrigins, MAX_DECLARED_SOURCE_GENERATION, with_plugin_host_generation};

// contract: source-origin.atomic-snapshot-keeps-floor-and-only-current-sources
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

// contract: source-origin.generation.javascript-safe-integer-limit
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

// contract: plugin-host.startup.refuses-exhausted-source-generation-before-provider
#[test]
fn an_exhausted_plugin_host_generation_does_not_start_provider_creation() {
    let origins = DeclaredSourceOrigins::default();
    origins.lock().floor = MAX_DECLARED_SOURCE_GENERATION;
    let before = origins.snapshot();
    let mut provider_calls = 0;

    let result = with_plugin_host_generation(&origins, "probe", |generation| {
        provider_calls += 1;
        Ok(generation)
    });

    assert_eq!(
        result,
        Err("declared source generation exceeds the JavaScript safe integer limit".into())
    );
    assert_eq!(
        provider_calls, 0,
        "provider creation ran without a generation"
    );
    let after = origins.snapshot();
    assert_eq!(after.floor, before.floor);
    assert_eq!(after.plugin_hosts, before.plugin_hosts);
    assert_eq!(after.views, before.views);
}
