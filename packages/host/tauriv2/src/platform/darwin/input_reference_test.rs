use super::input_reference::call;
use std::{cell::Cell, rc::Rc};

// contract: diagnostics.input-reference.rejects-nul
#[test]
fn input_reference_rejects_nul() {
    for (action, document) in [("a\0b", None), ("wait", Some("a\0b"))] {
        let count = Rc::new(Cell::new(0));
        let completed = count.clone();
        call(
            0,
            action,
            document,
            Box::new(move |result| {
                completed.set(completed.get() + 1);
                assert!(result.unwrap_err().contains("NUL"));
            }),
        );
        assert_eq!(count.get(), 1);
    }
}
