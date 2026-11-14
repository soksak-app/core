//! The close of a window ends the layout transactions of the window while the framework still holds the window
//! (docs/spec/native-surfaces.md#layout-transaction). The tests run on the real platform: a real window, its layout transactions and
//! the main queue of the UI works. The native layout runs only on the main thread, so this target runs its tests on the main thread of
//! its process (`harness = false`). The same case runs in the Go host.

#[path = "support/main_thread.rs"]
mod main_thread;

#[path = "support/platform/darwin/window_close_layout.rs"]
mod system;

fn main() {
    system::main();
}
