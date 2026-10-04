//! 종료 신호. 첫 신호는 일반 종료를 요청하고, 그 뒤의 신호는 기본 동작으로 프로세스를 끝낸다.

use signal_hook::consts::{SIGHUP, SIGINT, SIGTERM};
use signal_hook::iterator::Signals;
use signal_hook::low_level::emulate_default_handler;

use block2::{Block, RcBlock};

pub fn on_termination(quit: Box<dyn Fn() + Send>) -> Result<(), String> {
    let mut signals = Signals::new([SIGTERM, SIGINT, SIGHUP]).map_err(|e| e.to_string())?;
    std::thread::Builder::new()
        .name("termination".into())
        .spawn(move || {
            let mut received = signals.forever();
            if received.next().is_none() {
                return;
            }
            quit();
            // 다음 신호는 기본 동작으로 프로세스를 끝낸다. 종료 중 저장이 멈춰도 끝낼 수 있다.
            for signal in received {
                if let Err(error) = emulate_default_handler(signal) {
                    crate::application_log::log_error(
                        &format!("termination signal {signal}"),
                        error,
                    );
                }
            }
        })
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// 운영체제의 종료 요청 처리기를 설치한다(quit_request.h).
pub fn on_quit_request(quit: Box<dyn Fn()>) -> Result<(), String> {
    extern "C" {
        fn sp_quit_request_install(request: &Block<dyn Fn()>) -> bool;
    }
    let request = RcBlock::new(quit);
    if unsafe { sp_quit_request_install(&request) } {
        Ok(())
    } else {
        Err("failed to register the quit request handler".into())
    }
}

/// 받은 종료 요청에 오류 없이 답한다(quit_request.h).
pub fn answer_quit_requests() {
    extern "C" {
        fn sp_quit_request_answer();
    }
    unsafe { sp_quit_request_answer() }
}
