use soksak_host_tauriv2::documents::check as check_document;
use soksak_host_tauriv2::images::check as check_image;

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
