use super::*;

const SWP_NOSIZE: u32 = 0x0001;

// contract: platform.windows.show.position-change-keeps-the-front
#[test]
fn a_show_outside_the_foreground_keeps_the_front() {
    assert_eq!(
        shown_position_flags(SWP_SHOWWINDOW | SWP_NOSIZE, false),
        SWP_SHOWWINDOW | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOZORDER
    );
}

// contract: platform.windows.show.position-change-keeps-the-front
#[test]
fn a_show_inside_the_foreground_stays_as_it_was_asked() {
    assert_eq!(
        shown_position_flags(SWP_SHOWWINDOW | SWP_NOSIZE, true),
        SWP_SHOWWINDOW | SWP_NOSIZE
    );
}

// contract: platform.windows.show.position-change-keeps-the-front
#[test]
fn a_change_that_shows_nothing_stays_as_it_was_asked() {
    assert_eq!(shown_position_flags(SWP_NOSIZE, false), SWP_NOSIZE);
}

// contract: platform.windows.show.only-foreground-shows-with-activation
#[test]
fn only_the_foreground_shows_with_activation() {
    assert_eq!(show_command(true), 5);
    assert_eq!(show_command(false), 4);
}
