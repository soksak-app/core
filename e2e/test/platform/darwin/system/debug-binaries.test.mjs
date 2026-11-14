// The window-check selector answers the debug executables of the macOS application bundles, the platform that the window checks run on
// (docs/spec/host-contract.md). This file runs only in the macOS system tier, which Makefile excludes from the headless run.
import assert from "node:assert/strict";
import test from "node:test";
import { debugBinaries } from "../../../../platform/platform.js";

test("the window-check selector answers the debug executables of the macOS application bundles", async () => {
  assert.deepEqual(await debugBinaries("/work/target"), {
    SOKSAK_BINARY_WAILSV3: "/work/target/debug/sok-wailsv3.app/Contents/MacOS/sok-wailsv3",
    SOKSAK_BINARY_TAURIV2: "/work/target/debug/sok-tauriv2.app/Contents/MacOS/sok-tauriv2",
    SOKSAK_BINARY_MYGO: "/work/target/debug/sok-mygo.app/Contents/MacOS/sok-mygo",
  });
});
