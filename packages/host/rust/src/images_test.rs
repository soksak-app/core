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

fn attached_images(surface: &str) -> super::Images {
    let images = super::Images::default();
    images.begin_generation(surface);
    let key = (surface.to_string(), "region".to_string());
    images.reserve(&key, "owner", "fixture-sidecar").unwrap();
    assert!(images.set(&key, 1));
    images
}

/// A window of a framework that holds queued tasks, with records in which surface declares the image region name. Its
/// native window fails, so an attach ends at its read of the window state, before it reaches the native platform.
fn attach_fixture(
    surface: &str,
    name: &str,
) -> (
    crate::framework::Webview,
    Arc<crate::windows::WindowData>,
    Arc<crate::test_framework::Fixture>,
) {
    use crate::framework::Manager;
    use crate::surfaces::{SurfaceComposition, SurfaceRegion};
    let (app, framework) = crate::test_framework::application_with_queue();
    let frontend = Arc::new(
        crate::test_framework::FixtureFrontend::without_native_window(
            "the test window has no native window",
        ),
    );
    let webview = app.webview_of(frontend, "fixture");
    let records = Arc::new(crate::windows::WindowData::default());
    let windows = crate::windows::Windows::default();
    crate::windows::register_records(&windows, "fixture", records.clone());
    app.manage(windows);
    records.compositions.lock().unwrap().insert(
        surface.to_string(),
        SurfaceComposition {
            kind: "view".into(),
            page: String::new(),
            regions: vec![SurfaceRegion {
                name: name.to_string(),
                kind: "image".into(),
                sidecar: "fixture-sidecar".into(),
                present: "copy".into(),
                input: String::new(),
            }],
            overlays: None,
        },
    );
    (webview, records, framework)
}

/// The error records of the image region name. The buffer holds the records of every test of the binary.
fn image_error_records(name: &str) -> Vec<serde_json::Value> {
    crate::event_record::buffered_fields("host.record.error")
        .into_iter()
        .filter(|fields| fields["where"] == format!("image {name}"))
        .collect()
}

fn attach_request(surface: &str, name: &str) -> super::Request {
    super::Request {
        surface: surface.to_string(),
        name: name.to_string(),
        sidecar: Some("fixture-sidecar".to_string()),
    }
}

// contract: images.attach.one-main-step
#[test]
fn a_surface_close_during_an_image_attach_finds_no_name_of_the_attach() {
    let (surface, name) = ("attach-close-surface", "attach-close-region");
    let (webview, records, framework) = attach_fixture(surface, name);
    let closed = records.clone();
    // The close of the page's surface list, which runs on the main thread ahead of the main-thread work of the attach.
    framework.queue(move || {
        closed.images.begin_generation(surface);
        closed.images.remove_surface(surface);
        closed.images.end_generation(surface);
        closed.compositions.lock().unwrap().remove(surface);
    });
    let attached = super::attach(&webview, attach_request(surface, name));
    assert!(attached.is_err(), "the attach of a closed surface fails");
    assert_eq!(
        image_error_records(name),
        Vec::<serde_json::Value>::new(),
        "the close leaves the attach no name to take back, so nothing fails after the failure of the attach"
    );
}

// contract: images.attach.one-main-step
#[test]
fn a_failed_attach_takes_back_its_name() {
    let (surface, name) = ("attach-failed-surface", "attach-failed-region");
    let (webview, records, _framework) = attach_fixture(surface, name);
    assert_eq!(
        super::attach(&webview, attach_request(surface, name)).unwrap_err(),
        "the test window has no native window"
    );
    let key = (surface.to_string(), name.to_string());
    records
        .images
        .reserve(&key, "owner", "fixture-sidecar")
        .expect("the failed attach took back its name");
    assert_eq!(
        image_error_records(name),
        Vec::<serde_json::Value>::new(),
        "taking back the name of the failed attach records no error"
    );
}

// contract: images.detach.timeout-keeps-waiting
#[test]
fn a_reload_sends_no_second_detach_for_a_pending_image() {
    let surface = "surface-retry";
    let images = attached_images(surface);
    let first = images.begin_reload(surface);
    assert_eq!(first.len(), 1);
    images.add_pending_detach(&first[0], "request-1");
    images.remove_surface(surface);
    let key = (surface.to_string(), "region".to_string());
    images.reserve(&key, "owner", "fixture-sidecar").unwrap();
    assert!(images.set(&key, 2));

    assert!(images.begin_reload(surface).is_empty());
    images.detach_page_ready();
    assert!(
        images
            .end_pending_detach(&first[0], "request-1", None, false)
            .is_some()
    );
    let next = images.begin_reload(surface);
    assert_eq!(next.len(), 1);
    assert!(next[0].generation > first[0].generation);
}

// contract: images.detach.pending-surface-is-refused
#[test]
fn a_pending_detach_refuses_only_its_surface() {
    let images = attached_images("surface-a");
    let targets = images.begin_reload("surface-a");
    images.add_pending_detach(&targets[0], "request-1");

    assert_eq!(
        images.pending_detach_error("surface-a"),
        Err(format!(
            "image detach sidecar fixture-sidecar surface surface-a image region generation {} request request-1 is pending",
            targets[0].generation
        ))
    );
    assert_eq!(images.pending_detach_error("surface-b"), Ok(()));
}

// contract: images.detach.surface-ends-after-its-last-detach, images.detach.refusal-ends-pending
#[test]
fn the_last_end_of_a_surface_carries_each_failure_in_byte_wise_image_name_order() {
    let images = super::Images::default();
    images.begin_generation("surface-a");
    for (handle, name) in [(1, "b"), (2, "B"), (3, "a")] {
        let key = ("surface-a".to_string(), name.to_string());
        images.reserve(&key, "owner", "fixture-sidecar").unwrap();
        assert!(images.set(&key, handle));
    }
    images.detach_page_ready();
    let targets = images.begin_reload("surface-a");
    for (index, target) in targets.iter().enumerate() {
        images.add_pending_detach(target, &format!("request-{index}"));
    }
    let named = |name: &str| {
        targets
            .iter()
            .position(|target| target.name == name)
            .unwrap()
    };

    assert_eq!(
        images.end_pending_detach(&targets[named("b")], "request-other", None, false),
        None
    );
    assert_eq!(
        images.end_pending_detach(
            &targets[named("b")],
            &format!("request-{}", named("b")),
            Some("failure b".into()),
            false
        ),
        None
    );
    assert_eq!(
        images.end_pending_detach(
            &targets[named("a")],
            &format!("request-{}", named("a")),
            None,
            false
        ),
        None
    );
    assert_eq!(
        images.end_pending_detach(
            &targets[named("B")],
            &format!("request-{}", named("B")),
            Some("failure B".into()),
            false
        ),
        Some(serde_json::json!({"surface": "surface-a", "error": "failure B; failure b"}))
    );
}

// contract: images.detach.session-end-releases
#[test]
fn a_session_end_builds_no_ended_event() {
    let images = attached_images("surface-a");
    images.detach_page_ready();
    let targets = images.begin_reload("surface-a");
    images.add_pending_detach(&targets[0], "request-1");

    assert_eq!(
        images.end_pending_detach(&targets[0], "request-1", None, true),
        None
    );
    assert_eq!(images.pending_detach_error("surface-a"), Ok(()));
}

// contract: images.detach.ended-event-waits-for-ready
#[test]
fn an_end_before_the_page_is_ready_is_returned_when_it_reports_ready() {
    let images = attached_images("surface-a");
    images.detach_page_starting();
    let targets = images.begin_reload("surface-a");
    images.add_pending_detach(&targets[0], "request-1");

    assert_eq!(images.pending_detach_surfaces(), ["surface-a"]);
    assert_eq!(
        images.end_pending_detach(&targets[0], "request-1", None, false),
        None
    );
    assert_eq!(
        images.detach_page_ready(),
        [serde_json::json!({"surface": "surface-a", "error": null})]
    );
    assert!(images.detach_page_ready().is_empty());
}

// contract: images.detach.ended-event-waits-for-ready
#[test]
fn a_page_start_returns_the_failures_of_the_ends_it_clears() {
    let images = attached_images("surface-a");
    images.detach_page_starting();
    let targets = images.begin_reload("surface-a");
    images.add_pending_detach(&targets[0], "request-1");
    images.end_pending_detach(&targets[0], "request-1", Some("failure".into()), false);

    assert_eq!(images.detach_page_starting(), ["failure"]);
    assert!(images.detach_page_ready().is_empty());
}

mod presentation_queue {
    use super::super::present_on_ui;
    use std::sync::{Arc, Mutex, mpsc};
    use std::time::Duration;

    // contract: images.presentation.runs-after-framework-event
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

    // contract: images.presentation.runs-after-framework-event
    #[test]
    fn image_enqueue_failure_reaches_the_frame_handler() {
        let result = present_on_ui(Box::new(|| panic!("refused work ran")), |_| {
            Err("native queue refused".into())
        });
        assert_eq!(result, Err("native queue refused".into()));
    }

    // contract: images.presentation.runs-after-framework-event
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

    // The end of the connection of a sidecar ends the raster wait of its regions in that turn, because no raster of the ended
    // connection comes (docs/spec/native-surfaces.md#layout-transaction).
    // contract: images.wait.sidecar-end-ends-wait
    #[test]
    fn the_end_of_a_sidecar_ends_the_raster_wait_of_its_regions() {
        let images = Images::default();
        let key = ("surface".into(), "view".into());
        images
            .reserve(&key, "owner", "sidecar")
            .expect("reserve image");
        assert!(images.set(&key, 100));
        images
            .configure_raster(&key, 800, 600, 2.0, true)
            .expect("configure raster")
            .expect("new raster");
        images
            .lock()
            .states
            .get_mut(&key)
            .expect("image state")
            .last_sequence = 1;
        let waiter = images.clone();
        let (started, waiting) = mpsc::sync_channel(1);
        let (ended, result) = mpsc::channel();
        std::thread::spawn(move || {
            let outcome = waiter.wait_current_observed(Duration::from_secs(60), || {
                started.send(()).expect("signal initialized wait")
            });
            let _ = ended.send(outcome);
        });
        waiting
            .recv_timeout(Duration::from_secs(2))
            .expect("wait begins");
        assert_eq!(images.invalidate_sidecar("sidecar"), 1);
        let outcome = result
            .recv_timeout(Duration::from_secs(5))
            .expect("the end of the sidecar did not end the raster wait");
        assert!(
            outcome.as_ref().is_err_and(|error| error.contains("sidecar")),
            "the raster wait ended without the end of its sidecar: {outcome:?}"
        );
    }

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

// contract: exposure.window.region-reports-presented-frames
#[test]
fn window_region_counts_the_frames_that_the_host_marked_presented() {
    let images = super::Images::default();
    let key = ("tab-1".to_string(), "view".to_string());
    let attach = || {
        images.reserve(&key, "owner", "sidecar-a").unwrap();
        assert!(images.set(&key, 100));
    };
    let facts = r#"{"frame":{"x":0,"y":0,"width":400,"height":300},"visible":true,"focused":false,"presented":{"width":800,"height":600,"scale":2},"error":null}"#;
    let presented_frames = |want: u64, after: &str| {
        let region = crate::exposure::window_region(&images, key.clone(), facts)
            .unwrap_or_else(|error| panic!("{after}: window region: {error}"));
        assert_eq!(
            region["presentedFrames"],
            serde_json::json!(want),
            "{after}: host.window region entry {region}"
        );
    };
    let present = |config: &super::Configure, sequence: i32| {
        images
            .authorize_frame(
                &key,
                "sidecar-a",
                super::FrameIdentity {
                    generation: config.generation,
                    raster: config.raster,
                    width: config.width,
                    height: config.height,
                    scale: config.scale,
                    sequence,
                },
            )
            .unwrap_or_else(|reason| panic!("authorize frame {sequence}: {reason}"));
        images.mark_presented(&key, config.generation, config.raster, sequence)
    };

    attach();
    presented_frames(0, "a new region");
    let config = images
        .configure_raster(&key, 800, 600, 2.0, true)
        .unwrap()
        .unwrap();
    assert!(
        present(&config, 1) && present(&config, 2),
        "a current frame was not marked presented"
    );
    presented_frames(2, "two presented frames");
    // A frame that the host does not mark presented is not counted.
    assert!(
        !images.mark_presented(&key, config.generation, config.raster, 2),
        "a frame was marked presented twice"
    );
    presented_frames(2, "a refused presentation mark");
    // A raster change does not restart the count, because the count belongs to the region.
    let config = images
        .configure_raster(&key, 900, 600, 2.0, true)
        .unwrap()
        .unwrap();
    assert!(
        present(&config, 1),
        "a frame of the new raster was not marked presented"
    );
    presented_frames(3, "a frame of a new raster");
    // A region attached again under the same name is a new region and counts from 0.
    images.remove(&key).unwrap();
    attach();
    presented_frames(0, "a region attached again");
}

// contract: window.facts.region-reports-its-blur
#[test]
fn window_region_reports_its_native_blur() {
    let images = super::Images::default();
    let key = ("tab-1".to_string(), "view".to_string());
    images.reserve(&key, "owner", "sidecar-a").unwrap();
    assert!(images.set(&key, 100));
    for blurred in [true, false] {
        let facts = format!(
            r#"{{"frame":{{"x":0,"y":0,"width":400,"height":300}},"visible":true,"focused":false,"blurred":{blurred},"presented":null,"error":null}}"#
        );
        let region = crate::exposure::window_region(&images, key.clone(), &facts).unwrap();
        assert_eq!(
            region["blurred"],
            serde_json::json!(blurred),
            "host.window region entry {region}"
        );
    }
}

// contract: modal.region-under-a-dialog-starts-blurred
#[test]
fn an_image_region_made_under_a_dialog_starts_blurred() {
    let seated = |overlay: &crate::modals::Overlay| {
        let background = std::cell::Cell::new(None);
        super::seat_background(overlay, 7, |handle, enabled| {
            assert_eq!(handle, 7);
            background.set(Some(enabled));
            Ok(())
        })
        .unwrap();
        background.get()
    };
    let overlay = crate::modals::Overlay::default();
    assert_eq!(seated(&overlay), Some(false), "no modal is open");
    crate::modals::open_for_test(&overlay, "dialog");
    assert_eq!(seated(&overlay), Some(true), "a dialog is open");
    crate::modals::open_for_test(&overlay, "menu");
    assert_eq!(seated(&overlay), Some(false), "a menu is open");
}

// The window event removes the records of a window and closes its surfaces at the supplier before the main-thread step
// closes the regions, so the release of a region that closes with its window comes after the window closed.
// contract: images.lease.release-after-window-close-sends-nothing
#[test]
fn a_release_after_its_window_closed_sends_nothing_and_reports_no_failure() {
    let closed: Result<Arc<crate::windows::WindowData>, String> =
        Err("project window is closed".to_string());
    let mut sent = false;
    let result = super::send_released(&closed, "view", (1, 2, 3), |_, _| {
        sent = true;
        Ok(())
    });
    assert_eq!(
        result,
        Ok(()),
        "the supplier already received the close of the surface, so the release has nothing to do"
    );
    assert!(
        !sent,
        "a message after the close would open the surface again"
    );
}

// contract: images.lease.released-carries-frame-identity
#[test]
fn a_release_of_an_open_window_sends_the_frame_with_the_root_of_the_window() {
    let data = Arc::new(crate::windows::WindowData::default());
    *data.root.lock().unwrap() = "/project".to_string();
    let mut sent = None;
    let result = super::send_released(&Ok(data), "view", (1, 2, 3), |root, body| {
        sent = Some((root, body.get().to_string()));
        Ok(())
    });
    assert_eq!(result, Ok(()));
    let (root, body) = sent.expect("the release of an open window is sent");
    assert_eq!(root, "/project");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&body).unwrap(),
        serde_json::json!({
            "image": { "released": { "name": "view", "generation": 1, "raster": 2, "sequence": 3 } }
        })
    );
}

// contract: images.lease.failed-release-is-reported
#[test]
fn a_release_that_fails_in_an_open_window_reports_the_failure() {
    let open = Ok(Arc::new(crate::windows::WindowData::default()));
    assert_eq!(
        super::send_released(&open, "view", (1, 2, 3), |_, _| {
            Err("sidecars are stopped".to_string())
        }),
        Err("sidecars are stopped".to_string())
    );
}
