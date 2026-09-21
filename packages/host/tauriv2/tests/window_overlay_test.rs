use soksak_host_tauriv2::platform::{visible_window_overlay_rects, WindowOverlay};

#[test]
fn packs_two_rects_with_four_values_each() {
    let overlays = [
        WindowOverlay {
            x: 1.0,
            y: 2.0,
            w: 3.0,
            h: 4.0,
            visible: true,
        },
        WindowOverlay {
            x: 5.0,
            y: 6.0,
            w: 7.0,
            h: 8.0,
            visible: true,
        },
    ];
    assert_eq!(
        visible_window_overlay_rects(&overlays),
        vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0]
    );
}

#[test]
fn filters_hidden_rects() {
    let overlays = [
        WindowOverlay {
            x: 1.0,
            y: 2.0,
            w: 3.0,
            h: 4.0,
            visible: false,
        },
        WindowOverlay {
            x: 5.0,
            y: 6.0,
            w: 7.0,
            h: 8.0,
            visible: true,
        },
    ];
    assert_eq!(
        visible_window_overlay_rects(&overlays),
        vec![5.0, 6.0, 7.0, 8.0]
    );
}
