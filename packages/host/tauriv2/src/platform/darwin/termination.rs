//! 종료 신호. 첫 신호는 일반 종료를 요청하고, 그 뒤의 신호는 기본 동작으로 프로세스를 끝낸다.

use signal_hook::consts::{SIGHUP, SIGINT, SIGTERM};
use signal_hook::iterator::Signals;
use signal_hook::low_level::emulate_default_handler;

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
                    eprintln!("termination signal {signal}: {error}");
                }
            }
        })
        .map(|_| ())
        .map_err(|e| e.to_string())
}
