import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { findUnownedWindows } from "../check-native-windows.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const scan = (files) => findUnownedWindows(Object.keys(files), (file) => files[file])
  .map((item) => `${item.file}:${item.line} ${item.reason}`);

test("a window whose next statement does not keep it from releasing itself on close is found", () => {
  assert.deepEqual(scan({
    "native/darwin/tests/a_test.m": "NSWindow *window = [[[NSWindow alloc]\n    initWithContentRect:r styleMask:0 backing:0 defer:NO] autorelease];\n[window close];\n",
    "native/darwin/tests/b_test.m": "NSWindow *window = [[NSWindow alloc] initWithContentRect:r styleMask:0 backing:0 defer:NO];\nnumber = window.windowNumber;\n[window setReleasedWhenClosed:NO];\n",
    "native/darwin/tests/c_test.m": "return [[NSWindow alloc] initWithContentRect:r styleMask:0 backing:0 defer:NO];\n",
  }), [
    "native/darwin/tests/a_test.m:1 the next statement does not set window.releasedWhenClosed = NO",
    "native/darwin/tests/b_test.m:1 the next statement does not set window.releasedWhenClosed = NO",
    "native/darwin/tests/c_test.m:1 the window is not assigned to a name",
  ]);
});

test("a window whose next statement sets releasedWhenClosed to NO is owned by its creator", () => {
  assert.deepEqual(scan({
    "native/darwin/tests/a_test.m": "NSWindow *window = [[[NSWindow alloc] initWithContentRect:r styleMask:0 backing:0 defer:NO] autorelease];\n[window setReleasedWhenClosed:NO];\n",
    "native/darwin/tests/b_test.m": "windows[j] = [[NSWindow alloc] initWithContentRect:r styleMask:0 backing:0 defer:NO];\nwindows[j].releasedWhenClosed = NO;\n",
    "native/darwin/tests/c_test.js": "const w = '[NSWindow alloc]';\n",
  }), []);
});

test("every NSWindow of the native package is owned by its creator", () => {
  const output = spawnSync(process.execPath, [join(ROOT, "scripts/check-native-windows.mjs")], { encoding: "utf8" });
  assert.equal(output.status, 0, output.stderr);
});
