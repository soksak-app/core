//! Termination signals. The first signal requests a normal termination, and the signals after it end the process with
//! the default action.

use signal_hook::consts::{SIGHUP, SIGINT, SIGTERM};
use signal_hook::iterator::Signals;
use signal_hook::low_level::emulate_default_handler;

use block2::{Block, RcBlock};

unsafe extern "C" {
    fn sp_termination_signals_record() -> i32;
    fn sp_termination_signal_sender(signal: i32) -> i32;
    fn sp_quit_request_event_type() -> i32;
}

pub fn on_termination(quit: Box<dyn Fn(i32, i32) + Send>) -> Result<(), String> {
    let mut signals = Signals::new([SIGTERM, SIGINT, SIGHUP]).map_err(|e| e.to_string())?;
    // The recorder of the senders is installed after the handler of signal-hook, so it passes each signal on to it.
    let recorded = unsafe { sp_termination_signals_record() };
    if recorded != 0 {
        return Err(format!(
            "record the senders of termination signals: sigaction: {}",
            std::io::Error::from_raw_os_error(recorded)
        ));
    }
    std::thread::Builder::new()
        .name("termination".into())
        .spawn(move || {
            let mut received = signals.forever();
            let Some(signal) = received.next() else {
                return;
            };
            quit(signal, unsafe { sp_termination_signal_sender(signal) });
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

/// The type of the event that the application handles now (quit_request.h), -1 without one. Call it on the main thread.
pub fn quit_event_type() -> i32 {
    unsafe { sp_quit_request_event_type() }
}

/// Installs the termination request handler of the operating system (quit_request.h). The name of the sender is borrowed
/// for the call, so it is copied before quit runs.
pub fn on_quit_request(quit: Box<dyn Fn(i32, String)>) -> Result<(), String> {
    unsafe extern "C" {
        fn sp_quit_request_install(request: &Block<dyn Fn(i32, *const std::ffi::c_char)>) -> bool;
    }
    let request = RcBlock::new(move |sender_pid: i32, sender: *const std::ffi::c_char| {
        let sender = if sender.is_null() {
            String::new()
        } else {
            unsafe { std::ffi::CStr::from_ptr(sender) }
                .to_string_lossy()
                .into_owned()
        };
        quit(sender_pid, sender)
    });
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
