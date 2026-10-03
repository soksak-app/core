//! 프로세스의 종료를 기다린다. 구현은 native/darwin 의 process_exit.m 이다. 진단 빌드에만 들어간다.

use std::ffi::c_void;

extern "C" {
    fn sp_process_when_exited(
        pid: i32,
        seconds: f64,
        done: extern "C" fn(context: *mut c_void, exited: bool),
        context: *mut c_void,
    );
}

type Done = Box<dyn FnOnce(bool) + Send>;

extern "C" fn answered(context: *mut c_void, exited: bool) {
    // context 는 when_exited 가 Box::into_raw 로 넘긴 값이고 라이브러리는 done 을 한 번 호출한다.
    let done = unsafe { Box::from_raw(context.cast::<Done>()) };
    done(exited);
}

/// pid 의 프로세스가 끝나거나 seconds 가 지나면 done 에 답한다. 메인 스레드에서 호출한다.
pub fn when_exited(pid: i32, seconds: f64, done: Done) {
    let context = Box::into_raw(Box::new(done)).cast();
    unsafe { sp_process_when_exited(pid, seconds, answered, context) }
}
