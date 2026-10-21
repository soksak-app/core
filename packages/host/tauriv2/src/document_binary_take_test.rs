//! The take of a binary id of a document region (docs/spec/native-surfaces.md#document-regions). The native take is a closure here,
//! so the test runs without a window. The same cases run in the Go host.

use std::collections::HashMap;
use std::sync::Mutex;

use super::{Documents, take_document_binary_of};

const TAKEN_ID: &str = "0123456789abcdef0123456789abcdef";

/// The take of the native layer in the test: it returns the bytes of the id and releases it, or the native error text.
fn native_take(
    stored: &Mutex<HashMap<String, Vec<u8>>>,
) -> impl FnOnce(usize, &str) -> Result<Vec<u8>, String> + '_ {
    move |_handle, id| {
        stored
            .lock()
            .expect("the stored bytes")
            .remove(id)
            .ok_or_else(|| "the binary id is not stored".to_string())
    }
}

// contract: documents.binary.take-releases-id
#[test]
fn a_take_returns_the_bytes_of_the_id_and_releases_it() {
    let documents = Documents::default();
    let key = ("probe-surface".to_string(), "doc".to_string());
    documents.reserve(&key).expect("the document is reserved");
    documents.set(&key, 7);
    let stored = Mutex::new(HashMap::from([(
        TAKEN_ID.to_string(),
        b"png-bytes".to_vec(),
    )]));
    let taken = take_document_binary_of(
        &documents,
        "probe-surface",
        "doc",
        TAKEN_ID,
        native_take(&stored),
    )
    .expect("the stored id is taken");
    assert_eq!(
        taken,
        b"png-bytes".to_vec(),
        "the take returns the stored bytes"
    );
    let again = take_document_binary_of(
        &documents,
        "probe-surface",
        "doc",
        TAKEN_ID,
        native_take(&stored),
    );
    assert_eq!(
        again,
        Err("the binary id is not stored".to_string()),
        "a second take gives the native error text"
    );
}

// contract: documents.binary.take-errors
#[test]
fn a_take_of_a_missing_document_gives_the_document_error_text() {
    let documents = Documents::default();
    let stored = Mutex::new(HashMap::new());
    let error = take_document_binary_of(
        &documents,
        "probe-surface",
        "doc",
        TAKEN_ID,
        native_take(&stored),
    );
    assert_eq!(
        error,
        Err("document \"doc\" is not attached".to_string()),
        "the missing document gives the text of the other document operations"
    );
}
