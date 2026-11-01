use super::{SidecarListenRequest, SidecarRoutes, ViewSidecarRouteRequest, view_message};
use serde_json::value::RawValue;
use serde_json::{Value, json};

// contract: sidecar.route.calls
#[test]
fn a_route_call_outside_its_form_is_refused_with_the_field_it_lacks() {
    let listen = |value: Value| SidecarListenRequest::from_value(value).map(|_| ());
    assert_eq!(
        listen(json!({"sidecar": "probe", "id": "tab-a", "on": true})),
        Ok(())
    );
    assert_eq!(
        listen(json!({"sidecar": "", "id": "tab-a", "on": true})),
        Err("sidecarListen requires a non-empty sidecar".to_string())
    );
    assert_eq!(
        listen(json!({"sidecar": "probe", "on": true})),
        Err("sidecarListen requires a non-empty id".to_string())
    );
    assert_eq!(
        listen(json!({"sidecar": "probe", "id": "tab-a", "on": 1})),
        Err("sidecarListen requires on as a boolean".to_string())
    );
    let route = |value: Value| ViewSidecarRouteRequest::from_value(value).map(|_| ());
    assert_eq!(
        route(
            json!({"surface": "tab-a", "generation": 3, "sidecar": "probe", "id": "tab-a", "on": false})
        ),
        Ok(())
    );
    assert_eq!(
        route(
            json!({"surface": "", "generation": 3, "sidecar": "probe", "id": "tab-a", "on": true})
        ),
        Err("viewSidecarRoute requires a non-empty surface".to_string())
    );
    assert_eq!(
        route(
            json!({"surface": "tab-a", "generation": 0, "sidecar": "probe", "id": "tab-a", "on": true})
        ),
        Err("viewSidecarRoute has no source generation".to_string())
    );
    assert_eq!(
        route(
            json!({"surface": "tab-a", "generation": 9_007_199_254_740_992u64, "sidecar": "probe", "id": "tab-a", "on": true})
        ),
        Err(
            "viewSidecarRoute source generation exceeds the JavaScript safe integer limit"
                .to_string()
        )
    );
    assert_eq!(
        route(
            json!({"surface": "tab-a", "generation": 3, "sidecar": "probe", "id": "", "on": true})
        ),
        Err("viewSidecarRoute requires a non-empty id".to_string())
    );
}

// contract: sidecar.route.delivery
#[test]
fn a_message_reaches_the_page_only_while_it_listens_and_each_routed_view() {
    let routes = SidecarRoutes::default();
    let targets = routes.targets("probe", "tab-a");
    assert!(
        !targets.page && targets.views.is_empty(),
        "a pair without a route has no receiver"
    );
    routes.listen("probe", "tab-a", true);
    routes.listen("probe", "tab-a", true);
    routes.route_view("tab-a", 4, "probe", "tab-a", true);
    routes.route_view("tab-a", 4, "probe", "tab-a", true);
    routes.route_view("tab-b", 2, "probe", "tab-a", true);
    let targets = routes.targets("probe", "tab-a");
    assert!(targets.page, "the page listens");
    assert_eq!(
        targets.views,
        vec![("tab-a".to_string(), 4), ("tab-b".to_string(), 2)],
        "a repeated call changes nothing"
    );
    assert!(
        !routes.targets("other", "tab-a").page,
        "a route belongs to its sidecar"
    );
    routes.listen("probe", "tab-a", false);
    routes.route_view("tab-b", 2, "probe", "tab-a", false);
    let targets = routes.targets("probe", "tab-a");
    assert!(!targets.page, "the page stopped listening");
    assert_eq!(targets.views, vec![("tab-a".to_string(), 4)]);
    routes.remove_view("probe", "tab-a", "tab-a", 4);
    assert!(
        routes.targets("probe", "tab-a").views.is_empty(),
        "a route of an ended generation is removed"
    );
    routes.listen("probe", "tab-a", true);
    routes.route_view("tab-a", 5, "probe", "tab-a", true);
    routes.clear();
    let targets = routes.targets("probe", "tab-a");
    assert!(
        !targets.page && targets.views.is_empty(),
        "a load of the main document removes every route"
    );
}

// contract: sidecar.route.delivery
#[test]
fn the_view_message_wraps_the_raw_body_without_parsing_it_again() {
    let body = RawValue::from_string(r#"{"event":"screen","rows":2}"#.to_string()).unwrap();
    let text = view_message("tab-\"a", &body);
    assert_eq!(
        text,
        r#"{"sok":1,"event":"sidecar.message","data":{"id":"tab-\"a","body":{"event":"screen","rows":2}}}"#
    );
    let value: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(value["data"]["body"]["rows"], json!(2));
}
