#[repr(C)]
struct Loss {
    events: u64,
    bytes: u64,
}

extern "C" {
    fn sp_event_drain(buffer: *mut u8, capacity: usize) -> usize;
    fn sp_event_take_loss() -> Loss;
    fn sp_observe_activity();
}

pub fn observe_activity() -> Result<(), String> {
    unsafe { sp_observe_activity() };
    Ok(())
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
