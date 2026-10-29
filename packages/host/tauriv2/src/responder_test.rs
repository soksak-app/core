//! Checks that the page receives the first responder at its ready and then at each change, and that a page that is not ready
//! receives none.

use std::cell::RefCell;

use serde_json::json;

use super::*;

// contract: window.responder.sent-at-ready-and-on-each-change
#[test]
fn the_responder_event_follows_the_first_responder_after_the_page_is_ready() {
    let state = Mutex::new(None);
    let current = RefCell::new(json!({"owner": "page", "surface": null, "document": null}));
    let sent = RefCell::new(Vec::new());
    let send = |force: bool, ready: bool| {
        send_changed_responder(
            &state,
            force,
            || ready,
            || Ok(current.borrow().clone()),
            |value| {
                sent.borrow_mut().push(value);
                Ok(())
            },
        )
        .unwrap()
    };
    send(false, false);
    assert!(
        sent.borrow().is_empty(),
        "a page that is not ready received {:?}",
        sent.borrow()
    );
    send(true, true);
    *current.borrow_mut() = json!({"owner": "surface", "surface": "tab-view", "document": null});
    send(false, true);
    send(false, true);
    send(true, true);
    let view = json!({"owner": "surface", "surface": "tab-view", "document": null});
    assert_eq!(
        *sent.borrow(),
        vec![
            json!({"owner": "page", "surface": null, "document": null}),
            view.clone(),
            view
        ],
        "the page did not receive the ready value, one value for the change and the value at the next ready"
    );
    let failed = send_changed_responder(
        &state,
        false,
        || true,
        || Err("window facts missing responder".to_string()),
        |_| Ok(()),
    );
    assert_eq!(failed, Err("window facts missing responder".to_string()));
}
