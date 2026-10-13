//! Termination signals. The first signal requests a normal termination, and the signals after it end the process with
//! the default action.

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
            // The next signal ends the process with the default action. It can end the process even if the save during
            // termination stops.
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

/// Installs the termination request handler of the operating system (quit_request.h).
pub fn on_quit_request(quit: Box<dyn Fn()>) -> Result<(), String> {
    unsafe extern "C" {
        fn sp_quit_request_install(request: &Block<dyn Fn()>) -> bool;
    }
    let request = RcBlock::new(quit);
    if unsafe { sp_quit_request_install(&request) } {
        Ok(())
    } else {
        Err("failed to register the quit request handler".into())
    }
}

/// Answers the termination request that was received with userCanceledErr (quit_request.h).
pub fn cancel_quit_requests() {
    unsafe extern "C" {
        fn sp_quit_request_cancel();
    }
    unsafe { sp_quit_request_cancel() }
}

/// Answers the termination request that was received without an error (quit_request.h).
pub fn answer_quit_requests() {
    unsafe extern "C" {
        fn sp_quit_request_answer();
    }
    unsafe { sp_quit_request_answer() }
}
