//! The binary store of the view of a surface (docs/spec/native-surfaces.md#view-surfaces): the take and the put of a binary id, and
//! the clipboard PNG of the view calls, which travels through the store (docs/spec/plugin-processes.md#binary-path). The tests run on
//! the real platform: a real window with a main page, a real surface and a real view whose native document holds the store. The native
//! layer runs only on the main thread, so this target runs its tests on the main thread of its process (`harness = false`). The content
//! type that the store keeps is read by native/darwin/tests/document_binary_test.m; the platform interface returns only the bytes. The
//! same cases run in the Go host. The clipboard value is data, because the real clipboard is the pasteboard of the person.

#[path = "support/folder.rs"]
mod folder;

#[path = "support/main_thread.rs"]
mod main_thread;

#[path = "support/platform/darwin/view_binary.rs"]
mod system;

fn main() {
    system::main();
}
