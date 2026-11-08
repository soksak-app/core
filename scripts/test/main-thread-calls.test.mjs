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
