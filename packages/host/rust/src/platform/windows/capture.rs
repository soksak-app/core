//! Still capture of a WebView2, through CapturePreview. A capture waits on the thread of its request, and CapturePreview runs and completes
//! on the UI thread.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::{LazyLock, mpsc};

use ::windows::Win32::System::Com::StructuredStorage::CreateStreamOnHGlobal;
use ::windows::Win32::System::Com::{IStream, STREAM_SEEK_END, STREAM_SEEK_SET};
use ::windows::Win32::UI::WindowsAndMessaging::{IsIconic, IsWindowVisible};
use ::windows::core::BOOL;
use webview2_com::CapturePreviewCompletedHandler;
use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG;

use super::ui_thread::{error, on_ui_thread, post};
use super::webview::view_of;
use crate::framework::Window;
use crate::platform::Handle;
use crate::platform::devtools_input::{
    CaptureEnds, capture_end_failure, capture_refusal, check_still,
};

/// The ends of the still captures that wait. CapturePreview is reported never to complete in a covered window, so no limit ends
/// the wait, and the end of its request does.
static STILL_ENDS: LazyLock<CaptureEnds> = LazyLock::new(CaptureEnds::default);

/// Ends the wait of the still capture of token with reason.
pub fn end_still(token: u64, reason: &str) {
    STILL_ENDS.end(token, reason);
}

/// The window number of a window is its handle: a web view is no window of its own here.
pub fn window_numbers(window: &Window) -> Result<Vec<isize>, String> {
    let handle = window.native_window().map_err(|e| e.to_string())?;
    Ok(vec![handle as isize])
}

/// Writes one picture of the web view of the window to path as PNG. The wait runs on the caller's thread and the completion on the UI
/// thread, so a call on the UI thread would wait for itself.
pub fn capture_still(window_number: isize, path: &str, token: u64) -> Result<(), String> {
    if on_ui_thread() {
        return Err(
            "capture: a capture waits for the UI thread, and it was called on that thread"
                .to_string(),
        );
    }
    let (ended, wait) = mpsc::channel();
    // The receiver takes the first of the completion and the end, and what comes later finds no request.
    let end = ended.clone();
    STILL_ENDS.wait(
        token,
        Box::new(move |reason| answer_capture(&end, Err(capture_end_failure(&reason)))),
    );
    let posted = post(Box::new(move || {
        let done = {
            let ended = ended.clone();
            Box::new(move |picture| answer_capture(&ended, picture))
        };
        if let Err(failure) = start_capture(window_number as Handle, done) {
            answer_capture(&ended, Err(failure));
        }
    }));
    let received = posted
        .map_err(|e| error("capture", e))
        .and_then(|()| wait.recv().map_err(|e| error("capture", e)));
    STILL_ENDS.forget(token);
    let data = received??;
    check_still(&data)?;
    std::fs::write(path, data).map_err(|e| error("capture", e))
}

/// Sends the end of a capture to its request, which is waiting unless its thread is gone.
fn answer_capture(ended: &mpsc::Sender<Result<Vec<u8>, String>>, picture: Result<Vec<u8>, String>) {
    if ended.send(picture).is_err() {
        crate::application_log::log_info("capture", "a capture ended after its request");
    }
}

/// Starts CapturePreview on the UI thread. The error is why it did not start, and otherwise done receives the end once.
fn start_capture(
    window: Handle,
    done: Box<dyn FnOnce(Result<Vec<u8>, String>)>,
) -> Result<(), String> {
    let view = view_of(window)?;
    let minimized = unsafe { IsIconic(view.window) }.as_bool();
    let shown = unsafe { IsWindowVisible(view.window) }.as_bool();
    let mut visible = BOOL::default();
    unsafe { view.controller.IsVisible(&mut visible) }
        .map_err(|e| error("capture: web view visibility", e))?;
    capture_refusal(minimized, shown, visible.as_bool())?;
    let core =
        unsafe { view.controller.CoreWebView2() }.map_err(|e| error("capture: web view", e))?;
    let stream = unsafe { CreateStreamOnHGlobal(Default::default(), true) }
        .map_err(|e| error("capture: stream", e))?;
    let read = stream.clone();
    let finish = Rc::new(RefCell::new(Some(done)));
    let completed = finish.clone();
    let handler = CapturePreviewCompletedHandler::create(Box::new(move |result| {
        if let Some(done) = completed.borrow_mut().take() {
            done(
                result
                    .map_err(|e| error("capture: CapturePreview", e))
                    .and_then(|()| stream_bytes(&read)),
            );
        }
        Ok(())
    }));
    let started = unsafe {
        core.CapturePreview(
            COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
            &stream,
            &handler,
        )
    };
    if let Err(failure) = started
        && let Some(done) = finish.borrow_mut().take()
    {
        done(Err(error("capture: CapturePreview", failure)));
    }
    Ok(())
}

/// Reads a whole stream.
fn stream_bytes(stream: &IStream) -> Result<Vec<u8>, String> {
    let mut size = 0u64;
    unsafe { stream.Seek(0, STREAM_SEEK_END, Some(&mut size)) }
        .map_err(|e| error("capture: stream size", e))?;
    unsafe { stream.Seek(0, STREAM_SEEK_SET, None) }
        .map_err(|e| error("capture: stream start", e))?;
    let mut data = vec![0u8; size as usize];
    if data.is_empty() {
        return Ok(data);
    }
    let mut read = 0u32;
    unsafe { stream.Read(data.as_mut_ptr().cast(), size as u32, Some(&mut read)) }
        // silent: ok turns the status of Read into the Result reported on the next line
        .ok()
        .map_err(|e| error("capture: stream read", e))?;
    data.truncate(read as usize);
    Ok(data)
}
