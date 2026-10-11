#[repr(C)]
struct Loss {
    events: u64,
    bytes: u64,
}

extern "C" {
    fn sp_event_drain(buffer: *mut u8, capacity: usize) -> usize;
    fn sp_event_take_loss(channel: u8) -> Loss;
    fn sp_event_set_policy(levels: *const i8) -> bool;
    fn sp_observe_activity();
    fn sp_observe_flush();
    fn sp_mono_ns() -> u64;
    fn sp_event_set_boot(boot: *const std::ffi::c_char) -> bool;
}

pub fn flush_native_observers() -> Result<(), String> {
    unsafe { sp_observe_flush() };
    Ok(())
}

pub fn observe_activity() -> Result<(), String> {
    unsafe { sp_observe_activity() };
    Ok(())
}

pub fn monotonic_ns() -> Result<u64, String> {
    Ok(unsafe { sp_mono_ns() })
}

pub fn set_boot(boot: &str) -> Result<(), String> {
    let text = std::ffi::CString::new(boot)
        .map_err(|_| format!("set event boot: {boot:?} holds a NUL character"))?;
    if unsafe { sp_event_set_boot(text.as_ptr()) } {
        Ok(())
    } else {
        Err(format!(
            "set event boot: the native layer refused {boot:?}; a boot identifier is 1 to 64 letters, digits, '-' and '_'"
        ))
    }
}

pub fn set_policy(levels: [i8; 5]) -> Result<(), String> {
    if unsafe { sp_event_set_policy(levels.as_ptr()) } {
        Ok(())
    } else {
        Err(format!(
            "set native event policy: the native library refused {levels:?} (a level is -1 to 4)"
        ))
    }
}

pub fn pull(buffer: &mut [u8]) -> Result<usize, String> {
    if buffer.is_empty() {
        return Err("pull native events: the buffer is empty".into());
    }
    Ok(unsafe { sp_event_drain(buffer.as_mut_ptr(), buffer.len()) })
}

pub fn take_loss(channel: u8) -> Result<(u64, u64), String> {
    let loss = unsafe { sp_event_take_loss(channel) };
    Ok((loss.events, loss.bytes))
}
