//! The configuration of a created document region: a failed step closes the document before the error returns. The same cases
//! run in the Go host.

use std::cell::RefCell;

use super::{DocumentNative, DocumentSetup, StreamEffect, configure_document};

/// The steps of the configuration of a created document region, in their order.
const CREATION_STEPS: [&str; 7] = [
    "restore",
    "appearance",
    "background",
    "message",
    "stream",
    "stream_on",
    "event",
];

/// The native operations of the creation tests. Each operation records its step, the step named fail fails, and close records
/// the closed document and fails when closing is set.
#[derive(Default)]
struct CreationNative {
    fail: &'static str,
    closing: Option<&'static str>,
    steps: RefCell<Vec<&'static str>>,
    closed: RefCell<Vec<usize>>,
}

impl CreationNative {
    fn step(&self, name: &'static str) -> Result<(), String> {
        self.steps.borrow_mut().push(name);
        if self.fail == name {
            return Err(format!("{name} failed"));
        }
        Ok(())
    }
}

impl DocumentNative for CreationNative {
    fn restore(&self, _: usize, _: &str) -> Result<(), String> {
        self.step("restore")
    }
    fn appearance(&self, _: usize, _: bool) -> Result<(), String> {
        self.step("appearance")
    }
    fn background(&self, _: usize, _: bool) -> Result<(), String> {
        self.step("background")
    }
    fn message(&self, _: usize, _: Box<dyn Fn(String) + Send>) -> Result<(), String> {
        self.step("message")
    }
    fn stream(&self, _: usize, _: Box<dyn Fn(String) + Send>) -> Result<(), String> {
        self.step("stream")
    }
    fn stream_on(&self, _: usize, _: &str, _: bool) -> Result<bool, String> {
        // A refusal of native is false.
        Ok(self.step("stream_on").is_ok())
    }
    fn event(&self, _: usize, _: Box<dyn Fn(String) + Send>) -> Result<(), String> {
        self.step("event")
    }
    fn close(&self, document: usize) -> Result<(), String> {
        self.closed.borrow_mut().push(document);
        self.closing.map_or(Ok(()), |error| Err(error.to_string()))
    }
}

/// The configuration of the region page of tab-1, with a restored history and the requests effect of its attach.
fn creation_setup() -> DocumentSetup {
    DocumentSetup {
        name: "page".into(),
        restore: Some("AAAA".into()),
        dark: false,
        dialog: false,
        message: Box::new(|_| {}),
        stream: Box::new(|_| {}),
        effects: vec![StreamEffect {
            key: ("tab-1".to_string(), "page".to_string()),
            stream: "requests".into(),
            on: true,
        }],
        event: Box::new(|_| {}),
    }
}

// contract: documents.create.failure-closes-document
#[test]
fn a_failed_step_of_the_creation_closes_the_document() {
    for (index, fail) in CREATION_STEPS.iter().enumerate() {
        let native = CreationNative {
            fail,
            ..CreationNative::default()
        };
        let error = configure_document(&native, 7, creation_setup()).unwrap_err();
        let want = match *fail {
            "restore" => "document page: restore failed".to_string(),
            "stream_on" => r#"document "page" does not accept stream "requests""#.to_string(),
            step => format!("{step} failed"),
        };
        assert_eq!(error, want, "the failure of {fail}");
        assert_eq!(
            *native.closed.borrow(),
            vec![7],
            "the failure of {fail} left the document open"
        );
        assert_eq!(
            *native.steps.borrow(),
            CREATION_STEPS[..=index].to_vec(),
            "the steps after the failure of {fail} ran"
        );
    }
}

// contract: documents.create.failure-closes-document
#[test]
fn a_creation_without_failure_keeps_the_document_and_a_failed_close_is_reported() {
    let native = CreationNative::default();
    configure_document(&native, 7, creation_setup()).unwrap();
    assert_eq!(*native.steps.borrow(), CREATION_STEPS.to_vec());
    assert!(native.closed.borrow().is_empty());
    let native = CreationNative {
        fail: "event",
        closing: Some("the document is gone"),
        ..CreationNative::default()
    };
    assert_eq!(
        configure_document(&native, 7, creation_setup()).unwrap_err(),
        "event failed; closing the document: the document is gone"
    );
}

// contract: modal.dialog-blurs-each-document-and-image-region
#[test]
fn a_dialog_blurs_each_document_and_image_region() {
    let documents = std::cell::RefCell::new(Vec::new());
    let images = std::cell::RefCell::new(Vec::new());
    super::set_regions_background(
        vec![1, 2],
        vec![3],
        |handle| {
            documents.borrow_mut().push(handle);
            Ok(())
        },
        |handle| {
            images.borrow_mut().push(handle);
            Ok(())
        },
    );
    assert_eq!(*documents.borrow(), vec![1, 2]);
    assert_eq!(*images.borrow(), vec![3]);
}
