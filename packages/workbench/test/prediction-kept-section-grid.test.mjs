// The prediction of a layout names the device pixel grid of that layout for each of its surfaces, the kept sections of a hidden window
// sidebar as well (docs/spec/native-surfaces.md, docs/spec/plugins.md#sections).
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

test("a prediction names the grid of its layout for a kept section of a hidden window sidebar", async () => {
  const dom = new JSDOM(`<div id="plane"><div data-card-id="card">
    <div data-native-surface data-native-surface-id="surface" data-native-plugin="probe" data-native-layer="0"></div>
  </div><div class="kept" hidden>
    <div data-native-surface data-native-surface-id="kept" data-native-plugin="probe" data-native-layer="0"></div>
  </div></div>`, { url: "https://example.test/", pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.location = dom.window.location;
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  const card = document.querySelector("[data-card-id]");
  const [slot, kept] = document.querySelectorAll("[data-native-surface]");
  card.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 150 });
  slot.getBoundingClientRect = () => ({ left: 2, top: 30, width: 196, height: 100 });
  const { registerPlugin } = await import("../registry.js");
  registerPlugin({ id: "probe", surface: () => ({ module: "probe.js", composition: { kind: "dom" } }) });
  const { ahead, onCommit, publishAhead, setSlotSurface } = await import("../compositor.js?kept-section-grid");
  setSlotSurface(slot, { surfaceId: "surface", pluginId: "probe", composition: { kind: "dom" } });
  setSlotSurface(kept, { surfaceId: "kept", pluginId: "probe", composition: { kind: "dom" } });
  let answer;
  onCommit((record) => new Promise((resolve) => {
    answer = () => resolve({ placements: record.surfaces.map((surface) => ({ id: surface.id, ...surface.applied })), deferred: [] });
  }));

  const pending = publishAhead(new Map([["card", { x: 20, y: 0, w: 180, h: 150 }]]),
    new Map([["card", { id: "surface", dim: false, inset: { left: 2, top: 30, width: 4, height: 50 }, grid: 2 }]]));
  // The prediction holds the card surface and the hidden kept section, so verify V7c judges both on the grid of the layout.
  const prediction = ahead();
  assert.ok(prediction, "a layout whose card surfaces were all measured is a prediction");
  assert.deepEqual(prediction.surfaces.map((surface) => [surface.id, surface.visible, surface.grid]),
    [["surface", true, 2], ["kept", false, 2]], "a surface of the prediction does not carry the grid of its layout");
  answer();
  await pending;

  // A layout without a card seat names no grid, so a record that holds only kept sections is no prediction.
  card.remove();
  const bare = publishAhead(new Map(), new Map());
  assert.equal(ahead(), null, "a record without the grid of its layout is published as a prediction");
  answer();
  await bare;
  dom.window.close();
});
