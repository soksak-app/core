use std::cell::RefCell;

use crate::windows::{WindowFront, show_project_owner};

/// Records the calls that show a window, in place of the native window.
#[derive(Default)]
struct FrontRecord {
    calls: RefCell<Vec<&'static str>>,
}

impl WindowFront for FrontRecord {
    fn show(&self) -> crate::framework::Result<()> {
        self.calls.borrow_mut().push("show");
        Ok(())
    }

    fn focus(&self) -> crate::framework::Result<()> {
        self.calls.borrow_mut().push("focus");
        Ok(())
    }

    fn is_focused(&self) -> crate::framework::Result<bool> {
        Ok(false)
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

/// Records the steps that put a new window on the screen, in place of the platform and the native window.
#[derive(Default)]
struct NewWindowRecord {
    calls: RefCell<Vec<&'static str>>,
}

impl crate::windows::NewWindowShow for NewWindowRecord {
    fn place(&self) -> Result<(), String> {
        self.calls.borrow_mut().push("place");
        Ok(())
    }

    fn reveal(&self) -> Result<(), String> {
        self.calls.borrow_mut().push("reveal");
        Ok(())
    }

    fn show(&self) -> Result<(), String> {
        self.calls.borrow_mut().push("show");
        Ok(())
    }
}

// A framework places a new window on the display of the key window of the active application, which for an application that
// is not active is the display of another application, so the host places every new window before it shows it
// (native/darwin/src/window_reveal.h).
// contract: application.window.new-window-placed-before-show
#[test]
fn a_new_window_is_placed_before_it_shows() {
    let window = NewWindowRecord::default();
    crate::windows::show_new_window(&window).unwrap();
    assert_eq!(
        *window.calls.borrow(),
        ["place", "reveal", "show"],
        "the new window must be placed once before it is shown"
    );
}
