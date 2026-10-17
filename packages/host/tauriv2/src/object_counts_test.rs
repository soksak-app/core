use crate::platform::Handle;
use crate::surfaces::Views;

/// The surface count of diagnostics.objects is the number of native views of the surfaces of the window, and it falls
/// back when a view is removed.
// contract: diagnostics.objects.counts-host-objects
#[test]
fn the_surface_count_follows_the_views_of_the_window() {
    let views = Views::default();
    assert_eq!(views.count().unwrap(), 0);
    views
        .0
        .lock()
        .unwrap()
        .insert(1 as Handle, "tab-1".to_string());
    views
        .0
        .lock()
        .unwrap()
        .insert(2 as Handle, "tab-2".to_string());
    assert_eq!(views.count().unwrap(), 2);
    views.0.lock().unwrap().remove(&(1 as Handle));
    assert_eq!(views.count().unwrap(), 1);
}
