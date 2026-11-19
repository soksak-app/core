use super::input::{Delivered, delivered};
use crate::platform::Delivery;
use std::ffi::c_void;
use std::sync::mpsc;

// contract: input.pointer.attributes-the-press-to-the-view-it-reached
#[test]
fn a_delivered_press_answers_the_view_that_it_reached() {
    // sp_input_pointer_then answers SP_INPUT_DELIVERED (0) with the web view that the press reached, and SP_INPUT_UNRECEIVED (3)
    // and a delivery without a web view with none.
    for (result, view, want) in [
        (0, 0x77usize, (Delivery::Delivered, Some(0x77))),
        (3, 0x77, (Delivery::Unreceived, None)),
        (0, 0, (Delivery::Delivered, None)),
    ] {
        let (tx, rx) = mpsc::channel();
        let done: Delivered = Box::new(move |delivery, view| tx.send((delivery, view)).unwrap());
        let context = Box::into_raw(Box::new(done)) as *mut c_void;
        delivered(context, result, std::ptr::null(), view as *mut c_void);
        assert_eq!(
            rx.recv().unwrap(),
            want,
            "the answer of result {result} with view {view:#x}"
        );
    }
}
