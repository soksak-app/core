use soksak_host_tauriv2::documents::check as check_document;
use soksak_host_tauriv2::exposure::authorize_main_caller;
use soksak_host_tauriv2::images::check as check_image;

// contract: authorization.surface.cross-surface-rejected, authorization.surface.own-surface-accepted, authorization.surface.unscoped-caller-rejected-for-document
#[test]
fn main_scope_is_explicit_and_cross_surface_is_rejected() {
    let document =
        serde_json::from_value(serde_json::json!({"surface":"tab-1","document":"page"})).unwrap();
    assert!(check_document(None, &document).is_err());
    assert!(check_document(Some("tab-2"), &document).is_err());
    assert!(check_document(Some("tab-1"), &document).is_ok());
    let image =
        serde_json::from_value(serde_json::json!({"surface":"tab-1","name":"view"})).unwrap();
    assert!(check_image(None, &image).is_err());
    assert!(check_image(Some("tab-2"), &image).is_err());
    assert!(check_image(Some("tab-1"), &image).is_ok());
}

// contract: authorization.main.known-main-caller-accepted, authorization.main.unknown-main-caller-rejected
#[test]
fn only_the_main_webview_of_the_window_calls_surface_operations() {
    assert!(authorize_main_caller("main", "main", "surface operations").is_ok());
    let error =
        authorize_main_caller("surface-main-tab-1", "main", "surface operations").unwrap_err();
    assert!(error.contains("must come from the main webview"), "{error}");
    assert!(authorize_main_caller("second", "main", "surface operations").is_err());
}
