#[repr(C)]
struct Loss {
    events: u64,
    bytes: u64,
}

extern "C" {
    fn sp_event_drain(buffer: *mut u8, capacity: usize) -> usize;
    fn sp_event_take_loss() -> Loss;
    fn sp_observe_activity();
    fn sp_mono_ns() -> u64;
    fn sp_event_set_boot(boot: *const std::ffi::c_char) -> bool;
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

pub fn pull(buffer: &mut [u8]) -> Result<usize, String> {
    if buffer.is_empty() {
        return Err("pull native events: the buffer is empty".into());
    }
    Ok(unsafe { sp_event_drain(buffer.as_mut_ptr(), buffer.len()) })
}

pub fn take_loss() -> Result<(u64, u64), String> {
    let loss = unsafe { sp_event_take_loss() };
    Ok((loss.events, loss.bytes))
}
