//! 창과 웹뷰에 붙인 라이브러리 객체의 살아 있는 수를 센다. 구현은 native/darwin 의 window_objects.m 이다. 진단
//! 빌드에만 들어간다.

use std::ffi::c_void;

use super::super::WindowObjects;

/// native/darwin 의 sp_window_objects 와 같은 배치. macOS 는 LP64 이므로 C 의 long 은 i64 다.
#[repr(C)]
struct Counts {
    window_compositions: i64,
    surface_hosts: i64,
    input_registrations: i64,
}

extern "C" {
    fn sp_window_objects_when(
        expected: *const Counts,
        seconds: f64,
        done: extern "C" fn(context: *mut c_void, counts: *const Counts, reached: bool),
        context: *mut c_void,
    );
}

type Done = Box<dyn FnOnce(WindowObjects, bool) + Send>;

extern "C" fn counted(context: *mut c_void, counts: *const Counts, reached: bool) {
    // context 는 when 이 Box::into_raw 로 넘긴 값이고 라이브러리는 done 을 한 번 호출한다.
    let done = unsafe { Box::from_raw(context.cast::<Done>()) };
    let counts = unsafe { &*counts };
    done(
        WindowObjects {
            window_compositions: counts.window_compositions,
            surface_hosts: counts.surface_hosts,
            input_registrations: counts.input_registrations,
        },
        reached,
    );
}

/// 애플리케이션이 이벤트 하나를 처리한 뒤 수가 expected 와 같아질 때, 또는 seconds 가 지날 때의 수를 done 에
/// 준다. 메인 스레드에서 호출한다.
pub fn when(expected: Option<WindowObjects>, seconds: f64, done: Done) {
    // 라이브러리는 호출하는 동안 expected 를 복사한다.
    let wanted = expected.map(|counts| Counts {
        window_compositions: counts.window_compositions,
        surface_hosts: counts.surface_hosts,
        input_registrations: counts.input_registrations,
    });
    let pointer = wanted
        .as_ref()
        .map_or(std::ptr::null(), |counts| counts as *const Counts);
    let context = Box::into_raw(Box::new(done)).cast();
    unsafe { sp_window_objects_when(pointer, seconds, counted, context) }
}
