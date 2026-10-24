// contract: images.reload.captures-old-image-owner
#[test]
fn reload_captures_each_image_supplier_before_advancing_generation() {
    let images = super::Images::default();
    let surface = "surface-reload";
    let old_generation = images.begin_generation(surface);
    for name in ["second", "first"] {
        let key = (surface.to_string(), name.to_string());
        images.reserve(&key, "owner", "fixture-sidecar").unwrap();
        assert!(images.set(&key, name.len() as usize));
    }

    let targets = images.begin_reload(surface);
    assert_eq!(
        targets,
        [
            super::DetachTarget {
                surface: surface.to_string(),
                name: "first".to_string(),
                sidecar: "fixture-sidecar".to_string(),
                generation: old_generation,
            },
            super::DetachTarget {
                surface: surface.to_string(),
                name: "second".to_string(),
                sidecar: "fixture-sidecar".to_string(),
                generation: old_generation,
            },
        ]
    );

    assert!(
        targets
            .iter()
            .all(|target| target.generation == old_generation),
        "detach requests retain the generation that owned the image before reload"
    );
}

// contract: images.detach.timeout-retains-target
#[test]
fn a_timed_out_detach_target_remains_for_the_next_page_start() {
    let images = super::Images::default();
    let surface = "surface-retry";
    let old_generation = images.begin_generation(surface);
    let key = (surface.to_string(), "region".to_string());
    images.reserve(&key, "owner", "fixture-sidecar").unwrap();
    assert!(images.set(&key, 1));

    let timed_out = images.begin_reload(surface);
    assert_eq!(images.begin_reload(surface), timed_out);
    images.remove_surface(surface);
    let retried = images.begin_reload(surface);

    assert_eq!(retried, timed_out);
    assert_eq!(retried[0].generation, old_generation);

    images.complete_detachments(&retried);
    assert!(images.begin_reload(surface).is_empty());
}

// contract: images.detach.timeout-retains-target
#[test]
fn a_timed_out_detach_keeps_its_supplier_in_the_next_reconnect_targets() {
    let images = super::Images::default();
    let surface = "surface-reconnect-retry";
    images.begin_generation(surface);
    let key = (surface.to_string(), "region".to_string());
    images.reserve(&key, "owner", "fixture-sidecar").unwrap();
    assert!(images.set(&key, 1));

    let _unacknowledged = images.begin_reload(surface);
    images.remove_surface(surface);

    let mut sidecars = images.sidecars_for_surface(surface);
    sidecars.sort();
    assert_eq!(
        sidecars,
        ["fixture-sidecar"],
        "a timeout retains the supplier needed by the next page reload"
    );
}

// contract: images.detach.timeout-retains-target
#[test]
fn ending_a_surface_clears_its_unacknowledged_detach_targets() {
    let images = super::Images::default();
    let surface = "surface-ended";
    images.begin_generation(surface);
    let key = (surface.to_string(), "region".to_string());
    images.reserve(&key, "owner", "fixture-sidecar").unwrap();
    assert!(images.set(&key, 1));
    images.begin_reload(surface);
    images.remove_surface(surface);

    images.end_generation(surface);

    assert!(images.sidecars_for_surface(surface).is_empty());
    assert!(images.begin_reload(surface).is_empty());
}
