import assert from "node:assert/strict";
import { basename } from "node:path";

// The recording contract retains every ScreenCaptureKit callback. SCFrameStatus
// is Complete=0, Idle=1, Blank=2, Suspended=3, Started=4, Stopped=5. The native
// recorder writes pixels only for Complete; the other statuses name no file.
// Classification preserves the original rows and requires a bijection between
// complete callbacks and retained files, rather than filtering malformed rows.
export function classifyCaptureCallbacks(callbacks, paths) {
  assert.ok(Array.isArray(callbacks) && Array.isArray(paths), "capture callbacks and frame files are required");
  assert.ok(callbacks.length <= 4096, "capture callback trace exceeded its declared capacity");
  const files = paths.map(path => basename(path));
  const frameNumber = name => {
    const match = typeof name === "string" && /^frame-(\d+)\.bgra$/.exec(name);
    assert.ok(match && Number.isSafeInteger(Number(match[1])) && Number(match[1]) > 0,
      `capture callback or retained frame filename is invalid: ${String(name)}`);
    return Number(match[1]);
  };
  const fileNumbers = files.map(frameNumber);
  assert.equal(new Set(fileNumbers).size, files.length, "capture retained frame numbers are duplicated");
  const complete = [], noncomplete = [];
  callbacks.forEach((callback, index) => {
    assert.ok(callback && typeof callback === "object" && !Array.isArray(callback), "capture callback row is invalid");
    assert.equal(callback.sequence, index + 1, "capture callback sequence has a gap or duplicate");
    assert.ok(Number.isInteger(callback.status) && callback.status >= 0 && callback.status <= 5,
      `capture callback status is unsupported: ${String(callback.status)}`);
    if (callback.status === 0) {
      frameNumber(callback.frame);
      assert.ok(typeof callback.displayTime === "string" && /^(0|[1-9]\d*)$/.test(callback.displayTime),
        "complete capture callback has no valid raw display time");
      complete.push(callback);
    } else {
      assert.equal(callback.frame, null, "noncomplete capture callback claims a retained frame");
      noncomplete.push(callback);
    }
  });
  assert.deepEqual(complete.map(callback => callback.frame), files,
    "complete capture callbacks and retained frame files differ in coverage or order");
  return { callbacks, complete, noncomplete };
}
