use std::cell::RefCell;

use crate::windows::{WindowFront, show_project_owner};

/// Records the calls that show a window, in place of the native window.
#[derive(Default)]
struct FrontRecord {
    calls: RefCell<Vec<&'static str>>,
}

impl WindowFront for FrontRecord {
    fn show(&self) -> tauri::Result<()> {
        self.calls.borrow_mut().push("show");
        Ok(())
    }

    fn set_focus(&self) -> tauri::Result<()> {
        self.calls.borrow_mut().push("focus");
        Ok(())
    }
}

// contract: project.open.other-owner-is-shown-without-activation
#[test]
fn project_open_shows_the_other_owner_without_activation() {
    let owner = FrontRecord::default();
    show_project_owner(&owner).unwrap();
    assert_eq!(
        *owner.calls.borrow(),
        ["show"],
        "the owner window must be shown without the focus that activates the application"
    );
}
