use std::collections::HashMap;

use soksak_host_tauriv2::surface_owner_id;

#[test]
fn surface_owner_id_only_resolves_registered_native_views() {
    let named = HashMap::from([(101usize, "tab-1".to_string()), (202, "tab-2".to_string())]);
    assert_eq!(surface_owner_id(&named, 101), Some("tab-1"));
    assert_eq!(surface_owner_id(&named, 303), None);
    assert_eq!(surface_owner_id(&HashMap::from([(101, String::new())]), 101), None);
}
