//! The binary store of the view of a surface (docs/spec/native-surfaces.md#view-surfaces): the take and the put of a binary id, and
//! the clipboard PNG of the view calls, which travels through the store (docs/spec/plugin-processes.md#binary-path). The native take,
//! put and clipboard read are closures here, so the tests run without a window. The same cases run in the Go host.

use std::cell::RefCell;
use std::collections::HashMap;

use super::{Documents, VIEW_NAME, put_view_binary_of, take_view_binary_of};
use crate::clipboard::{ViewReadResponse, persist_view_png_at, read_view_png_with};
use crate::platform::ClipboardValue;

const TAKEN_ID: &str = "0123456789abcdef0123456789abcdef";

/// A 1x1 RGBA PNG: its signature and IHDR, which the persist checks, and the bytes that follow.
const VIEW_PNG: [u8; 33] = [
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
    0x89,
];

/// The binary store of the native layer in the test: the bytes and the content type of each id. A take releases the id, and a put
/// mints the next id.
#[derive(Default)]
struct Store {
    stored: RefCell<HashMap<String, (Vec<u8>, String)>>,
    puts: RefCell<usize>,
}

impl Store {
    fn take(&self, id: &str) -> Result<Vec<u8>, String> {
        self.stored
            .borrow_mut()
            .remove(id)
            .map(|(bytes, _)| bytes)
            .ok_or_else(|| "the binary id is not stored".to_string())
    }

    fn put(&self, bytes: &[u8], content_type: &str) -> Result<String, String> {
        if bytes.is_empty() {
            return Err("the put holds no bytes".to_string());
        }
        *self.puts.borrow_mut() += 1;
        let id = format!("{:032x}", *self.puts.borrow());
        self.stored
            .borrow_mut()
            .insert(id.clone(), (bytes.to_vec(), content_type.to_string()));
        Ok(id)
    }
}

/// The documents of a window whose surface probe-surface has a view.
fn view_documents() -> Documents {
    let documents = Documents::default();
    let key = ("probe-surface".to_string(), VIEW_NAME.to_string());
    documents.reserve(&key).expect("the view is reserved");
    documents.set(&key, 7);
    documents
}

// contract: documents.binary.view-take-releases-id
#[test]
fn a_view_take_returns_the_bytes_of_the_id_and_releases_it() {
    let documents = view_documents();
    let store = Store::default();
    store.stored.borrow_mut().insert(
        TAKEN_ID.to_string(),
        (b"png-bytes".to_vec(), "image/png".to_string()),
    );
    let taken = take_view_binary_of(&documents, "probe-surface", TAKEN_ID, |_, id| {
        store.take(id)
    });
    assert_eq!(
        taken,
        Ok(b"png-bytes".to_vec()),
        "the take returns the stored bytes"
    );
    let again = take_view_binary_of(&documents, "probe-surface", TAKEN_ID, |_, id| {
        store.take(id)
    });
    assert_eq!(
        again,
        Err("the binary id is not stored".to_string()),
        "a second take gives the native error text"
    );
}

// contract: documents.binary.view-put-mints-id
#[test]
fn a_view_put_stores_the_bytes_under_the_minted_id() {
    let documents = view_documents();
    let store = Store::default();
    let id = put_view_binary_of(
        &documents,
        "probe-surface",
        b"png-bytes",
        "image/png",
        |_, bytes, kind| store.put(bytes, kind),
    );
    assert_eq!(
        id,
        Ok(format!("{:032x}", 1)),
        "the put returns the minted id"
    );
    assert_eq!(
        store.stored.borrow().get(&format!("{:032x}", 1)),
        Some(&(b"png-bytes".to_vec(), "image/png".to_string())),
        "the store holds the bytes with their content type"
    );
    let empty = put_view_binary_of(
        &documents,
        "probe-surface",
        b"",
        "image/png",
        |_, bytes, kind| store.put(bytes, kind),
    );
    assert_eq!(
        empty,
        Err("the put holds no bytes".to_string()),
        "a refusal of the native put is passed on"
    );
}

// contract: documents.binary.view-errors
#[test]
fn a_view_binary_of_a_surface_without_a_view_gives_the_surface_error() {
    let documents = view_documents();
    let store = Store::default();
    store.stored.borrow_mut().insert(
        TAKEN_ID.to_string(),
        (b"png-bytes".to_vec(), "image/png".to_string()),
    );
    let taken = take_view_binary_of(&documents, "other-surface", TAKEN_ID, |_, id| {
        store.take(id)
    });
    assert_eq!(
        taken,
        Err("surface \"other-surface\" has no view".to_string()),
        "a take of a surface without a view names the surface"
    );
    let put = put_view_binary_of(
        &documents,
        "other-surface",
        b"png-bytes",
        "image/png",
        |_, bytes, kind| store.put(bytes, kind),
    );
    assert_eq!(
        put,
        Err("surface \"other-surface\" has no view".to_string()),
        "a put of a surface without a view names the surface"
    );
    assert_eq!(store.stored.borrow().len(), 1, "the store keeps its one id");
    assert_eq!(*store.puts.borrow(), 0, "no put reaches the store");
}

// contract: clipboard.view.read-png-puts-binary
#[test]
fn a_view_png_read_puts_the_clipboard_png_into_the_view_store() {
    let store = Store::default();
    let read = read_view_png_with(
        || Ok(ClipboardValue::Png(VIEW_PNG.to_vec())),
        |bytes| store.put(bytes, "image/png"),
    );
    assert_eq!(
        read,
        Ok(ViewReadResponse {
            present: true,
            kind: "png",
            binary: Some(format!("{:032x}", 1))
        }),
        "the read answers the present PNG with the minted id"
    );
    assert_eq!(
        store.stored.borrow().get(&format!("{:032x}", 1)),
        Some(&(VIEW_PNG.to_vec(), "image/png".to_string())),
        "the store holds the clipboard PNG as image/png"
    );
    let absent = read_view_png_with(
        || Ok(ClipboardValue::Absent),
        |bytes| store.put(bytes, "image/png"),
    );
    assert_eq!(
        absent,
        Ok(ViewReadResponse {
            present: false,
            kind: "png",
            binary: None
        }),
        "a clipboard without a PNG answers an absent PNG"
    );
    assert_eq!(*store.puts.borrow(), 1, "an absent PNG puts nothing");
}

// contract: clipboard.view.persist-png-takes-binary
#[test]
fn a_view_png_persist_takes_the_id_and_saves_its_bytes() {
    let store = Store::default();
    store.stored.borrow_mut().insert(
        TAKEN_ID.to_string(),
        (VIEW_PNG.to_vec(), "image/png".to_string()),
    );
    let root = crate::test_folder::Folder::new();
    let path =
        persist_view_png_at(root.path(), || store.take(TAKEN_ID)).expect("the taken PNG is saved");
    assert_eq!(
        std::fs::read(&path).expect("the saved file"),
        VIEW_PNG.to_vec(),
        "the file holds the taken PNG"
    );
    assert!(
        store.stored.borrow().is_empty(),
        "the persist releases the id"
    );
    let again = persist_view_png_at(root.path(), || store.take(TAKEN_ID));
    assert_eq!(
        again,
        Err("the binary id is not stored".to_string()),
        "a persist of a released id gives the native take error"
    );
}
