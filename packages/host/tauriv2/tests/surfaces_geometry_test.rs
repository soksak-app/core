use soksak_host_tauriv2::surfaces::validate_rect;

#[test]
fn rejects_non_finite_and_negative_surface_geometry_without_fallback() {
    assert!(validate_rect("surface", 0.0, 0.0, 0.0, 10.0).is_ok());
    assert!(validate_rect("surface", 0.0, 0.0, -0.1, 10.0)
        .unwrap_err()
        .contains("negative size"));
    assert!(validate_rect("surface", 0.0, 0.0, f64::NAN, 10.0)
        .unwrap_err()
        .contains("finite"));
}
