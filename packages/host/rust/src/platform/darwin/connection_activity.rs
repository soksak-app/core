//! The activity that the host holds while a connection of its endpoint is open (connection_activity.h).

unsafe extern "C" {
    fn sp_connection_activity_hold(held: bool);
}

/// Holds or releases the activity; a call that requests the current state changes nothing.
pub fn hold_connection_activity(held: bool) {
    unsafe { sp_connection_activity_hold(held) };
}
