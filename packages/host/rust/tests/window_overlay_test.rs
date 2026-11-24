use soksak_host::platform::{WindowOverlay, visible_window_overlay_rects};

// contract: window-overlay.rects.packs-five-values-per-rect
#[test]
fn packs_the_cut_of_each_rect() {
    let overlays = [
        WindowOverlay {
            x: 1.0,
            y: 2.0,
            w: 3.0,
            h: 4.0,
            visible: true,
            cut: false,
        },
        WindowOverlay {
            x: 5.0,
            y: 6.0,
            w: 7.0,
            h: 8.0,
            visible: true,
            cut: true,
        },
    ];
    assert_eq!(
        visible_window_overlay_rects(&overlays),
        vec![1.0, 2.0, 3.0, 4.0, 0.0, 5.0, 6.0, 7.0, 8.0, 1.0]
    );
}

// contract: window-overlay.rects.filters-hidden
#[test]
fn filters_hidden_rects() {
    let overlays = [
        WindowOverlay {
            x: 1.0,
            y: 2.0,
            w: 3.0,
            h: 4.0,
            visible: false,
            cut: false,
        },
        WindowOverlay {
            x: 5.0,
            y: 6.0,
            w: 7.0,
            h: 8.0,
            visible: true,
            cut: false,
        },
    ];
    assert_eq!(
        visible_window_overlay_rects(&overlays),
        vec![5.0, 6.0, 7.0, 8.0, 0.0]
    );
}
