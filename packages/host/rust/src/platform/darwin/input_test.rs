use super::super::Delivery;
use super::input::{Delivered, SpInputHeld, delivered, delivery};
use std::ffi::{CString, c_void};
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

// contract: endpoint.input.resize-edge-refusal
#[test]
fn a_resize_edge_refusal_carries_the_message_of_the_library() {
    let message = "the point (200, 299) lies on the bottom resize edge of the window, where AppKit tracks a press as a window resize; the synthetic press was not delivered";
    let reason = CString::new(message).expect("the message holds no NUL");
    let held = SpInputHeld {
        mask: 0,
        pid: -1,
        bundle_identifier: std::ptr::null(),
        pointer: std::ptr::null(),
        reason: reason.as_ptr(),
    };
    assert_eq!(
        delivery(7, Some(&held)),
        Delivery::ResizeEdge(message.to_string())
    );
}

// contract: endpoint.input.interruption
#[test]
fn an_interruption_carries_the_message_of_the_library() {
    let message = "a person's down of the left button at (100, 80) in the window of the gesture ended the synthetic gesture of pointer a, whose press was released at (60, 50)";
    let reason = CString::new(message).expect("the message holds no NUL");
    let held = SpInputHeld {
        mask: 0,
        pid: -1,
        bundle_identifier: std::ptr::null(),
        pointer: std::ptr::null(),
        reason: reason.as_ptr(),
    };
    assert_eq!(
        delivery(8, Some(&held)),
        Delivery::Interrupted(message.to_string())
    );
}

// contract: endpoint.input.rejection-reason
#[test]
fn a_refusal_carries_the_reason_of_the_library() {
    let message = "no open press of the pointer and button in the window";
    let reason = CString::new(message).expect("the message holds no NUL");
    let held = SpInputHeld {
        mask: 0,
        pid: -1,
        bundle_identifier: std::ptr::null(),
        pointer: std::ptr::null(),
        reason: reason.as_ptr(),
    };
    assert_eq!(
        delivery(1, Some(&held)),
        Delivery::Rejected(message.to_string())
    );
}
