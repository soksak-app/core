//! The memory pressure owner of the process (docs/spec/hosts.md#memory-pressure). The implementation is
//! memory_pressure.m of native/darwin.

use std::ffi::{CStr, CString, c_char};

use block2::{Block, RcBlock};

unsafe extern "C" {
    fn sp_memory_pressure_start(report: &Block<dyn Fn(*const c_char, u64)>) -> bool;
    fn sp_memory_pressure_inject(level: *const c_char) -> bool;
}

/// Starts the memory pressure source; report runs on the main thread with each report (memory_pressure.h).
pub fn start(report: crate::memory_pressure::Report) -> Result<(), String> {
    let block = RcBlock::new(move |level: *const c_char, seq: u64| {
        // The library passes one of its constant level names, which stay valid until the process ends.
        let level = unsafe { CStr::from_ptr(level) }.to_string_lossy();
        report(&level, seq);
    });
    if unsafe { sp_memory_pressure_start(&block) } {
        Ok(())
    } else {
        Err("failed to start the memory pressure source".into())
    }
}

/// Delivers the level as the memory pressure source delivers it (memory_pressure.h).
pub fn inject(level: &str) -> Result<(), String> {
    let text = CString::new(level).map_err(|error| error.to_string())?;
    if unsafe { sp_memory_pressure_inject(text.as_ptr()) } {
        Ok(())
    } else {
        Err(format!(
            "the memory pressure source did not accept the level {level}"
        ))
    }
}
