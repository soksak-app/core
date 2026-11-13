//! The heartbeat and the sample of a stall of the host on macOS: the native library answers the heartbeat on the main
//! thread in C and reads the state of the main run loop (stall_watch.h), and the system tool `sample` writes the stacks of every thread of this process.

/// Writes the stacks of every thread of this process, sampled for one second, to path.
pub fn sample_threads(path: &std::path::Path) -> Result<(), String> {
    let output = std::process::Command::new("/usr/bin/sample")
        .arg(std::process::id().to_string())
        .arg("1")
        .arg("-file")
        .arg(path)
        .output()
        .map_err(|error| format!("start /usr/bin/sample: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "/usr/bin/sample ended with {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

unsafe extern "C" {
    fn sp_stall_heartbeat(now: *mut u64, answered: *mut u64);
    fn sp_stall_await_awake();
    fn sp_stall_schedule(priority: *mut i32, cpu_ns: *mut u64) -> i32;
}

/// The time of the call and the time of the last answer, on the clock of `sp_mono_ns`.
pub fn stall_heartbeat() -> (u64, u64) {
    let (mut now, mut answered) = (0u64, 0u64);
    unsafe { sp_stall_heartbeat(&mut now, &mut answered) };
    (now, answered)
}

/// Blocks while the main run loop waits for an event.
pub fn stall_await_awake() {
    unsafe { sp_stall_await_awake() };
}

/// The scheduling priority of this process and the CPU time of its threads, in nanoseconds.
pub fn stall_schedule() -> Result<(i32, u64), String> {
    let (mut priority, mut cpu) = (0i32, 0u64);
    let code = unsafe { sp_stall_schedule(&mut priority, &mut cpu) };
    if code != 0 {
        return Err(format!("process schedule: errno {code}"));
    }
    Ok((priority, cpu))
}
