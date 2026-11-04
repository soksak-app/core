//! Main queue execution outside the framework event lock.

pub fn enqueue(work: Box<dyn FnOnce() + Send>) {
    unsafe extern "C" {
        fn sp_ui_enqueue(callback: extern "C" fn(usize), context: usize);
    }
    extern "C" fn run(context: usize) {
        let work = unsafe { Box::from_raw(context as *mut Box<dyn FnOnce() + Send>) };
        work();
    }
    let context = Box::into_raw(Box::new(work)) as usize;
    unsafe { sp_ui_enqueue(run, context) }
}

pub fn enqueue_after(
    delay: std::time::Duration,
    work: Box<dyn FnOnce() + Send>,
) -> Result<(), String> {
    unsafe extern "C" {
        fn sp_ui_enqueue_after(delay: u64, callback: extern "C" fn(usize), context: usize);
    }
    extern "C" fn run(context: usize) {
        let work = unsafe { Box::from_raw(context as *mut Box<dyn FnOnce() + Send>) };
        work();
    }
    let delay = u64::try_from(delay.as_nanos())
        .map_err(|_| format!("UI queue delay {delay:?} exceeds the nanosecond range"))?;
    let context = Box::into_raw(Box::new(work)) as usize;
    unsafe { sp_ui_enqueue_after(delay, run, context) }
    Ok(())
}
