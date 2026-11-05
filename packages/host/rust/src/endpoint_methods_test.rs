use super::*;

// The method that makes a covered window draw its regions is a diagnostic method.
#[cfg(feature = "diagnostics")]
#[test]
fn draw_covered_is_a_diagnostic_method() {
    assert!(DIAGNOSTICS.contains(&"diagnostics.window.draw-covered"));
}

// A build without the diagnostics feature has no way to make a covered window draw.
#[cfg(not(feature = "diagnostics"))]
#[test]
fn a_build_without_diagnostics_declares_no_draw_covered() {
    assert!(!declared("diagnostics.window.draw-covered"));
}
