use std::collections::HashMap;

use soksak_host_tauriv2::surface_owner_id;
use soksak_host_tauriv2::surfaces::create_logical_surface_handle;

// contract: surface-activation.owner.resolves-registered-view, surface-activation.owner.ignores-unknown-view, surface-activation.owner.ignores-empty-owner
#[test]
fn surface_owner_id_only_resolves_registered_native_views() {
    let named = HashMap::from([(101usize, "tab-1".to_string()), (202, "tab-2".to_string())]);
    assert_eq!(surface_owner_id(&named, 101), Some("tab-1"));
    assert_eq!(surface_owner_id(&named, 303), None);
    assert_eq!(
        surface_owner_id(&HashMap::from([(101, String::new())]), 101),
        None
    );
}

// contract: surface-activation.create.propagates-native-failure
#[test]
fn logical_surface_creation_propagates_a_native_failure() {
    let error = create_logical_surface_handle(|| Err("native surface unavailable".into()), "tab-1")
        .unwrap_err();
    assert!(
        error.contains("native surface unavailable") && error.contains("tab-1"),
        "{error}"
    );
}

// contract: surface-activation.create.rejects-nil-handle
#[test]
fn logical_surface_creation_rejects_a_nil_handle() {
    let error = create_logical_surface_handle(|| Ok(0), "tab-1").unwrap_err();
    assert!(error.contains("nil handle"), "{error}");
    assert_eq!(create_logical_surface_handle(|| Ok(7), "tab-1"), Ok(7));
}
