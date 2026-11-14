//! Tests of the recording of a new window against the real native recorder, on the main thread of the process. The hold of the
//! next show of a window needs no window on screen: a hold that is set already makes the next hold fail with the error of the
//! native library, and a wait for a held window that no window shows ends with the stop of the recording. The recorder of a
//! window with the images of the window server is judged by e2e/capture-state.test.mjs.

#[path = "support/folder.rs"]
mod folder;
#[path = "support/main_thread.rs"]
mod main_thread;

// The recording exists only in diagnostic builds, so the target has its tests only with the feature diagnostics; without it the
// target lists no test, and the runs without the feature build it as every other target.
#[cfg(feature = "diagnostics")]
mod hold {
    use super::{folder, main_thread};

    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU64, Ordering};

    use soksak_host::platform::{self, Platform};
    use soksak_host::recording::{Capture, NewWindowCapture, Plan, Recording, Target};

    /// The recorder of the platform, called directly as the host calls it (`PlatformCapture` of the diagnostics module) without the
    /// waits that end with a window or a connection of an endpoint request.
    struct NativeRecorder {
        platform: &'static dyn Platform,
    }

    static TOKENS: AtomicU64 = AtomicU64::new(0);

    impl Capture for NativeRecorder {
        fn open(&self, target: Target) -> Result<(), String> {
            self.platform.capture_open(target.window, target.display)
        }
        fn start(&self, directory: &Path, plan: Plan) -> Result<(), String> {
            let token = TOKENS.fetch_add(1, Ordering::SeqCst) + 1;
            self.platform.capture_start(
                &directory.to_string_lossy(),
                plan.gap,
                plan.seconds,
                plan.frames,
                token,
            )
        }
        fn stop(&self) -> Result<i32, String> {
            let token = TOKENS.fetch_add(1, Ordering::SeqCst) + 1;
            self.platform.capture_stop(0.0, token)
        }
    }

    impl NewWindowCapture for NativeRecorder {
        fn hold_new_window(&self) -> Result<(), String> {
            self.platform.capture_hold_new_window()
        }
        fn wait_new_window(
            &self,
            register_end: &dyn Fn(Box<dyn Fn(&'static str) + Send + Sync>),
        ) -> Result<isize, String> {
            let token = TOKENS.fetch_add(1, Ordering::SeqCst) + 1;
            let platform = self.platform;
            register_end(Box::new(move |reason| {
                platform.capture_end_wait(token, reason)
            }));
            self.platform.capture_wait_new_window(token)
        }
        fn release_new_window(&self) {
            self.platform.capture_release_new_window();
        }
    }

    const PLAN: Plan = Plan {
        gap: 8.0,
        seconds: 0.0,
        frames: 120,
    };

    fn make_new(path: &Path) -> Result<(), String> {
        std::fs::create_dir(path).map_err(|e| e.to_string())
    }

    /// Creates path with a file in it and removes its permissions, so the real filesystem refuses its removal.
    fn make_blocked(path: &Path) -> Result<(), String> {
        make_new(path)?;
        std::fs::copy(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/recording/blocker"),
            path.join("blocker"),
        )
        .map_err(|e| e.to_string())?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o000))
            .map_err(|e| e.to_string())
    }

    // contract: recording.start.cleanup-failure-retains-folder-owner
    fn a_failed_hold_keeps_the_owner_when_its_folder_cannot_be_removed() -> Result<(), String> {
        let system = platform::current()?;
        let parent = folder::Folder::new();
        let directory = parent.path().join("frames");
        // A hold that is set makes the next hold fail with the error of the native library.
        system.capture_hold_new_window()?;
        let recording = Recording::new();
        let recorder = Arc::new(NativeRecorder { platform: system });
        let error = recording
            .start_new_window(recorder.clone(), &directory, PLAN, &make_blocked)
            .expect_err("a second hold was accepted");
        let kept = recording.running();
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| e.to_string())?;
        let result = (|| {
            if !error.contains("; capture directory cleanup failed: ") {
                return Err(format!("the error names no failed cleanup: {error}"));
            }
            if kept.as_deref() != Some(directory.as_path()) {
                return Err(format!(
                    "the recording kept {kept:?}, not its folder {directory:?}"
                ));
            }
            // The folder stays owned until an abort removes it; the native recording never started, so no stop runs.
            recording.abort(recorder.as_ref())?;
            if directory.exists() || recording.running().is_some() {
                return Err("the abort left the folder or the owner".into());
            }
            Ok(())
        })();
        system.capture_release_new_window();
        result
    }

    fn a_failed_hold_removes_the_folder() -> Result<(), String> {
        let system = platform::current()?;
        let parent = folder::Folder::new();
        let directory = parent.path().join("frames");
        system.capture_hold_new_window()?;
        let recording = Recording::new();
        let recorder = Arc::new(NativeRecorder { platform: system });
        let error = recording
            .start_new_window(recorder, &directory, PLAN, &make_new)
            .expect_err("a second hold was accepted");
        system.capture_release_new_window();
        if directory.exists() || recording.running().is_some() {
            return Err(format!(
                "the failed hold left the folder or the owner: {error}"
            ));
        }
        Ok(())
    }

    fn the_stop_ends_a_wait_for_a_window_that_no_show_took() -> Result<(), String> {
        let system = platform::current()?;
        let parent = folder::Folder::new();
        let directory = parent.path().join("frames");
        let recording = Recording::new();
        let recorder = Arc::new(NativeRecorder { platform: system });
        recording.start_new_window(recorder.clone(), &directory, PLAN, &make_new)?;
        if recording.running().as_deref() != Some(directory.as_path()) {
            return Err("the hold did not own its folder".into());
        }
        let error = recording
            .finish(recorder.as_ref())
            .expect_err("a hold without a window finished");
        if error != "no new window was shown before the stop of the recording" {
            return Err(format!("finish reported {error:?}"));
        }
        if recording.running().is_some() || !directory.is_dir() {
            return Err("the failed finish kept the owner or removed the folder".into());
        }
        Ok(())
    }

    pub(super) const TESTS: &[main_thread::MainTest] = &[
        (
            "a_failed_hold_keeps_the_owner_when_its_folder_cannot_be_removed",
            a_failed_hold_keeps_the_owner_when_its_folder_cannot_be_removed,
        ),
        (
            "a_failed_hold_removes_the_folder",
            a_failed_hold_removes_the_folder,
        ),
        (
            "the_stop_ends_a_wait_for_a_window_that_no_show_took",
            the_stop_ends_a_wait_for_a_window_that_no_show_took,
        ),
    ];
}

#[cfg(feature = "diagnostics")]
const TESTS: &[main_thread::MainTest] = hold::TESTS;
#[cfg(not(feature = "diagnostics"))]
const TESTS: &[main_thread::MainTest] = &[];

fn main() {
    main_thread::run(TESTS);
}
