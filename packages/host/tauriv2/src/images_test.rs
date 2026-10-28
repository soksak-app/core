use std::sync::{Arc, Mutex};

// contract: images.reload.captures-old-image-owner
#[test]
fn reload_captures_each_image_supplier_before_advancing_generation() {
    let images = super::Images::default();
    let surface = "surface-reload";
    let old_generation = images.begin_generation(surface);
    for name in ["second", "first"] {
        let key = (surface.to_string(), name.to_string());
        images.reserve(&key, "owner", "fixture-sidecar").unwrap();
        assert!(images.set(&key, name.len()));
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

mod presentation_queue {
    use super::super::present_on_ui;
    use std::sync::{Arc, Mutex, mpsc};
    use std::time::Duration;

    // contract: tauriv2.images.presentation.runs-after-framework-event
    #[test]
    fn image_commit_runs_after_the_framework_event_releases_its_lock() {
        let event_lock = Arc::new(Mutex::new(()));
        let event = event_lock.lock().expect("hold framework event lock");
        let commit_lock = Arc::clone(&event_lock);
        let (enqueue, queued) = mpsc::sync_channel::<Box<dyn FnOnce() + Send>>(1);
        let worker = std::thread::spawn(move || {
            present_on_ui(
                Box::new(move || {
                    let _guard = commit_lock.try_lock().map_err(|error| {
                        format!("redraw re-entered framework event lock: {error}")
                    })?;
                    Ok(())
                }),
                |work| enqueue.send(work).map_err(|error| error.to_string()),
            )
        });
        let callback = queued.recv_timeout(Duration::from_secs(2));
        drop(event);
        if let Ok(callback) = callback {
            callback();
        }
        let result = worker.join().expect("join image presentation worker");
        assert_eq!(
            result,
            Ok(()),
            "image commit must run outside the framework event lock"
        );
    }

    // contract: tauriv2.images.presentation.runs-after-framework-event
    #[test]
    fn image_enqueue_failure_reaches_the_frame_handler() {
        let result = present_on_ui(Box::new(|| panic!("refused work ran")), |_| {
            Err("native queue refused".into())
        });
        assert_eq!(result, Err("native queue refused".into()));
    }

    // contract: tauriv2.images.presentation.runs-after-framework-event
    #[test]
    fn native_image_failure_reaches_the_frame_handler() {
        let result = present_on_ui(
            Box::new(|| Err("native presentation refused".into())),
            |work| {
                work();
                Ok(())
            },
        );
        assert_eq!(result, Err("native presentation refused".into()));
    }
}

mod wait_boundary {
    use super::super::*;
    use std::sync::mpsc;

    // contract: images.wait.newer-sequence-rearms-wait
    #[test]
    fn a_pending_newer_frame_is_required_after_the_wait_begins() {
        let images = Images::default();
        let key = ("surface".into(), "view".into());
        images
            .reserve(&key, "owner", "sidecar")
            .expect("reserve image");
        assert!(images.set(&key, 100));
        let config = images
            .configure_raster(&key, 800, 600, 2.0, true)
            .expect("configure raster")
            .expect("new raster");
        images
            .lock()
            .states
            .get_mut(&key)
            .expect("image state")
            .last_sequence = 1;
        let began = Instant::now();
        let timeout = Duration::from_millis(500);
        let waiter = images.clone();
        let (started, waiting) = mpsc::sync_channel(1);
        let worker = std::thread::spawn(move || {
            waiter.wait_current_observed(timeout, || {
                started.send(()).expect("signal initialized wait")
            })
        });
        waiting
            .recv_timeout(Duration::from_secs(2))
            .expect("wait begins");
        let arrival_elapsed = {
            let mut inner = images.lock();
            let state = inner.states.get_mut(&key).expect("image state");
            state.presented_raster = config.raster;
            state.presented_sequence = 1;
            state.last_sequence = 2;
            images.changed();
            began.elapsed()
        };
        let result = worker.join().expect("join image wait");
        assert!(
            arrival_elapsed < timeout,
            "controlled arrival missed the active wait deadline: {arrival_elapsed:?}"
        );
        assert_eq!(
            result,
            Err("presentationTimeout".into()),
            "the newer accepted frame remains pending after the earlier frame completed"
        );
        assert!(
            !images.current_presented(),
            "instantaneous status still reports the pending newer frame"
        );
        assert_eq!(
            images.wait_current(Duration::ZERO),
            Err("presentationTimeout".into()),
            "a new wait must require the already accepted second frame"
        );
    }

    #[test]
    // contract: exposure.window.region-reports-presented-frame, images.wait.newer-sequence-rearms-wait
    fn an_in_flight_frame_presentation_is_recorded_after_a_newer_frame_is_accepted() {
        let images = Images::default();
        let key = ("surface-in-flight".into(), "view".into());
        images
            .reserve(&key, "owner", "sidecar")
            .expect("reserve image");
        assert!(images.set(&key, 100));
        let config = images
            .configure_raster(&key, 800, 600, 2.0, true)
            .expect("configure raster")
            .expect("new raster");
        let frame = |sequence| FrameIdentity {
            generation: config.generation,
            raster: config.raster,
            width: config.width,
            height: config.height,
            scale: config.scale,
            sequence,
        };

        images
            .authorize_frame(&key, "sidecar", frame(1))
            .expect("authorize first frame");
        assert_eq!(
            images.frame_status(&key, config.generation, config.raster, 1),
            Ok(()),
            "first frame passes freshness before native presentation starts"
        );
        images
            .authorize_frame(&key, "sidecar", frame(2))
            .expect("accept newer frame while the first native presentation is in flight");
        assert_eq!(
            images.frame_status(&key, config.generation, config.raster, 1),
            Err("stale"),
            "an older frame cannot start a native presentation after a newer acceptance"
        );
        assert_eq!(
            images.frame_status(&key, config.generation, config.raster, 2),
            Ok(()),
            "the latest frame remains eligible to start native presentation"
        );

        for (name, generation, raster, sequence) in [
            ("zero sequence", config.generation, config.raster, 0),
            ("future sequence", config.generation, config.raster, 3),
            ("wrong generation", config.generation + 1, config.raster, 1),
            ("wrong raster", config.generation, config.raster + 1, 1),
        ] {
            assert!(
                !images.mark_presented(&key, generation, raster, sequence),
                "{name} acknowledgment must not change image state"
            );
        }
        assert_eq!(
            images.presented_frame(&key),
            None,
            "invalid acknowledgments do not produce a presented frame"
        );
        assert!(
            images.mark_presented(&key, config.generation, config.raster, 1),
            "a successful in-flight acknowledgment remains recordable after a newer acceptance"
        );
        assert_eq!(
            images.presented_frame(&key),
            Some(PresentedFrame {
                generation: config.generation,
                raster: config.raster,
                sequence: 1,
            })
        );
        assert!(
            !images.current_presented(),
            "the latest-frame barrier still waits while sequence 2 is pending"
        );
        assert!(
            !images.mark_presented(&key, config.generation, config.raster, 1),
            "a duplicate acknowledgment does not change image state"
        );
        assert!(images.mark_presented(&key, config.generation, config.raster, 2));
        assert!(
            !images.mark_presented(&key, config.generation, config.raster, 1),
            "a regressing acknowledgment does not replace the newer presented sequence"
        );
        assert_eq!(
            images.presented_frame(&key).map(|frame| frame.sequence),
            Some(2)
        );
        assert!(
            images.current_presented(),
            "the latest-frame barrier completes only after sequence 2 is acknowledged"
        );
    }

    #[test]
    // contract: images.present.older-ack-preserves-newer-rejection
    fn an_older_in_flight_presentation_does_not_clear_a_newer_frame_failure() {
        let images = Images::default();
        let key = ("surface-in-flight-failure".into(), "view".into());
        images
            .reserve(&key, "owner", "sidecar")
            .expect("reserve image");
        assert!(images.set(&key, 100));
        let config = images
            .configure_raster(&key, 800, 600, 2.0, true)
            .expect("configure raster")
            .expect("new raster");
        for sequence in 1..=2 {
            images
                .authorize_frame(
                    &key,
                    "sidecar",
                    FrameIdentity {
                        generation: config.generation,
                        raster: config.raster,
                        width: config.width,
                        height: config.height,
                        scale: config.scale,
                        sequence,
                    },
                )
                .expect("authorize frame");
        }
        images.mark_presentation_failed(
            &key,
            config.generation,
            config.raster,
            2,
            "sequence 2 failed",
        );
        assert!(
            images.mark_presented(&key, config.generation, config.raster, 1),
            "successful in-flight sequence 1 acknowledgment was discarded"
        );
        assert_eq!(
            images.presented_frame(&key).map(|frame| frame.sequence),
            Some(1),
            "the actual older presentation remains recorded"
        );
        let inner = images.lock();
        let state = inner.states.get(&key).expect("image state");
        assert!(!state.configured, "the newer failure remains unconfigured");
        assert_eq!(
            state.presentation_error.as_deref(),
            Some("sequence 2 failed"),
            "the newer failure remains observable"
        );
    }

    #[test]
    // contract: images.wait.continuous-raster-snapshot, images.wait.newer-sequence-rearms-wait
    fn continuous_image_wait_uses_the_installed_snapshot_and_blocks_after_generation_or_raster_change()
     {
        let images = Images::default();
        let key = ("surface-continuous-snapshot".into(), "view".into());
        images
            .reserve(&key, "owner", "sidecar")
            .expect("reserve image");
        assert!(images.set(&key, 100));
        let config = images
            .configure_raster(&key, 800, 600, 2.0, true)
            .expect("configure raster")
            .expect("new raster");
        for sequence in 1..=2 {
            images
                .authorize_frame(
                    &key,
                    "sidecar",
                    FrameIdentity {
                        generation: config.generation,
                        raster: config.raster,
                        width: config.width,
                        height: config.height,
                        scale: config.scale,
                        sequence,
                    },
                )
                .expect("authorize frame");
            if sequence == 1 {
                assert!(images.mark_presented(&key, config.generation, config.raster, sequence));
            }
        }
        assert_eq!(
            images.wait_layout_rasters(Duration::ZERO, false),
            Ok(()),
            "continuous wait completes from the installed raster snapshot after a later same-raster acceptance"
        );
        assert_eq!(
            images.wait_layout_rasters(Duration::ZERO, true),
            Err("presentationTimeout".into()),
            "settled wait continues to require the newest sequence"
        );
        assert_eq!(
            images.presented_frame(&key),
            Some(PresentedFrame {
                generation: config.generation,
                raster: config.raster,
                sequence: 1,
            })
        );

        let old_generation = config.generation;
        let new_generation = images.begin_generation(&key.0);
        assert_eq!(
            images.presented_frame(&key),
            None,
            "the previous generation is no longer the installed snapshot"
        );
        let new_config = images
            .configure_raster(&key, 800, 600, 2.0, true)
            .expect("configure same raster in new generation")
            .expect("new-generation raster configuration");
        assert_eq!(new_config.generation, new_generation);
        assert_eq!(new_config.raster, config.raster);
        images
            .authorize_frame(
                &key,
                "sidecar",
                FrameIdentity {
                    generation: new_generation,
                    raster: new_config.raster,
                    width: new_config.width,
                    height: new_config.height,
                    scale: new_config.scale,
                    sequence: 1,
                },
            )
            .expect("authorize new-generation sequence");
        assert!(
            !images.mark_presented(&key, old_generation, config.raster, 1),
            "an acknowledgment from the previous generation is refused"
        );
        assert_eq!(
            images.wait_raster_snapshot_observed(Duration::ZERO, || {}),
            Err("presentationTimeout".into()),
            "an accepted but unpresented new-generation frame blocks completion"
        );
        assert!(images.mark_presented(&key, new_generation, new_config.raster, 1));
        assert_eq!(
            images.wait_raster_snapshot_observed(Duration::ZERO, || {}),
            Ok(())
        );

        let raster_config = images
            .configure_raster(&key, 801, 600, 2.0, true)
            .expect("configure changed raster")
            .expect("new raster");
        assert_ne!(raster_config.raster, new_config.raster);
        assert_eq!(
            images.wait_raster_snapshot_observed(Duration::ZERO, || {}),
            Err("presentationTimeout".into()),
            "a changed raster has no installed snapshot"
        );
        images
            .authorize_frame(
                &key,
                "sidecar",
                FrameIdentity {
                    generation: raster_config.generation,
                    raster: raster_config.raster,
                    width: raster_config.width,
                    height: raster_config.height,
                    scale: raster_config.scale,
                    sequence: 1,
                },
            )
            .expect("authorize changed-raster sequence");
        assert_eq!(
            images.wait_raster_snapshot_observed(Duration::ZERO, || {}),
            Err("presentationTimeout".into()),
            "an accepted but unpresented changed raster blocks completion"
        );
        assert!(images.mark_presented(&key, raster_config.generation, raster_config.raster, 1));
        assert_eq!(
            images.wait_raster_snapshot_observed(Duration::ZERO, || {}),
            Ok(())
        );
    }

    #[test]
    // contract: images.wait.continuous-raster-snapshot
    fn beginning_new_generation_clears_the_presented_image_snapshot() {
        let images = Images::default();
        let key = ("surface-generation-snapshot".into(), "view".into());
        images
            .reserve(&key, "owner", "sidecar")
            .expect("reserve image");
        assert!(images.set(&key, 100));
        let config = images
            .configure_raster(&key, 800, 600, 2.0, true)
            .expect("configure raster")
            .expect("new raster");
        images
            .authorize_frame(
                &key,
                "sidecar",
                FrameIdentity {
                    generation: config.generation,
                    raster: config.raster,
                    width: config.width,
                    height: config.height,
                    scale: config.scale,
                    sequence: 1,
                },
            )
            .expect("authorize frame");
        assert!(images.mark_presented(&key, config.generation, config.raster, 1));
        assert!(images.presented_frame(&key).is_some());
        images.begin_generation(&key.0);
        assert_eq!(
            images.presented_frame(&key),
            None,
            "the previous-generation frame remained current"
        );
    }

    #[test]
    // contract: images.wait.continuous-raster-snapshot
    fn continuous_image_wait_ignores_hidden_regions_and_fails_on_presentation_error() {
        let images = Images::default();
        let hidden_key = ("surface-continuous-hidden".into(), "view".into());
        images
            .reserve(&hidden_key, "owner", "sidecar")
            .expect("reserve hidden image");
        assert!(images.set(&hidden_key, 100));
        assert!(
            images
                .configure_raster(&hidden_key, 800, 600, 2.0, false)
                .expect("configure hidden image")
                .is_none()
        );
        assert_eq!(
            images.wait_raster_snapshot_observed(Duration::ZERO, || {}),
            Ok(()),
            "a hidden image does not block continuous wait"
        );
        images.set_surface_visible(&hidden_key.0, false);
        assert_eq!(
            images.wait_raster_snapshot_observed(Duration::ZERO, || {}),
            Ok(()),
            "a hidden surface does not block continuous wait"
        );

        let visible_key = ("surface-continuous-error".into(), "view".into());
        images
            .reserve(&visible_key, "owner", "sidecar")
            .expect("reserve visible image");
        assert!(images.set(&visible_key, 101));
        let config = images
            .configure_raster(&visible_key, 800, 600, 2.0, true)
            .expect("configure visible image")
            .expect("visible raster");
        images
            .authorize_frame(
                &visible_key,
                "sidecar",
                FrameIdentity {
                    generation: config.generation,
                    raster: config.raster,
                    width: config.width,
                    height: config.height,
                    scale: config.scale,
                    sequence: 1,
                },
            )
            .expect("authorize visible frame");
        images.mark_presentation_failed(
            &visible_key,
            config.generation,
            config.raster,
            1,
            "continuous presentation failed",
        );
        assert_eq!(
            images.wait_raster_snapshot_observed(Duration::ZERO, || {}),
            Err("continuous presentation failed".into()),
            "presentation failure remains fail-closed"
        );
    }
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
// contract: exposure.window.region-reports-presented-frame
#[test]
fn presenting_a_frame_notifies_after_its_identity_is_current() {
    let images = super::Images::default();
    let key = ("tab-1".to_string(), "view".to_string());
    images.begin_generation(&key.0);
    images.reserve(&key, "owner", "sidecar-a").unwrap();
    assert!(images.set(&key, 100));
    let raster = images
        .configure_raster(&key, 800, 600, 2.0, true)
        .unwrap()
        .unwrap();
    let body = serde_json::json!({
        "image": {
            "name": "view",
            "token": {
                "kind": "iosurface-global",
                "id": 12345u32,
                "nonce": "AAAAAAAAAAAAAAAAAAAAAA=="
            },
            "width": raster.width,
            "height": raster.height,
            "scale": raster.scale,
            "format": "bgra8",
            "generation": raster.generation,
            "raster": raster.raster,
            "sequence": 2
        }
    })
    .to_string();
    let notified = Arc::new(Mutex::new(None));
    let received = Arc::clone(&notified);
    let current_images = images.clone();
    let current_key = key.clone();
    assert!(super::handle_envelope_with_recovery(
        &body,
        "sidecar-a",
        &key.0,
        &images,
        |_work| Ok(()),
        |_image, _response| Ok(()),
        |_| Ok(()),
        || true,
        move || *received.lock().unwrap() = current_images.presented_frame(&current_key),
    ));
    let frame = notified
        .lock()
        .unwrap()
        .expect("the presented frame notification");
    assert_eq!(frame.generation, raster.generation);
    assert_eq!(frame.raster, raster.raster);
    assert_eq!(frame.sequence, 2);
}

// contract: exposure.window.region-reports-presented-frame
#[test]
fn failed_or_retired_frame_does_not_notify_the_window() {
    let images = super::Images::default();
    let key = ("tab-1".to_string(), "view".to_string());
    images.begin_generation(&key.0);
    images.reserve(&key, "owner", "sidecar-a").unwrap();
    assert!(images.set(&key, 100));
    let raster = images
        .configure_raster(&key, 800, 600, 2.0, true)
        .unwrap()
        .unwrap();
    let body = serde_json::json!({
        "image": {
            "name": "view",
            "token": {
                "kind": "iosurface-global",
                "id": 12345u32,
                "nonce": "AAAAAAAAAAAAAAAAAAAAAA=="
            },
            "width": raster.width,
            "height": raster.height,
            "scale": raster.scale,
            "format": "bgra8",
            "generation": raster.generation,
            "raster": raster.raster,
            "sequence": 1
        }
    })
    .to_string();
    assert!(super::handle_envelope_with_recovery(
        &body,
        "sidecar-a",
        &key.0,
        &images,
        |_work| Err("presentFailed".to_string()),
        |_image, _response| Ok(()),
        |_| Ok(()),
        || true,
        || panic!("a failed image frame notified the window"),
    ));
    assert_eq!(images.presented_frame(&key), None);

    let mut retired_body: serde_json::Value = serde_json::from_str(&body).unwrap();
    retired_body["image"]["sequence"] = serde_json::json!(2);
    let retired_images = images.clone();
    let retired_key = key.clone();
    assert!(super::handle_envelope_with_recovery(
        &retired_body.to_string(),
        "sidecar-a",
        &key.0,
        &images,
        move |_work| {
            retired_images.begin_generation(&retired_key.0);
            Ok(())
        },
        |_image, _response| Ok(()),
        |_| Ok(()),
        || true,
        || panic!("a retired image frame notified the window"),
    ));
    assert_eq!(images.presented_frame(&key), None);
}
