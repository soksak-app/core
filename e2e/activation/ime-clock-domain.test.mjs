import assert from "node:assert/strict";
import test from "node:test";

import { capturesByInputStage } from "./ime-visual-capture.mjs";

test("capture stage attribution refuses a mismatched explicit clock domain", { timeout: 2000 }, () => {
  const callback = { displayTime: "1000000000", machTimebaseNumerator: 1, machTimebaseDenominator: 1,
    imageMatch: { captureFrame: { width: 4, height: 6, stride: 16, pixelFormat: 0x42475241,
      colorSpace: "sRGB", scaleFactor: 1, screenRect: { x: 0, y: 0, width: 4, height: 6 },
      contentRect: { x: 0, y: 0, width: 4, height: 6 } } } };
  const decoded = { width: 4, height: 6, stride: 16, scale: 1, time: 1000, data: new Uint8Array(96) };
  assert.throws(() => capturesByInputStage([{ name: "frame.bgra", callback }], [decoded], [{
    key: "stage",
    clockDomain: "mach-continuous",
    startedMonotonicNs: "900000000",
    endedMonotonicNs: "1100000000",
  }]), /input stage boundaries must use the mach-absolute clock domain/);
});
