import assert from "node:assert/strict";
import test from "node:test";

import { documentMatchesFrame, pointerAtPrecision } from "../surface-geometry.mjs";

const document = (width, height, scale) => ({ scale, viewport: { width, height }, body: { width, height } });

test("a surface document of the truncated viewport matches a half point frame at scale 2", { timeout: 1000 }, () => {
  // The hosted window run measured a 760 x 286 CSS pixel document for a 760 x 286.5 point surface at scale 2.
  assert.equal(documentMatchesFrame(document(760, 286, 2), { x: 210, y: 116, width: 760, height: 286.5 }, 2), true);
});

test("a surface document matches a whole point frame at its size", { timeout: 1000 }, () => {
  assert.equal(documentMatchesFrame(document(760, 286, 1), { x: 210, y: 116, width: 760, height: 286 }, 1), true);
});

test("a surface document of another size or scale does not match the frame", { timeout: 1000 }, () => {
  const frame = { x: 210, y: 116, width: 760, height: 286.5 };
  assert.equal(documentMatchesFrame(document(760, 287, 2), frame, 2), false);
  assert.equal(documentMatchesFrame(document(760, 285, 2), frame, 2), false);
  assert.equal(documentMatchesFrame(document(760, 286, 1), frame, 2), false);
  assert.equal(documentMatchesFrame({ ...document(760, 286, 2), body: { width: 760, height: 300 } }, frame, 2), false);
});

test("a WebKit of whole pixel pointer coordinates reports the last device pixel at its whole pixel", { timeout: 1000 }, () => {
  // The WebKit of macOS 15.7 reported 10 for a press at 10.25 points and 200 for the last device pixel of a 200.5 point surface.
  assert.equal(pointerAtPrecision({ pressed: 10.25, reported: 10 }, 200.25), 200);
});

test("a WebKit of fractional pointer coordinates reports the last device pixel at its point", { timeout: 1000 }, () => {
  assert.equal(pointerAtPrecision({ pressed: 10.25, reported: 10.25 }, 200.25), 200.25);
});

test("a press inside the surface at another coordinate is an error", { timeout: 1000 }, () => {
  assert.throws(() => pointerAtPrecision({ pressed: 10.25, reported: 11 }, 200.25),
    /a press at 10.25 points reported 11, which is neither the point nor its whole pixel/);
});
