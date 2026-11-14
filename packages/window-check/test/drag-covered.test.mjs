import assert from "node:assert/strict";
import test from "node:test";
import { drag, holdCovered, Session } from "../app.mjs";
import { playSession } from "../fixtures/endpoint-player.mjs";

// A covered window draws its image regions only while the check asks for it (docs/spec/native-surfaces.md#image-regions),
// and the drag measures the page and the regions of that window, so the drag asks for it around the gesture and does not
// refuse a covered window. The host emulates the drag inside the application, so the drag does not refuse an active window either,
// and it reads no state of the window: the requests of a drag are the same whatever the window shows. Each case holds the requests
// that the player expects in their order, and the player fails a request that the case does not hold.
const plan = { axis: "x", line: 0, dx: 10, dy: 0, ms: 100, times: 1 };

test("a drag of a covered window draws its regions during the gesture and ends the drawing after it", { timeout: 5000 }, async (t) => {
  const { session } = await playSession(t, Session, "window-check-drag-covered", "wailsv3");
  await drag(session, plan);
});

test("a drag that fails still ends the drawing of the covered window", { timeout: 5000 }, async (t) => {
  const { session } = await playSession(t, Session, "window-check-drag-fails", "wailsv3");
  const failure = await drag(session, plan).then(() => null, (error) => error.message);
  assert.equal(failure, "wailsv3 diagnostics.drag: drag failed", "the drag of a covered window failed for another reason than the drag");
});

test("a drag of an active window is measured", { timeout: 5000 }, async (t) => {
  const { session } = await playSession(t, Session, "window-check-drag-covered", "wailsv3");
  const result = await drag(session, plan);
  assert.equal(result.took, 100);
});

// The covered drawing is one state of the window (diagnostics.window.draw-covered), so the holds of a check and of a drag share it:
// a drag inside the drawing that a check holds for its whole run leaves that drawing on, and only the last release ends it.
test("a drag inside a held covered drawing leaves the drawing on", { timeout: 5000 }, async (t) => {
  const { session } = await playSession(t, Session, "window-check-drag-covered-held", "wailsv3");
  const release = await holdCovered(session);
  await drag(session, plan);
  await drag(session, plan);
  await release();
  // A second release of one hold ends nothing again: the case holds one end of the drawing.
  await release();
});
