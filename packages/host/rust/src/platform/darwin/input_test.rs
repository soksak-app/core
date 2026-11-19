use super::super::Delivery;
use super::input::{SpInputHeld, delivery};
use std::ffi::CString;

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
