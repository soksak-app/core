use serde_json::json;
use soksak_host_tauriv2::exposure::reply_target;

// contract: exposure-reply.target.main-and-surface-distinct
#[test]
fn main_and_surface_replies_use_distinct_targets() {
    assert_eq!(
        reply_target("main", &json!({"id":1,"result":null})).unwrap(),
        "main"
    );
    assert_eq!(
        reply_target("main", &json!({"id":2,"surface":"tab-1","result":null})).unwrap(),
        "surface-main-tab-1"
    );
    assert_eq!(
        reply_target("second", &json!({"id":3,"surface":"tab-1"})).unwrap(),
        "surface-second-tab-1"
    );
}

// contract: exposure-reply.target.invalid-surface-rejected
#[test]
fn invalid_scope_cannot_be_converted_to_a_main_reply() {
    for scope in [json!(null), json!(""), json!(1), json!({})] {
        assert!(reply_target("main", &json!({"id":1,"surface":scope})).is_err());
    }
}
