//! Main queue execution outside the framework event lock.

pub fn enqueue(work: Box<dyn FnOnce() + Send>) {
    extern "C" {
        fn sp_ui_enqueue(callback: extern "C" fn(usize), context: usize);
    }
    extern "C" fn run(context: usize) {
        let work = unsafe { Box::from_raw(context as *mut Box<dyn FnOnce() + Send>) };
        work();
    }
    let context = Box::into_raw(Box::new(work)) as usize;
    unsafe { sp_ui_enqueue(run, context) }
}
