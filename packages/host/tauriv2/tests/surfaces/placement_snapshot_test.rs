use super::*;

#[test]
fn prepared_frames_share_one_main_thread_turn() {
    let mut turns = 0;
    let placements = read_surface_placements(
        vec![(1, "first".into(), true), (2, "second".into(), false)],
        |targets| {
            turns += 1;
            Ok(targets
                .into_iter()
                .map(|(_, id, visible)| Placement {
                    id,
                    x: turns as f64,
                    y: 0.0,
                    w: 10.0,
                    h: 10.0,
                    visible,
                })
                .collect())
        },
    )
    .expect("read prepared frames");
    assert_eq!(
        turns, 1,
        "one placement reply must use one main-thread turn"
    );
    assert_eq!(
        placements[0].x, placements[1].x,
        "frames must share the same native turn"
    );
    assert_eq!(placements[0].id, "first");
    assert_eq!(placements[1].id, "second");
    assert!(placements[0].visible);
    assert!(!placements[1].visible);
}

#[test]
fn frame_read_failure_rejects_the_placement_reply() {
    let result = read_surface_placements(vec![(1, "first".into(), true)], |_| {
        Err("frame read failed".into())
    });
    assert_eq!(result.err().as_deref(), Some("frame read failed"));
}

#[test]
fn no_surfaces_require_no_main_thread_turn() {
    let placements = read_surface_placements(vec![], |_| panic!("empty placement dispatched"))
        .expect("empty placement succeeds");
    assert!(placements.is_empty());
}
