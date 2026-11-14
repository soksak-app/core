//! The binary store of the view of a surface (docs/spec/native-surfaces.md#view-surfaces): the take and the put of a binary id, and
//! the clipboard PNG of the view calls, which travels through the store (docs/spec/plugin-processes.md#binary-path). The tests run on
//! the real platform: a real window with a main page, a real surface and a real view whose native document holds the store. The native
//! layer runs only on the main thread, so this target runs its tests on the main thread of its process (`harness = false`). The content
//! type that the store keeps is read by native/darwin/tests/document_binary_test.m; the platform interface returns only the bytes. The
//! same cases run in the Go host. The clipboard value is data, because the real clipboard is the pasteboard of the person.

#[cfg(target_os = "macos")]
#[path = "support/folder.rs"]
mod folder;

#[cfg(target_os = "macos")]
#[path = "support/main_thread.rs"]
mod main_thread;

#[cfg(target_os = "macos")]
mod system {
    use std::ffi::{CStr, CString, c_void};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    use core_foundation::runloop::{CFRunLoop, kCFRunLoopDefaultMode};
    use soksak_host::clipboard::{ViewReadResponse, persist_view_png_at, put_view_png};
    use soksak_host::documents::{Documents, VIEW_NAME, put_view_binary_of, take_view_binary_of};
    use soksak_host::platform::{self, ClipboardValue, DocumentOptions, Platform};

    use crate::folder::Folder;
    use crate::main_thread::{self, MainTest};

    unsafe extern "C" {
        fn sp_host_test_window_create(
            width: f64,
            height: f64,
            window: *mut *mut c_void,
        ) -> *const std::ffi::c_char;
        fn sp_host_test_window_close(window: *mut c_void) -> *const std::ffi::c_char;
        fn sp_host_test_window_main_webview(
            window: *mut c_void,
            fixture: *const std::ffi::c_char,
            webview: *mut *mut c_void,
        ) -> *const std::ffi::c_char;
        fn sp_host_test_webview_loaded(webview: *mut c_void) -> *const std::ffi::c_char;
    }

    /// A 1x1 RGBA PNG: its signature and IHDR, which the persist checks, and the bytes that follow.
    const VIEW_PNG: [u8; 33] = [
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F,
        0x15, 0xC4, 0x89,
    ];

    const NOT_STORED: &str = "the binary id is not stored";

    fn native_error(text: *const std::ffi::c_char) -> Result<(), String> {
        if text.is_null() {
            Ok(())
        } else {
            Err(unsafe { CStr::from_ptr(text) }
                .to_string_lossy()
                .into_owned())
        }
    }

    /// The real view of the test: the documents of a window whose surface probe-surface holds the view, on a real window with its main
    /// page. The view, the surface and the window close when the value is dropped.
    struct Probe {
        platform: &'static dyn Platform,
        documents: Documents,
        window: *mut c_void,
        surface: usize,
        view: usize,
        folder: Folder,
    }

    impl Probe {
        /// Creates the window on the main thread, waits for the load of its main page on a thread of its own while the main thread runs
        /// its run loop, which delivers the navigation, and creates the surface and the view.
        fn new() -> Result<Probe, String> {
            let platform = platform::current()?;
            let mut window: *mut c_void = std::ptr::null_mut();
            native_error(unsafe { sp_host_test_window_create(500.0, 400.0, &mut window) })?;
            let fixture = CString::new("main-page.html").expect("the fixture name has no NUL");
            let mut main: *mut c_void = std::ptr::null_mut();
            native_error(unsafe {
                sp_host_test_window_main_webview(window, fixture.as_ptr(), &mut main)
            })?;
            let loaded = Arc::new(AtomicBool::new(false));
            let main_address = main as usize;
            let finished = loaded.clone();
            let wait = std::thread::spawn(move || {
                let result = native_error(unsafe {
                    sp_host_test_webview_loaded(main_address as *mut c_void)
                });
                finished.store(true, Ordering::SeqCst);
                CFRunLoop::get_main().stop();
                result
            });
            while !loaded.load(Ordering::SeqCst) {
                CFRunLoop::run_in_mode(
                    unsafe { kCFRunLoopDefaultMode },
                    std::time::Duration::from_secs(10),
                    false,
                );
            }
            wait.join()
                .map_err(|_| "the load wait panicked".to_string())??;
            platform.set_main_webview(window as usize, main as usize)?;
            let surface = platform.create_surface(window as usize)?;
            let folder = Folder::new();
            let path = folder.path().to_string_lossy().into_owned();
            let view = platform.create_document(
                surface,
                DocumentOptions {
                    directory: &path,
                    folder: &path,
                    plugin: "probe",
                    label: "probe",
                    channel: Some(""),
                },
                Box::new(|_| {}),
            )?;
            let documents = Documents::default();
            let key = ("probe-surface".to_string(), VIEW_NAME.to_string());
            documents.reserve(&key)?;
            documents.set(&key, view);
            Ok(Probe {
                platform,
                documents,
                window,
                surface,
                view,
                folder,
            })
        }

        fn put(&self, bytes: &[u8]) -> Result<String, String> {
            put_view_binary_of(
                &self.documents,
                "probe-surface",
                bytes,
                "image/png",
                |handle, bytes, kind| self.platform.put_document_binary(handle, bytes, kind),
            )
        }

        fn take(&self, surface: &str, id: &str) -> Result<Vec<u8>, String> {
            take_view_binary_of(&self.documents, surface, id, |handle, id| {
                self.platform.take_document_binary(handle, id)
            })
        }

        fn read(&self, value: ClipboardValue) -> Result<ViewReadResponse, String> {
            put_view_png(
                &self.documents,
                "probe-surface",
                value,
                |handle, bytes, kind| self.platform.put_document_binary(handle, bytes, kind),
            )
        }
    }

    impl Drop for Probe {
        fn drop(&mut self) {
            let _ = &self.folder;
            if let Err(error) = self.platform.close_document(self.view) {
                eprintln!("close the view: {error}");
            }
            if let Err(error) = self.platform.close_surface(self.surface) {
                eprintln!("close the surface: {error}");
            }
            if let Err(error) = native_error(unsafe { sp_host_test_window_close(self.window) }) {
                eprintln!("close the window: {error}");
            }
        }
    }

    fn is_id(text: &str) -> bool {
        text.len() == 32
    }

    // contract: documents.binary.view-take-releases-id
    fn a_view_take_returns_the_bytes_of_the_id_and_releases_it() -> Result<(), String> {
        let probe = Probe::new()?;
        let id = probe.put(b"png-bytes")?;
        let taken = probe.take("probe-surface", &id);
        if taken != Ok(b"png-bytes".to_vec()) {
            return Err(format!(
                "the take returned {taken:?}, want the stored bytes"
            ));
        }
        let again = probe.take("probe-surface", &id);
        if again != Err(NOT_STORED.to_string()) {
            return Err(format!(
                "a second take returned {again:?}, want the native error text"
            ));
        }
        Ok(())
    }

    // contract: documents.binary.view-put-mints-id
    fn a_view_put_stores_the_bytes_under_the_minted_id() -> Result<(), String> {
        let probe = Probe::new()?;
        let first = probe.put(b"png-bytes")?;
        let second = probe.put(b"other-bytes")?;
        if !is_id(&first) || !is_id(&second) || first == second {
            return Err(format!(
                "the puts returned {first:?} and {second:?}, want two different minted ids of 32 characters"
            ));
        }
        if probe.take("probe-surface", &first) != Ok(b"png-bytes".to_vec()) {
            return Err(
                "the take of the first id did not return the bytes of the first put".into(),
            );
        }
        if probe.take("probe-surface", &second) != Ok(b"other-bytes".to_vec()) {
            return Err(
                "the take of the second id did not return the bytes of the second put".into(),
            );
        }
        let empty = probe.put(b"");
        if empty != Err("the put holds no bytes".to_string()) {
            return Err(format!(
                "an empty put returned {empty:?}, want the native error text"
            ));
        }
        Ok(())
    }

    // contract: documents.binary.view-errors
    fn a_view_binary_of_a_surface_without_a_view_gives_the_surface_error() -> Result<(), String> {
        let probe = Probe::new()?;
        let id = probe.put(b"png-bytes")?;
        let refusal = "surface \"other-surface\" has no view".to_string();
        let taken = probe.take("other-surface", &id);
        if taken != Err(refusal.clone()) {
            return Err(format!(
                "a take of a surface without a view returned {taken:?}"
            ));
        }
        let put = put_view_binary_of(
            &probe.documents,
            "other-surface",
            b"png-bytes",
            "image/png",
            |handle, bytes, kind| probe.platform.put_document_binary(handle, bytes, kind),
        );
        if put != Err(refusal) {
            return Err(format!(
                "a put of a surface without a view returned {put:?}"
            ));
        }
        if probe.take("probe-surface", &id) != Ok(b"png-bytes".to_vec()) {
            return Err("the store changed: the id put before did not return its bytes".into());
        }
        let again = probe.take("probe-surface", &id);
        if again != Err(NOT_STORED.to_string()) {
            return Err(format!(
                "a second take returned {again:?}: the refusals put an id into the store"
            ));
        }
        Ok(())
    }

    // contract: clipboard.view.read-png-puts-binary
    fn a_view_png_read_puts_the_clipboard_png_into_the_view_store() -> Result<(), String> {
        let probe = Probe::new()?;
        let answer = probe.read(ClipboardValue::Png(VIEW_PNG.to_vec()))?;
        let id = match &answer {
            ViewReadResponse {
                present: true,
                kind: "png",
                binary: Some(id),
            } if is_id(id) => id.clone(),
            other => {
                return Err(format!(
                    "the read answered {other:?}, want a present PNG with the id of the put"
                ));
            }
        };
        if probe.take("probe-surface", &id) != Ok(VIEW_PNG.to_vec()) {
            return Err("the store does not hold the clipboard PNG under the id".into());
        }
        let absent = probe.read(ClipboardValue::Absent)?;
        if (absent
            != ViewReadResponse {
                present: false,
                kind: "png",
                binary: None,
            })
        {
            return Err(format!(
                "the read of a clipboard without a PNG answered {absent:?}"
            ));
        }
        let limit = 16 * 1024 * 1024;
        let at_limit = probe.read(ClipboardValue::Png(vec![0; limit]))?;
        let Some(limit_id) = at_limit.binary.filter(|id| is_id(id)) else {
            return Err("a PNG at the limit was not put".into());
        };
        match probe.take("probe-surface", &limit_id) {
            Ok(bytes) if bytes.len() == limit => {}
            other => {
                return Err(format!(
                    "the store holds {:?} bytes for the PNG at the limit, want {limit}",
                    other.map(|bytes| bytes.len())
                ));
            }
        }
        let over = probe.read(ClipboardValue::Png(vec![0; limit + 1]));
        if over != Err("clipboard PNG exceeds 16 MiB".to_string()) {
            return Err(format!("a PNG over the limit answered {over:?}"));
        }
        Ok(())
    }

    // contract: clipboard.view.persist-png-takes-binary
    fn a_view_png_persist_takes_the_id_and_saves_its_bytes() -> Result<(), String> {
        let probe = Probe::new()?;
        let id = probe.put(&VIEW_PNG)?;
        let root = Folder::new();
        let path = persist_view_png_at(root.path(), || probe.take("probe-surface", &id))?;
        let saved = std::fs::read(&path).map_err(|error| format!("read {path}: {error}"))?;
        if saved != VIEW_PNG.to_vec() {
            return Err("the saved file does not hold the taken PNG".into());
        }
        let again = persist_view_png_at(root.path(), || probe.take("probe-surface", &id));
        if again != Err(NOT_STORED.to_string()) {
            return Err(format!(
                "a persist of a released id returned {again:?}, want the native take error"
            ));
        }
        Ok(())
    }

    const TESTS: &[MainTest] = &[
        (
            "a_view_take_returns_the_bytes_of_the_id_and_releases_it",
            a_view_take_returns_the_bytes_of_the_id_and_releases_it,
        ),
        (
            "a_view_put_stores_the_bytes_under_the_minted_id",
            a_view_put_stores_the_bytes_under_the_minted_id,
        ),
        (
            "a_view_binary_of_a_surface_without_a_view_gives_the_surface_error",
            a_view_binary_of_a_surface_without_a_view_gives_the_surface_error,
        ),
        (
            "a_view_png_read_puts_the_clipboard_png_into_the_view_store",
            a_view_png_read_puts_the_clipboard_png_into_the_view_store,
        ),
        (
            "a_view_png_persist_takes_the_id_and_saves_its_bytes",
            a_view_png_persist_takes_the_id_and_saves_its_bytes,
        ),
    ];

    pub fn main() {
        main_thread::run(TESTS);
    }
}

fn main() {
    #[cfg(target_os = "macos")]
    system::main();
}
