// The table of the main-thread audit that needs no syntax tree; the audit of fixtures runs in
// platform/darwin/system/main-thread-calls.test.mjs, because clang parses them against the macOS SDK.
import assert from "node:assert/strict";
import test from "node:test";

test("main-thread audit names the thread-safe native functions with a reason", { timeout: 30000 }, async () => {
  const { MAIN_THREAD_FREE } = await import("../check-host-files.mjs");
  for (const [name, reason] of Object.entries(MAIN_THREAD_FREE)) {
    assert.match(name, /^(?:sp_[a-z_*]+|hostInstallMainThread|hostMainThreadInstalled)$/, name);
    assert.ok(reason.length > 20, `${name} has no reason`);
  }
});

// The window recording and the still capture wait for their stills; called in a step, they would hold the main thread while
// the stills complete on other queues, so the Go host calls them on the goroutine of its request, as the Tauri host calls
// them off the main thread (docs/spec/hosts.md#main-thread-of-the-wails-host).
test("the capture functions that wait for their stills need no main thread", { timeout: 30000 }, async () => {
  const { MAIN_THREAD_FREE } = await import("../check-host-files.mjs");
  const free = (name) => Object.keys(MAIN_THREAD_FREE).some((key) => (key.endsWith("*") ? name.startsWith(key.slice(0, -1)) : name === key));
  for (const name of ["sp_capture_open", "sp_capture_start", "sp_capture_stop", "sp_capture_still", "sp_capture_wait_new_window",
    "sp_capture_missed", "sp_capture_late", "sp_capture_longest_gap"]) {
    assert.ok(free(name), `${name} runs in a main-thread step`);
  }
});
