use std::sync::{Mutex, mpsc};
use std::time::Duration;

use serde_json::json;

use super::{after_page_started, start_document, start_parts};

// contract: images.reload.start-sends-detach-without-waiting
#[test]
fn the_page_start_sends_the_image_detach_and_lists_its_surface_without_waiting() {
    // The fake supplier never acknowledges, so a start that waited for the acknowledgement would not return.
    let (detach_sender, detach_receiver) = mpsc::channel();
    let order = Mutex::new(Vec::new());
    let (result_sender, result_receiver) = mpsc::channel();
    std::thread::scope(|scope| {
        scope.spawn(|| {
            let document = after_page_started(
                || {
                    order.lock().unwrap().push("page started");
                    detach_sender
                        .send(json!({"image": {"detach": {"request": "request-1", "name": "region", "generation": 1}}}))
                        .map_err(|error| error.to_string())
                },
                || {
                    order.lock().unwrap().push("parts");
                    Ok((Ok(json!({"workspace": true})), json!({"controls": true})))
                },
                || {
                    order.lock().unwrap().push("pending");
                    Ok(vec!["surface-a".to_string()])
                },
            );
            result_sender.send(document).unwrap();
        });
        let request = detach_receiver
            .recv_timeout(Duration::from_secs(2))
            .expect("the page start sent no image detach");
        assert_eq!(request["image"]["detach"]["name"], "region");
        let document = result_receiver
            .recv_timeout(Duration::from_secs(2))
            .expect("the page start waited for the acknowledgement of the detach")
            .unwrap();
        let document: serde_json::Value = serde_json::from_slice(&document).unwrap();
        assert_eq!(
            document,
            json!({"workspace": {"workspace": true}, "controls": {"controls": true}, "pendingSurfaces": ["surface-a"]})
        );
    });
    assert_eq!(*order.lock().unwrap(), ["page started", "parts", "pending"]);
}

// contract: page.start.requires-window
#[test]
fn a_page_start_failure_builds_no_start_document() {
    let mut built = false;
    let result = after_page_started(
        || Err("page start failed".to_string()),
        || {
            built = true;
            Ok((Ok(json!({})), json!({})))
        },
        || Ok(Vec::new()),
    );
    assert_eq!(result.unwrap_err(), "page start failed");
    assert!(
        !built,
        "a start document was built after the page start failed"
    );
}

// contract: page.start.snapshot-error-carries-controls
#[test]
fn a_failed_workspace_snapshot_still_reads_the_controls_and_carries_the_error() {
    let mut commons = Vec::new();
    let mut read = false;
    let parts = start_parts(
        Err("/config/projects.json: projects format 1 is required".to_string()),
        |common| {
            commons.push(common.clone());
            Ok(())
        },
        || {
            read = true;
            Ok(json!({"controls": {"x": 7, "y": 8, "w": 52, "h": 14}, "row": 40}))
        },
    );
    assert!(read, "the controls were not read after the snapshot failed");
    assert_eq!(
        commons,
        [json!({})],
        "the title bar was not set for absent settings"
    );
    let (workspace, controls) = parts.expect("a failed snapshot answered no start document");
    let data = start_document(&workspace, &controls, &[]).unwrap();
    assert!(
        String::from_utf8(data.clone())
            .unwrap()
            .starts_with(r#"{"error":"#)
    );
    let document: serde_json::Value = serde_json::from_slice(&data).unwrap();
    assert_eq!(
        document,
        json!({
            "error": "/config/projects.json: projects format 1 is required",
            "controls": {"controls": {"x": 7, "y": 8, "w": 52, "h": 14}, "row": 40},
            "pendingSurfaces": [],
        })
    );
}
