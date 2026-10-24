use std::sync::mpsc::{self, TryRecvError};
use std::time::Duration;

use serde_json::json;

use super::{CORE, PAGE_ORIGIN, START_DOCUMENT_PATH, after_page_started, serve, start_document};

// contract: images.reload.start-document-waits-for-detach
#[test]
fn the_start_response_waits_for_the_image_detach_acknowledgement() {
    let (detach_sender, detach_receiver) = mpsc::channel();
    let (ack_sender, ack_receiver) = mpsc::channel();
    let (response_sender, response_receiver) = mpsc::channel();
    let startup = std::thread::spawn(move || {
        let response = serve(CORE, START_DOCUMENT_PATH, "main", &mut |_| {
            let (detachments, document) = after_page_started(
                || {
                    detach_sender
                        .send(json!({
                            "image": {"detach": {
                                "request": "request-1",
                                "name": "region",
                                "generation": 1,
                            }}
                        }))
                        .map_err(|error| error.to_string())?;
                    ack_receiver
                        .recv_timeout(Duration::from_secs(2))
                        .map_err(|error| format!("fake supplier acknowledgement: {error}"))??;
                    Ok(vec!["old-image-generation"])
                },
                || start_document(&json!({"workspace": true}), &json!({"controls": true})),
            )?;
            assert_eq!(detachments, ["old-image-generation"]);
            Ok(document)
        });
        response_sender.send(response).unwrap();
    });

    let request = detach_receiver
        .recv_timeout(Duration::from_secs(2))
        .expect("page startup did not request image detach");
    assert_eq!(request["image"]["detach"]["name"], "region");
    assert!(matches!(
        response_receiver.try_recv(),
        Err(TryRecvError::Empty)
    ));

    ack_sender.send(Ok::<(), String>(())).unwrap();
    let response = response_receiver
        .recv_timeout(Duration::from_secs(2))
        .expect("start response did not follow the supplier acknowledgement");
    assert_eq!(response.status(), 200);
    assert_eq!(
        response
            .headers()
            .get("Access-Control-Allow-Origin")
            .unwrap()
            .to_str()
            .unwrap(),
        PAGE_ORIGIN
    );
    let document: serde_json::Value = serde_json::from_slice(response.body()).unwrap();
    assert_eq!(document["workspace"]["workspace"], true);
    startup.join().unwrap();
}

// contract: images.detach.refusal-fails-start
#[test]
fn a_detach_failure_does_not_build_a_start_document() {
    let mut built = false;
    let result = after_page_started(
        || Err::<Vec<&str>, String>("image detach timed out".to_string()),
        || {
            built = true;
            Ok("start document")
        },
    );

    assert_eq!(result.unwrap_err(), "image detach timed out");
    assert!(!built, "a failed detach must not produce a start document");
}
