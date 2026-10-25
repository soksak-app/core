use soksak_host_tauriv2::sidecars::receive_sidecar_message;
use std::cell::{Cell, RefCell};

#[test]
fn a_handled_image_records_its_receipt_once() {
    let receipts = Cell::new(0);
    let handled = receive_sidecar_message(|| receipts.set(receipts.get() + 1), || true);
    assert!(handled, "the image must remain consumed by native dispatch");
    assert_eq!(
        receipts.get(),
        1,
        "a handled image must retain its receive trace"
    );
}

#[test]
fn ordinary_message_keeps_its_receipt_and_page_delivery() {
    let receipts = Cell::new(0);
    let handled = receive_sidecar_message(|| receipts.set(receipts.get() + 1), || false);
    assert!(
        !handled,
        "the ordinary message must remain available for page delivery"
    );
    assert_eq!(receipts.get(), 1);
}

#[test]
fn receipt_precedes_native_dispatch() {
    let order = RefCell::new(Vec::new());
    receive_sidecar_message(
        || order.borrow_mut().push("receive"),
        || {
            order.borrow_mut().push("image");
            true
        },
    );
    assert_eq!(*order.borrow(), vec!["receive", "image"]);
}
