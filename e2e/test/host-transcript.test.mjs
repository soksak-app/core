import assert from "node:assert/strict";
import test from "node:test";

import { atRest, restingFrames, settled, settledFrames, settledX } from "../host-transcript.mjs";

const surface = (id, y, w, h, start) => ({
  id, dim: false, plugin: "layoutprobe", composition: { kind: "view", page: "ui/page.html", overlays: [] }, visible: true,
  x: 210, y, w, h, ...(start ? { start } : {}),
});

const sync = (settled, w, { start, declarations = [] } = {}) =>
  `info workbench workbench: host syncSurfaces ${JSON.stringify({
    settled, overlays: [], surfaces: [surface("tab-a", 116, w, 286.5, start), surface("tab-b", 470.5, w, 259.5)], titlebar: 40, declarations,
  })} -> {}`;

const present = (ticket, settled, w) => {
  const placements = [{ id: "tab-a", x: 210, y: 116, w, h: 286.5, visible: true }, { id: "tab-b", x: 210, y: 470.5, w, h: 259.5, visible: true }];
  return `info workbench workbench: host presentSurfaces ${JSON.stringify({ ticket, placements, settled })} -> ${JSON.stringify(placements)}`;
};

test("a release that presents the open preparation as settled settles at that preparation", () => {
  // The pointer release came after the preparation of the last layout, so the page presented that preparation as settled and sent
  // no second synchronization (docs/spec/native-surfaces.md).
  const lines = [sync(false, 680), present(1, false, 680), sync(false, 760), present(2, true, 760)];
  const rest = atRest(lines);
  assert.ok(rest, "the transcript has a settled layout");
  const request = JSON.parse(rest.request);
  assert.equal(request.settled, true);
  assert.deepEqual(request.surfaces.map(({ w }) => w), [760, 760]);
  assert.deepEqual(settledFrames(lines), [
    { x: 210, y: 116, width: 760, height: 286.5 }, { x: 210, y: 470.5, width: 760, height: 259.5 },
  ]);
  assert.deepEqual(settledX(lines), [210]);
});

test("a preparation that is not presented as settled leaves no settled layout", () => {
  assert.equal(atRest([sync(true, 760)]), undefined);
  assert.equal(atRest([sync(false, 760), present(1, false, 760)]), undefined);
  assert.equal(settledFrames([sync(true, 760)]), undefined);
});

test("the start values that a settled preparation carries are not part of its layout", () => {
  // A view sends its start values with the first preparation after they changed, which may be the settled one or an earlier one.
  const start = { params: null, origin: { directory: null }, declarations: 0, diagnostics: null, section: null };
  const carried = atRest([sync(true, 560, { start, declarations: [{}] }), present(1, true, 560)]);
  const earlier = atRest([sync(false, 760, { start, declarations: [{}] }), present(1, false, 760), sync(true, 560), present(2, true, 560)]);
  assert.equal(carried.request, earlier.request);
  assert.equal(carried.answer, earlier.answer);
});

test("a layout rests at the last settled presentation that no preparation follows", () => {
  const frames = [{ x: 210, y: 116, width: 760, height: 286.5 }, { x: 210, y: 470.5, width: 760, height: 259.5 }];
  const rested = [sync(false, 760), present(1, true, 760)];
  assert.deepEqual(restingFrames(rested), frames);
  // A preparation after the settled presentation moves the layout on, settled or not.
  assert.equal(restingFrames([...rested, sync(false, 720)]), undefined);
  assert.equal(restingFrames([...rested, sync(true, 760)]), undefined);
  assert.deepEqual(restingFrames([...rested, sync(true, 760), present(2, true, 760)]), frames);
});

test("a transcript has settled once the page presented a preparation as settled", () => {
  assert.equal(settled([sync(true, 760)]), false);
  assert.equal(settled([sync(false, 760), present(1, false, 760)]), false);
  assert.equal(settled([sync(false, 760), present(1, true, 760)]), true);
});
