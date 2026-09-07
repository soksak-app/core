import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

test("a layout published before drawing waits for the host's placement answer", async () => {
  const dom = new JSDOM(`<div id="plane"><div data-card-id="card">
    <div data-native-surface data-native-surface-id="surface" data-native-plugin="probe" data-native-layer="0"></div>
  </div></div>`, { url: "https://example.test/" });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.location = dom.window.location;
  const card = document.querySelector("[data-card-id]");
  const slot = document.querySelector("[data-native-surface]");
  card.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 150 });
  slot.getBoundingClientRect = () => ({ left: 2, top: 30, width: 196, height: 100 });
  const { registerPlugin } = await import("../browser/plugins/registry.js");
  registerPlugin({ id: "probe", surface: () => ({ page: "probe.html" }) });
  const { onCommit, publishAhead } = await import("../browser/compositor.js");
  let answer, prepared;
  onCommit((record) => new Promise((resolve) => {
    prepared = record;
    answer = () => resolve(record.surfaces.map((surface) => ({ id: surface.id, ...surface.applied })));
  }));

  const pending = publishAhead(new Map([["card", { x: 20, y: 0, w: 180, h: 150 }]]),
    new Map([["card", { id: "surface", dim: false }]]));
  assert.equal(typeof pending?.then, "function", "the caller needs the host's promise before it draws");
  let drawn = false;
  pending.then(() => { drawn = true; });
  await Promise.resolve();
  assert.equal(drawn, false, "the DOM must wait while the native placement is outstanding");
  answer();
  assert.deepEqual(await pending, [{ id: "surface", x: 22, y: 30, w: 176, h: 100 }]);
  assert.equal(drawn, true);

  const replacement = publishAhead(new Map([["card", { x: 20, y: 0, w: 180, h: 150 }]]),
    new Map([["card", { id: "replacement", dim: false }]]));
  assert.equal(typeof replacement?.then, "function", "replacing content must prepare the existing native view before drawing");
  assert.equal(prepared.surfaces[0].visible, false, "content with no matching future slot must be hidden before its card changes");
  answer();
  await replacement;
  dom.window.close();
});
