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

// contract: images.detach.ends-by-its-events
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
    use super::super::{PRESENTS_REFUSED, Presents, present_on_ui};
    use std::sync::{Arc, Mutex, mpsc};

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
                &Presents::default(),
            )
        });
        // The worker either queues the commit or ends, which drops the queue, so the receive ends by one of those events.
        let callback = queued.recv();
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
        let result = present_on_ui(
            Box::new(|| panic!("refused work ran")),
            |_| Err("native queue refused".into()),
            &Presents::default(),
        );
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
            &Presents::default(),
        );
        assert_eq!(result, Err("native presentation refused".into()));
    }

    // A present that waits for the main thread ends when the stop of the sidecars refuses the presents, and the main thread that
    // runs the held presentation later does not wait (docs/spec/sidecars.md#declaration-and-startup).
    // contract: images.presentation.ends-with-the-sidecar-stop
    #[test]
    fn a_present_that_waits_for_the_main_thread_ends_with_the_refusal_of_the_presents() {
        let presents = Arc::new(Presents::default());
        let (enqueue, queued) = mpsc::sync_channel::<Box<dyn FnOnce() + Send>>(1);
        let (answered, answer) = mpsc::channel();
        let waiting = Arc::clone(&presents);
        std::thread::spawn(move || {
            answered
                .send(present_on_ui(
                    Box::new(|| Ok(())),
                    |work| enqueue.send(work).map_err(|error| error.to_string()),
                    &waiting,
                ))
                .expect("the test holds the receiver");
        });
        // The main thread holds the presentation and does not run it, as the main thread that runs the stop at exit does.
        let held = queued.recv().expect("the present enqueued no presentation");
        presents.refuse();
        // A present that still waits for the main thread does not answer, and the check stops at the limit of its runner.
        assert_eq!(
            answer.recv().expect("the present ended without an answer"),
            Err(PRESENTS_REFUSED.to_string())
        );
        held();
        assert_eq!(
            present_on_ui(
                Box::new(|| panic!("a refused presentation ran")),
                |_| panic!("a refused presentation was enqueued"),
                &presents,
            ),
            Err(PRESENTS_REFUSED.to_string()),
            "a present after the refusal was not refused at once"
        );
    }

    // A presentation that the main thread drops without running it ends its present.
    // contract: images.presentation.ends-with-the-sidecar-stop
    #[test]
    fn a_presentation_that_the_main_thread_drops_ends_its_present() {
        let result = present_on_ui(
            Box::new(|| panic!("a dropped presentation ran")),
            |work| {
                drop(work);
                Ok(())
            },
            &Presents::default(),
        );
        assert!(
            result.is_err(),
            "a dropped presentation answered {result:?}"
        );
    }
}

mod wait_boundary {
    use super::super::*;
    use std::sync::mpsc;

    /// The decision of layout_wait on a raster wait that found a raster pending.
    const PENDING: &str = "a raster is pending";

    /// Decides the layout raster wait on the current images without time: the wait answers at once when its rasters are
    /// complete or failed, and a wait that reports a pending check is ended by the end of the layout transaction, as a press
    /// or a cancel ends it, and decides PENDING.
    fn layout_wait(images: &Images, settled: bool) -> Result<(), String> {
        enum Step {
            Pending,
            Answer(Result<(), String>),
        }
        let (step, steps) = mpsc::channel();
        let waiter = images.clone();
        std::thread::spawn(move || {
            let answer = waiter.wait_layout_rasters_observed(settled, || {
                step.send(Step::Pending)
                    .expect("signal a pending check of the wait")
            });
            step.send(Step::Answer(answer))
                .expect("hand over the result of the raster wait");
        });
        if let Step::Answer(answer) = steps.recv().expect("the raster wait answers or checks") {
            return answer;
        }
        images.end_waits();
        loop {
            if let Step::Answer(answer) = steps
                .recv()
                .expect("the end of the layout ends the raster wait")
            {
                assert_eq!(
                    answer,
                    Err(LAYOUT_WAIT_ENDED.to_string()),
                    "the pending raster wait ended by the end of its layout"
                );
                return Err(PENDING.to_string());
            }
        }
    }

    // The end of the connection of a sidecar ends the raster wait of its regions in that turn, because no raster of the ended
    // connection comes (docs/spec/native-surfaces.md#layout-transaction). The wait of the current raster has no time limit; it
    // calls waiting at each check that finds a raster pending, under the owner lock, which marks the points where the wait is
    // still open.
    // contract: images.wait.sidecar-end-ends-wait, images.wait.ends-by-its-events
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
        let (checked, checks) = mpsc::channel();
        let (answer, answered) = mpsc::channel();
        std::thread::spawn(move || {
            let outcome = waiter.wait_current_observed(&|| None, || {
                checked
                    .send(())
                    .expect("signal a pending check of the wait")
            });
            answer
                .send(outcome)
                .expect("hand over the result of the raster wait");
        });
        // The wait has begun when it reports its first pending check; the end of the sidecar is sent after that, and the result
        // is read after the end, so no check of this test depends on time.
        checks.recv().expect("the wait checks its pending raster");
        assert!(
            answered.try_recv().is_err(),
            "the raster wait ended before its supplier connection ended"
        );
        assert_eq!(images.invalidate_sidecar("sidecar"), 1);
        let outcome = answered
            .recv()
            .expect("the end of the sidecar did not end the raster wait");
        assert!(
            outcome
                .as_ref()
                .is_err_and(|error| error.contains("sidecar")),
            "the raster wait ended without the end of its sidecar: {outcome:?}"
        );
    }

    // contract: images.wait.newer-sequence-rearms-wait, images.wait.ends-by-its-events
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
        let (checked, checks) = mpsc::channel();
        let wait = || {
            let waiter = images.clone();
            let checked = checked.clone();
            std::thread::spawn(move || {
                waiter.wait_current_observed(&|| None, || {
                    checked
                        .send(())
                        .expect("signal a pending check of the wait")
                })
            })
        };
        // The presented sequence and the newest accepted one change under one hold of the owner lock, so the wait checks
        // after both.
        let present = |sequence: i32, last: i32| {
            let mut inner = images.lock();
            let state = inner.states.get_mut(&key).expect("image state");
            state.presented_raster = config.raster;
            state.presented_sequence = sequence;
            state.last_sequence = last;
            images.changed();
        };
        let worker = wait();
        checks.recv().expect("the wait checks its pending raster");
        present(1, 2);
        checks
            .recv()
            .expect("the wait checks again after the change");
        assert!(
            !worker.is_finished(),
            "the newer accepted frame remains pending after the earlier frame completed"
        );
        assert!(
            !images.current_presented(),
            "instantaneous status still reports the pending newer frame"
        );
        present(2, 2);
        assert_eq!(worker.join().expect("join image wait"), Ok(()));
        // A new wait requires the frame that was accepted before it began.
        present(2, 3);
        let worker = wait();
        checks
            .recv()
            .expect("the new wait checks its pending raster");
        assert!(
            !worker.is_finished(),
            "a new wait must require the already accepted frame"
        );
        present(3, 3);
        assert_eq!(worker.join().expect("join image wait"), Ok(()));
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
            layout_wait(&images, false),
            Ok(()),
            "continuous wait completes from the installed raster snapshot after a later same-raster acceptance"
        );
        assert_eq!(
            layout_wait(&images, true),
            Err(PENDING.into()),
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
            layout_wait(&images, false),
            Err(PENDING.into()),
            "an accepted but unpresented new-generation frame blocks completion"
        );
        assert!(images.mark_presented(&key, new_generation, new_config.raster, 1));
        assert_eq!(layout_wait(&images, false), Ok(()));

        let raster_config = images
            .configure_raster(&key, 801, 600, 2.0, true)
            .expect("configure changed raster")
            .expect("new raster");
        assert_ne!(raster_config.raster, new_config.raster);
        assert_eq!(
            layout_wait(&images, false),
            Err(PENDING.into()),
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
            layout_wait(&images, false),
            Err(PENDING.into()),
            "an accepted but unpresented changed raster blocks completion"
        );
        assert!(images.mark_presented(&key, raster_config.generation, raster_config.raster, 1));
        assert_eq!(layout_wait(&images, false), Ok(()));
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
            layout_wait(&images, false),
            Ok(()),
            "a hidden image does not block continuous wait"
        );
        images.set_surface_visible(&hidden_key.0, false);
        assert_eq!(
            layout_wait(&images, false),
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
            layout_wait(&images, false),
            Err("continuous presentation failed".into()),
            "presentation failure remains fail-closed"
        );
    }

    /// An image region whose raster 1 is accepted and not yet presented, so each raster wait finds it pending.
    fn pending_raster() -> Images {
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
        images
    }

    // The end of the layout transaction of the window ends the raster wait of the presentation request inside it
    // (docs/spec/native-surfaces.md#layout-transaction). The end is sent after the first pending check, so no check depends
    // on time.
    // contract: images.wait.sidecar-end-ends-wait
    #[test]
    fn the_end_of_the_layout_ends_the_raster_wait() {
        let images = pending_raster();
        let waiter = images.clone();
        let (checked, checks) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            waiter.wait_layout_rasters_observed(true, || {
                checked
                    .send(())
                    .expect("signal a pending check of the wait")
            })
        });
        checks.recv().expect("the wait checks its pending raster");
        images.end_waits();
        assert_eq!(
            worker.join().expect("join raster wait"),
            Err(LAYOUT_WAIT_ENDED.to_string())
        );
    }

    // The wait of host.window.presented for the current rasters ends by the end of its request, and the end of a layout
    // transaction does not end it: the wait checks again after that end and stays open (docs/spec/host-contract.md). The end
    // of the layout is sent after the first pending check and the end of the request after the second, so no check depends
    // on time.
    // contract: images.wait.ends-by-its-events
    #[test]
    fn the_end_of_its_request_ends_the_wait_of_the_current_rasters() {
        let images = pending_raster();
        let request_ended = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let waiter = images.clone();
        let ended = Arc::clone(&request_ended);
        let (checked, checks) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            waiter.wait_current_observed(
                &|| {
                    ended
                        .load(std::sync::atomic::Ordering::SeqCst)
                        .then(|| "the endpoint connection of the request ended".to_string())
                },
                || {
                    checked
                        .send(())
                        .expect("signal a pending check of the wait")
                },
            )
        });
        checks.recv().expect("the wait checks its pending raster");
        images.end_waits();
        checks
            .recv()
            .expect("the wait checks again after the end of the layout");
        assert!(
            !worker.is_finished(),
            "the end of a layout transaction ended the wait of the current rasters"
        );
        request_ended.store(true, std::sync::atomic::Ordering::SeqCst);
        images.wake_waits();
        assert_eq!(
            worker.join().expect("join raster wait"),
            Err("the endpoint connection of the request ended".to_string())
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
        &crate::message_body::MessageBody::read(&body),
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
        &crate::message_body::MessageBody::read(&body),
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
        &crate::message_body::MessageBody::read(&retired_body.to_string()),
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
        super::seat_background(overlay, "tab-1", 7, |handle, enabled| {
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

/// Whether id is prefix and 26 characters of the base32 alphabet, the form of a request identifier that the host draws from the random
/// source of the system.
pub(crate) fn is_random_identifier(id: &str, prefix: &str) -> bool {
    id.strip_prefix(prefix).is_some_and(|text| {
        text.len() == 26
            && text
                .bytes()
                .all(|byte| matches!(byte, b'A'..=b'Z' | b'2'..=b'7'))
    })
}

// contract: images.copy-path.screen-request, images.request-identifiers-are-random-text, images.copy-path.answer-of-no-request-names-it
// A drawing region receives one screen request for its current screen until the host answers it, and the request that follows an
// accepted screen carries only the changed rows (docs/spec/native-surfaces.md#copy-path-frames). The request identifier is screen- and
// 26 characters of the base32 alphabet from the random source of the system, and an answer of a request that the region does not hold
// is an error that names the region, its surface and the request.
#[test]
fn drawing_region_receives_one_screen_request_until_it_is_answered() {
    let images = super::Images::default();
    let surface = "tab-1";
    images.begin_generation(surface);
    let key = (surface.to_string(), "copy".to_string());
    images.reserve(&key, "owner", "fixture-sidecar").unwrap();
    assert!(images.set(&key, 1));
    let configure = images
        .configure_raster(&key, 800, 600, 2.0, true)
        .unwrap()
        .expect("a drawing region with a size has a raster configuration");
    let requests = images.screen_requests();
    assert_eq!(
        requests.len(),
        1,
        "a drawing region gets one screen request"
    );
    let first = &requests[0];
    assert!(
        is_random_identifier(&first.request, "screen-"),
        "screen request identifier {:?}: screen- and 26 characters of the base32 alphabet",
        first.request
    );
    assert!(
        first.full && first.generation == configure.generation && first.raster == configure.raster,
        "the first screen request is full for the configured raster: {first:?}"
    );
    let body = serde_json::to_value(serde_json::json!({ "image": { "screen": first } })).unwrap();
    assert_eq!(
        body,
        serde_json::json!({ "image": { "screen": {
            "request": first.request,
            "name": "copy",
            "generation": configure.generation,
            "raster": configure.raster,
            "full": true,
        } } })
    );
    assert!(
        images.screen_requests().is_empty(),
        "a region with an unanswered screen request gets no other one"
    );
    let unknown = super::ScreenRequest {
        request: "screen-old".to_string(),
        ..first.clone()
    };
    assert_eq!(
        images.answer_screen(&key, &unknown, true),
        Err(
            r#"image "copy" of surface "tab-1" has no unanswered screen request "screen-old""#
                .to_string()
        ),
        "the answer of a request that the region does not hold"
    );
    images.answer_screen(&key, first, true).unwrap();
    let next = images.screen_requests();
    assert!(
        next.len() == 1 && !next[0].full && next[0].request != first.request,
        "after an accepted screen the next request is {next:?}: one request, full false, new identifier"
    );
}

// frame_fixture returns a window with the drawing region copy and the region idle, which is not drawing, both of sidecar-a, and the
// generation of copy.
fn frame_fixture() -> (super::Images, super::Key, super::Key, u64) {
    let images = super::Images::default();
    let surface = "tab-1";
    images.begin_generation(surface);
    let mut generation = 0;
    for (name, visible) in [("copy", true), ("idle", false)] {
        let key = (surface.to_string(), name.to_string());
        images.reserve(&key, "owner", "sidecar-a").unwrap();
        assert!(images.set(&key, 1));
        let configure = images
            .configure_raster(&key, 800, 600, 2.0, visible)
            .unwrap();
        if name == "copy" {
            generation = configure
                .expect("a drawing region with a size has a raster configuration")
                .generation;
        }
    }
    (
        images,
        (surface.to_string(), "copy".to_string()),
        (surface.to_string(), "idle".to_string()),
        generation,
    )
}

// handle_frame_request sends a frame request body of a supplier through handle_envelope and returns whether the host consumed it, each
// answer it sent and the number of main-thread steps that asked the native region for a display frame.
fn handle_frame_request(
    images: &super::Images,
    want: serde_json::Value,
    sender: &str,
) -> (bool, Vec<serde_json::Value>, usize) {
    let body = serde_json::json!({ "image": { "want": want } });
    let answers = Arc::new(Mutex::new(Vec::new()));
    let sent = Arc::clone(&answers);
    let asked = Arc::new(Mutex::new(0));
    let steps = Arc::clone(&asked);
    let handled = super::handle_envelope(
        &crate::message_body::MessageBody::read(&body.to_string()),
        sender,
        "tab-1",
        images,
        move |_work| {
            *steps.lock().unwrap() += 1;
            Ok(())
        },
        move |_image, response| {
            sent.lock().unwrap().push(response);
            Ok(())
        },
    );
    let answers = answers.lock().unwrap().clone();
    let asked = *asked.lock().unwrap();
    (handled, answers, asked)
}

// contract: images.copy-path.frame-request-tick
// A frame request of the owner of a drawing region asks for one display frame, a second request before the tick asks nothing more, and
// the display frame gives one tick with the sequence of the region from 1 and the refresh rate that the native region read; a display
// frame without a refresh rate gives no tick and ends the request (docs/spec/native-surfaces.md#copy-path-frames).
#[test]
fn a_frame_request_asks_for_one_display_frame_and_its_tick_carries_the_refresh_rate() {
    let (images, key, _, generation) = frame_fixture();
    let want = serde_json::json!({ "name": "copy", "generation": generation });
    assert_eq!(
        handle_frame_request(&images, want.clone(), "sidecar-a"),
        (true, Vec::new(), 1),
        "the first frame request asks for one display frame with no answer"
    );
    assert_eq!(
        handle_frame_request(&images, want, "sidecar-a"),
        (true, Vec::new(), 0),
        "a request before the tick asks for nothing more"
    );
    let frame = images
        .frame_tick(&key, Some(120))
        .expect("the display frame of the request gives a tick");
    assert_eq!(
        frame.body("main"),
        serde_json::json!({ "image": { "tick": {
            "name": "copy", "generation": generation, "sequence": 1, "refreshRate": 120,
        } } })
    );
    assert_eq!(
        images.want_frame(&key, "sidecar-a", generation, super::FramePurpose::Draw),
        Ok(true),
        "a request after the tick asks for one display frame"
    );
    assert!(
        images.frame_tick(&key, None).is_none(),
        "a display frame without a refresh rate gives no tick"
    );
    assert_eq!(
        images.want_frame(&key, "sidecar-a", generation, super::FramePurpose::Draw),
        Ok(true),
        "a display frame without a refresh rate ends the request"
    );
    let next = images
        .frame_tick(&key, Some(60))
        .map(|frame| (frame.tick.sequence, frame.tick.refresh_rate));
    assert_eq!(next, Some((2, 60)), "the next tick");
}

// contract: images.copy-path.frame-request-refused
// A frame request from a sender that does not own the region is answered notAttached, one of a generation that is not current stale, and
// a request for a region that is not drawing asks no display frame (docs/spec/native-surfaces.md#copy-path-frames).
#[test]
fn frame_request_refusals_name_the_reason() {
    let (images, _, idle, generation) = frame_fixture();
    for (case, sender, generation, reason) in [
        ("other sender", "sidecar-b", generation, "notAttached"),
        ("stale generation", "sidecar-a", generation + 1, "stale"),
    ] {
        assert_eq!(
            handle_frame_request(
                &images,
                serde_json::json!({ "name": "copy", "generation": generation }),
                sender
            ),
            (
                true,
                vec![serde_json::json!({ "image": { "want": {
                    "error": reason, "name": "copy", "generation": generation,
                } } })],
                0
            ),
            "{case}"
        );
    }
    let idle_generation = images.lock().states[&idle].generation;
    assert_eq!(
        handle_frame_request(
            &images,
            serde_json::json!({ "name": "idle", "generation": idle_generation }),
            "sidecar-a"
        ),
        (true, Vec::new(), 0),
        "a request for a region that is not drawing asks for no display frame"
    );
}

// contract: images.copy-path.frame-request-malformed
// A frame request with a missing, mistyped or null generation is answered malformed with the member, and a request without a valid name
// is consumed with no answer (docs/spec/native-surfaces.md#copy-path-frames).
#[test]
fn malformed_frame_request_names_its_member() {
    let (images, _, _, _) = frame_fixture();
    for (case, want) in [
        ("missing generation", serde_json::json!({ "name": "copy" })),
        (
            "string generation",
            serde_json::json!({ "name": "copy", "generation": "2" }),
        ),
        (
            "null generation",
            serde_json::json!({ "name": "copy", "generation": null }),
        ),
    ] {
        assert_eq!(
            handle_frame_request(&images, want, "sidecar-a"),
            (
                true,
                vec![serde_json::json!({ "image": { "want": {
                    "error": "malformed", "member": "generation", "name": "copy",
                } } })],
                0
            ),
            "{case}"
        );
    }
    for (case, want) in [
        ("missing name", serde_json::json!({ "generation": 1 })),
        ("null request", serde_json::Value::Null),
    ] {
        assert_eq!(
            handle_frame_request(&images, want, "sidecar-a"),
            (true, Vec::new(), 0),
            "{case}"
        );
    }
}

// contract: images.copy-path.frame-request-read
// A read frame request asks for one display frame also for a region that is not drawing and while the window is occluded, and its
// display frame sends the tick; a read request and a draw request that wait together ask one display frame and receive one tick; the
// display frame of a read request of a window on no screen is answered noScreen with the window; a purpose of another value is
// malformed (docs/spec/native-surfaces.md#copy-path-frames).
#[test]
fn a_read_frame_request_is_answered_while_the_region_does_not_draw() {
    let (images, key, idle, generation) = frame_fixture();
    let idle_generation = images.lock().states[&idle].generation;
    let read_idle =
        serde_json::json!({ "name": "idle", "generation": idle_generation, "purpose": "read" });
    assert_eq!(
        handle_frame_request(&images, read_idle, "sidecar-a"),
        (true, Vec::new(), 1),
        "a read request for a region that is not drawing asks for one display frame"
    );
    let frame = images
        .frame_tick(&idle, Some(120))
        .expect("the display frame of the read request gives a tick");
    assert_eq!(
        (
            frame.no_screen,
            frame.tick.sequence,
            frame.tick.refresh_rate
        ),
        (false, 1, 120),
        "the tick of the read request"
    );

    images.set_on_screen(false);
    assert_eq!(
        handle_frame_request(
            &images,
            serde_json::json!({ "name": "copy", "generation": generation }),
            "sidecar-a"
        ),
        (true, Vec::new(), 0),
        "a draw request while the window is occluded asks for no display frame"
    );
    let read = serde_json::json!({ "name": "copy", "generation": generation, "purpose": "read" });
    assert_eq!(
        handle_frame_request(&images, read.clone(), "sidecar-a"),
        (true, Vec::new(), 1),
        "a read request while the window is occluded asks for one display frame"
    );
    let frame = images.frame_tick(&key, Some(120));
    assert_eq!(
        frame.map(|frame| (frame.no_screen, frame.tick.sequence)),
        Some((false, 1)),
        "the display frame of the read request of an occluded window"
    );

    images.set_on_screen(true);
    let draw = serde_json::json!({ "name": "copy", "generation": generation, "purpose": "draw" });
    let (_, _, draw_asked) = handle_frame_request(&images, draw, "sidecar-a");
    let (_, _, read_asked) = handle_frame_request(&images, read.clone(), "sidecar-a");
    assert_eq!(
        (draw_asked, read_asked),
        (1, 0),
        "a draw request and a read request that wait together ask for one display frame"
    );
    let frame = images.frame_tick(&key, Some(120));
    assert_eq!(
        frame.map(|frame| frame.tick.sequence),
        Some(2),
        "the display frame of both requests gives one tick"
    );

    handle_frame_request(&images, read, "sidecar-a");
    let frame = images
        .frame_tick(&key, None)
        .expect("the display frame of a read request of a window on no screen gives the refusal");
    assert!(frame.no_screen, "the refusal noScreen");
    assert_eq!(
        frame.body("main"),
        serde_json::json!({ "image": { "want": {
            "error": "noScreen", "name": "copy", "generation": generation, "purpose": "read", "window": "main",
        } } })
    );

    for purpose in [
        serde_json::json!("paint"),
        serde_json::json!(1),
        serde_json::Value::Null,
    ] {
        assert_eq!(
            handle_frame_request(
                &images,
                serde_json::json!({ "name": "copy", "generation": generation, "purpose": purpose }),
                "sidecar-a"
            ),
            (
                true,
                vec![serde_json::json!({ "image": { "want": {
                    "error": "malformed", "member": "purpose", "name": "copy",
                } } })],
                0
            ),
            "purpose {purpose}"
        );
    }
}

// contract: images.copy-path.input-draw
// A user input that reaches a drawing region sends the screen request at once when the input is at most 200 ms old and the region has no
// unanswered request. The request carries the correlation identifiers of the input (docs/spec/native-surfaces.md#copy-path-frames).
#[test]
fn input_sends_the_screen_request_at_once_with_its_correlation_identifiers() {
    let images = super::Images::default();
    let surface = "tab-1";
    images.begin_generation(surface);
    let key = (surface.to_string(), "copy".to_string());
    images.reserve(&key, "owner", "fixture-sidecar").unwrap();
    assert!(images.set(&key, 1));
    images.configure_raster(&key, 800, 600, 2.0, true).unwrap();
    let input_at = std::time::Instant::now();
    let ms = std::time::Duration::from_millis;
    let request = images
        .input_screen_request(
            &key,
            vec!["cid-1".to_string()],
            input_at,
            input_at + ms(150),
        )
        .expect("an input 150 ms old sends its screen request at once");
    assert_eq!(request.cids, ["cid-1"]);
    let body =
        serde_json::to_value(serde_json::json!({ "image": { "screen": &request } })).unwrap();
    assert_eq!(
        body["image"]["screen"]["cids"],
        serde_json::json!(["cid-1"])
    );
    assert!(
        images
            .input_screen_request(&key, vec!["cid-2".to_string()], input_at, input_at + ms(10))
            .is_none(),
        "an input sends no request while the region has an unanswered one"
    );
    images.answer_screen(&key, &request, false).unwrap();
    assert!(
        images
            .input_screen_request(
                &key,
                vec!["cid-3".to_string()],
                input_at,
                input_at + ms(201)
            )
            .is_none(),
        "an input 201 ms old sends no request at once"
    );
}

// screen_fixture returns a window with one drawing region of sidecar-a, its generation and raster, and the unanswered screen request.
fn screen_fixture() -> (super::Images, super::Key, u64, u64, super::ScreenRequest) {
    let images = super::Images::default();
    let surface = "tab-1";
    images.begin_generation(surface);
    let key = (surface.to_string(), "copy".to_string());
    images.reserve(&key, "owner", "sidecar-a").unwrap();
    assert!(images.set(&key, 1));
    let configure = images
        .configure_raster(&key, 800, 600, 2.0, true)
        .unwrap()
        .expect("a drawing region with a size has a raster configuration");
    let requests = images.screen_requests();
    assert_eq!(
        requests.len(),
        1,
        "a drawing region gets one screen request"
    );
    let first = requests[0].clone();
    (images, key, configure.generation, configure.raster, first)
}

// handle_screen_message sends a supplier body through handle_envelope and returns whether the host consumed it and each answer it sent.
fn handle_screen_message(
    images: &super::Images,
    body: &serde_json::Value,
    sender: &str,
    surface: &str,
) -> (bool, Vec<serde_json::Value>) {
    let answers = Arc::new(Mutex::new(Vec::new()));
    let sent = Arc::clone(&answers);
    let handled = super::handle_envelope(
        &crate::message_body::MessageBody::read(&body.to_string()),
        sender,
        surface,
        images,
        |work| work(),
        move |_image, response| {
            sent.lock().unwrap().push(response);
            Ok(())
        },
    );
    let answers = answers.lock().unwrap().clone();
    (handled, answers)
}

// contract: images.copy-path.screen-answer-accepted
// The screen message that answers the unanswered request of a region is accepted at the wire: the host answers accepted, the rows become the
// baseline, and the next request sends only the changed rows (docs/spec/native-surfaces.md#copy-path-frames).
#[test]
fn screen_message_of_the_supplier_is_accepted_over_the_wire() {
    let (images, key, generation, raster, first) = screen_fixture();
    let body = serde_json::json!({ "image": { "screen": {
        "request": first.request, "name": "copy", "generation": generation, "raster": raster,
        "rows": [{ "row": 0, "cells": "row-0" }],
    } } });
    let (handled, answers) = handle_screen_message(&images, &body, "sidecar-a", &key.0);
    assert!(handled, "the screen message is consumed");
    assert_eq!(
        answers,
        vec![serde_json::json!({ "image": { "screen": { "accepted": {
            "request": first.request, "name": "copy", "generation": generation, "raster": raster,
        } } } })],
        "the answers to the screen message"
    );
    let next = images.screen_requests();
    assert!(
        next.len() == 1 && !next[0].full && next[0].request != first.request,
        "after the accepted screen the next request is {next:?}: one request, full false, new identifier"
    );
}

// contract: images.wait.supplier-end-names-the-region
// The end of the supplier connection of a drawing region with a raster fails a presentation wait with the error that names the supplier
// and the region, and the configuration that the next connection receives ends that error (docs/spec/native-surfaces.md#image-regions).
#[test]
fn the_end_of_a_supplier_fails_the_wait_until_the_region_is_configured_again() {
    let (images, key, _, _, _) = screen_fixture();
    images.invalidate_sidecar("sidecar-a");
    assert_eq!(
        images.wait_current(&|| None),
        Err("the supplier sidecar-a of the image region tab-1/copy ended".to_string()),
        "the wait after the end of the supplier"
    );
    images
        .configure_raster(&key, 800, 600, 2.0, true)
        .unwrap()
        .expect("the region is configured for the next connection");
    assert_eq!(
        images.lock().states[&key].presentation_error,
        None,
        "the configuration of the next connection ends the error"
    );
}

// contract: images.wait.restarted-supplier-not-awaited
// A region whose supplier connection ended is not awaited by a later presentation wait after the next connection receives its
// configuration, because that connection may hold no session for the region and then sends no raster; the first frame of the region
// that the host presents makes the waits require its rasters again (docs/spec/native-surfaces.md#image-regions).
#[test]
fn a_restarted_supplier_that_sends_no_raster_ends_no_later_wait() {
    let (images, key, _, _, _) = screen_fixture();
    images.invalidate_sidecar("sidecar-a");
    let configure = images
        .configure_raster(&key, 800, 600, 2.0, true)
        .unwrap()
        .expect("the region is configured for the next connection");
    for settled in [false, true] {
        assert_eq!(
            images.wait_layout_rasters(settled),
            Ok(()),
            "the layout wait (settled {settled}) after the restart of the supplier"
        );
    }
    assert_eq!(
        images.wait_current(&|| None),
        Ok(()),
        "the presentation wait after the restart of the supplier"
    );
    assert_eq!(images.pending_rasters(), "none");
    images
        .authorize_frame(
            &key,
            "sidecar-a",
            super::FrameIdentity {
                generation: configure.generation,
                raster: configure.raster,
                width: configure.width,
                height: configure.height,
                scale: configure.scale,
                sequence: 1,
            },
        )
        .expect("authorize the first frame of the next connection");
    assert!(images.mark_presented(&key, configure.generation, configure.raster, 1));
    images.configure_raster(&key, 810, 600, 2.0, true).unwrap();
    assert!(
        !images.current_presented(),
        "after a presented frame of the next connection a new raster blocks the wait"
    );
}

/// A step that ends the unanswered screen request of the region of screen_fixture: (case, the change).
type ScreenRequestEnd = (&'static str, fn(&super::Images, &super::Key));

// contract: images.copy-path.screen-request-ends
// An unanswered screen request ends without an answer when its region moves to a new generation, when the raster of the region changes
// and when the connection of its supplier ends; the end of the connection also drops the accepted screen. The region then receives a new
// request with full true, and a message that answers the ended request is stale (docs/spec/native-surfaces.md#copy-path-frames).
#[test]
fn an_unanswerable_screen_request_ends_and_the_next_request_is_full() {
    let (images, key, _, _, first) = screen_fixture();
    images.answer_screen(&key, &first, true).unwrap();
    let baseline = images.screen_requests();
    assert!(
        baseline.len() == 1 && !baseline[0].full,
        "after an accepted screen the request is {baseline:?}: one request, full false"
    );
    let steps: [ScreenRequestEnd; 4] = [
        ("the end of the supplier connection", |images, _| {
            images.invalidate_sidecar("sidecar-a");
        }),
        ("a new raster size", |images, key| {
            images.configure_raster(key, 1000, 600, 2.0, true).unwrap();
        }),
        ("the showing of the hidden surface", |images, key| {
            images.set_surface_visible(&key.0, false);
            images.set_surface_visible(&key.0, true);
        }),
        ("a new generation", |images, key| {
            images.begin_generation(&key.0);
        }),
    ];
    let mut ended = baseline[0].clone();
    for (case, end) in steps {
        end(&images, &key);
        let requests = images.screen_requests();
        assert!(
            requests.len() == 1 && requests[0].full && requests[0].request != ended.request,
            "after {case} the requests are {requests:?}: one request, full true, new identifier"
        );
        let late = serde_json::json!({ "image": { "screen": {
            "request": ended.request, "name": "copy", "generation": ended.generation, "raster": ended.raster,
            "rows": [{ "row": 0, "cells": "row-0" }],
        } } });
        let (handled, answers) = handle_screen_message(&images, &late, "sidecar-a", &key.0);
        assert!(
            handled,
            "{case}: the answer of the ended request is consumed"
        );
        assert_eq!(
            answers,
            vec![serde_json::json!({ "image": { "screen": {
                "error": "stale", "request": ended.request, "name": "copy",
                "generation": ended.generation, "raster": ended.raster,
            } } })],
            "after {case} the answer of the ended request"
        );
        ended = requests[0].clone();
    }
}

/// A refused screen message: (case, sender, generation offset, raster offset, request identifier override, reason).
type ScreenRefusal = (
    &'static str,
    &'static str,
    u64,
    u64,
    Option<&'static str>,
    &'static str,
);

// contract: images.copy-path.screen-answer-refused
// A screen message with an out-of-date generation or raster, with a request that is not the unanswered one, or from a sender that does not
// own the region is answered stale or notAttached; the unanswered request of the region stays unanswered (docs/spec/native-surfaces.md#copy-path-frames).
#[test]
fn screen_message_refusals_name_the_reason_and_keep_the_request() {
    let cases: [ScreenRefusal; 4] = [
        ("stale generation", "sidecar-a", 1, 0, None, "stale"),
        ("stale raster", "sidecar-a", 0, 1, None, "stale"),
        (
            "superseded request",
            "sidecar-a",
            0,
            0,
            Some("screen-old"),
            "stale",
        ),
        ("other sender", "sidecar-b", 0, 0, None, "notAttached"),
    ];
    for (case, sender, generation_offset, raster_offset, request, reason) in cases {
        let (images, key, generation, raster, first) = screen_fixture();
        let request = request.unwrap_or(first.request.as_str()).to_string();
        let body = serde_json::json!({ "image": { "screen": {
            "request": request, "name": "copy",
            "generation": generation + generation_offset, "raster": raster + raster_offset,
            "rows": [{ "row": 0, "cells": "row-0" }],
        } } });
        let (handled, answers) = handle_screen_message(&images, &body, sender, &key.0);
        assert!(handled, "{case}: the screen message is consumed");
        assert_eq!(
            answers,
            vec![serde_json::json!({ "image": { "screen": {
                "error": reason, "request": request, "name": "copy",
                "generation": generation + generation_offset, "raster": raster + raster_offset,
            } } })],
            "{case}: the answers to the screen message"
        );
        assert!(
            images.screen_requests().is_empty(),
            "{case}: a refused screen message ended the unanswered request"
        );
    }
}

/// A malformed screen message: (case, member, change of the valid message).
type MalformedScreen = (&'static str, &'static str, fn(&mut serde_json::Value));

// contract: images.copy-path.screen-malformed-names-its-member
// A screen message with a missing or mistyped member, or a row without a valid row number or cells, is answered error malformed with the
// dotted path of its first such member, and its unanswered request stays unanswered (docs/spec/native-surfaces.md#copy-path-frames).
#[test]
fn malformed_screen_message_names_its_member() {
    let cases: [MalformedScreen; 10] = [
        ("missing request", "request", |m| {
            m.as_object_mut().unwrap().remove("request");
        }),
        ("string generation", "generation", |m| {
            m["generation"] = serde_json::json!("2");
        }),
        ("negative raster", "raster", |m| {
            m["raster"] = serde_json::json!(-1);
        }),
        ("missing rows", "rows", |m| {
            m.as_object_mut().unwrap().remove("rows");
        }),
        ("row without cells", "rows.0.cells", |m| {
            m["rows"] = serde_json::json!([{ "row": 0 }]);
        }),
        ("null request", "request", |m| {
            m["request"] = serde_json::Value::Null;
        }),
        ("null generation", "generation", |m| {
            m["generation"] = serde_json::Value::Null;
        }),
        ("null raster", "raster", |m| {
            m["raster"] = serde_json::Value::Null;
        }),
        ("null rows", "rows", |m| {
            m["rows"] = serde_json::Value::Null;
        }),
        ("null row number", "rows.0.row", |m| {
            m["rows"] = serde_json::json!([{ "row": null, "cells": "row-0" }]);
        }),
    ];
    for (case, member, change) in cases {
        let (images, key, generation, raster, first) = screen_fixture();
        let mut message = serde_json::json!({
            "request": first.request, "name": "copy", "generation": generation, "raster": raster,
            "rows": [{ "row": 0, "cells": "row-0" }],
        });
        change(&mut message);
        let body = serde_json::json!({ "image": { "screen": message } });
        let (handled, answers) = handle_screen_message(&images, &body, "sidecar-a", &key.0);
        assert!(handled, "{case}: the malformed screen message is consumed");
        assert_eq!(
            answers.len(),
            1,
            "{case}: one answer to the malformed message"
        );
        let screen = &answers[0]["image"]["screen"];
        assert_eq!(
            (screen["error"].as_str(), screen["member"].as_str()),
            (Some("malformed"), Some(member)),
            "{case}: the answer names the member"
        );
        assert!(
            images.screen_requests().is_empty(),
            "{case}: a malformed screen message ended the unanswered request"
        );
    }
}

// contract: images.copy-path.screen-null-is-mistyped
// A screen member whose value is null is mistyped: a null screen is malformed at the member screen, as a screen that is not an object is
// (docs/spec/native-surfaces.md#copy-path-frames). Its message names no image, so the host sends no answer.
#[test]
fn a_null_screen_is_malformed_at_the_member_screen() {
    let (images, key, _, _, _) = screen_fixture();
    let body = serde_json::json!({ "image": { "screen": null } });
    match super::decide(
        &crate::message_body::MessageBody::read(&body.to_string()),
        "sidecar-a",
        &key.0,
        &images,
    ) {
        super::Decision::Malformed { member, text, .. } => assert_eq!(
            (member.as_str(), text.as_str()),
            ("screen", "image screen message has no screen object"),
            "the decision of a null screen"
        ),
        other => panic!("the decision of a null screen is {other:?}, want Malformed"),
    }
    let (handled, answers) = handle_screen_message(&images, &body, "sidecar-a", &key.0);
    assert!(handled, "the null screen is consumed");
    assert!(
        answers.is_empty(),
        "the null screen sends no answer, got {answers:?}"
    );
}

// contract: images.copy-path.screen-without-name-is-not-answered
// A screen message without a valid image name is consumed and sends no answer, because the answer is routed by the image name.
#[test]
fn screen_message_without_name_is_not_answered() {
    let (images, key, generation, raster, first) = screen_fixture();
    let message = serde_json::json!({
        "request": first.request, "generation": generation, "raster": raster,
        "rows": [{ "row": 0, "cells": "row-0" }],
    });
    let body = serde_json::json!({ "image": { "screen": message } });
    // The sender of its own names the records of this message among the records of the other tests.
    let (handled, answers) = handle_screen_message(&images, &body, "sidecar-unnamed", &key.0);
    assert!(handled, "the screen message without a name is consumed");
    assert!(
        answers.is_empty(),
        "the screen message without a name sends no answer, got {answers:?}"
    );
    assert!(
        images.screen_requests().is_empty(),
        "the screen message without a name ended the unanswered request"
    );
    let texts: Vec<String> = crate::event_record::buffered_fields("host.record.error")
        .into_iter()
        .filter(|fields| fields["where"] == "image screen")
        .filter_map(|fields| fields["text"].as_str().map(str::to_string))
        .filter(|text| text.contains(" sender=sidecar-unnamed "))
        .collect();
    assert_eq!(
        texts,
        [
            "surface=tab-1 sender=sidecar-unnamed image screen message has no image name; the message names no image, so no answer is sent"
        ],
        "the error records of the screen message without a name"
    );
}

// contract: images.generation.increases-across-windows
// A persistent supplier keeps the generation of a surface, and a surface moves between windows, so the windows of one
// process issue the generations of their image attachments from one counter (docs/spec/surface-composition.md).
#[test]
fn the_windows_of_a_process_issue_increasing_image_generations() {
    let (first, second) = (super::Images::default(), super::Images::default());
    let before = first.begin_generation("tab-moved");
    let after = second.begin_generation("tab-moved");
    let reserved = ("tab-reserved".to_string(), "view".to_string());
    second.reserve(&reserved, "owner", "vt").unwrap();
    let reserved_generation = second.lock().states[&reserved].generation;
    assert!(
        before < after && after < reserved_generation,
        "the generations of the second window are {after} and {reserved_generation} after {before} of the first window, want each greater than the one before"
    );
}

// contract: images.generation.increases-across-restarts
// A persistent supplier outlives the application process, so the first generation of a later process is greater than
// every generation of an earlier process of the same boot, also after a burst of generations (docs/spec/surface-composition.md).
// The later process is a child run of this test binary.
#[test]
fn a_later_process_issues_greater_image_generations_than_an_earlier_one() {
    const NAME: &str =
        "images::images_test::a_later_process_issues_greater_image_generations_than_an_earlier_one";
    if std::env::var_os("SOKSAK_IMAGE_GENERATION_CHILD").is_some() {
        println!(
            "generation={}",
            super::Images::default().begin_generation("tab-restored")
        );
        return;
    }
    let images = super::Images::default();
    let mut last = 0;
    for index in 0..1000 {
        let next = images.begin_generation(&format!("tab-{index}"));
        assert!(
            next > last,
            "the earlier process issued {next} after {last}"
        );
        last = next;
    }
    let output = std::process::Command::new(std::env::current_exe().expect("test executable"))
        .args([NAME, "--exact", "--nocapture", "--test-threads=1"])
        .env("SOKSAK_IMAGE_GENERATION_CHILD", "1")
        .output()
        .expect("the later process");
    let text = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success(),
        "the later process ended with {}: {text}",
        output.status
    );
    let first: u64 = text
        .split_once("generation=")
        .and_then(|(_, rest)| rest.split(|c: char| !c.is_ascii_digit()).next())
        .unwrap_or_else(|| panic!("the later process printed no generation: {text}"))
        .parse()
        .expect("a generation");
    assert!(
        first > last,
        "the later process issued {first} first, want more than {last} of the earlier process"
    );
}
