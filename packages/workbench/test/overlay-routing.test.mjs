import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";

test("native surface synchronization includes the active app-DOM menu bounds", async () => {
  // The host calls of the page are answered by the case of this test; it is selected before host.js is imported, because the page reads the host when it is imported.
  const wire = selectPageWire("overlay-routing-menu-sync");
  const dom = new JSDOM('<div id="plane"></div><div id="errorToasts"><div class="error-toast"></div></div><div id="menu" data-native-modal="menu" aria-label="Menu" style="border-top-color: rgb(7, 8, 9); background-color: rgb(10, 11, 12); border-top-left-radius: 4px"></div>');
  globalThis.document = dom.window.document;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.innerWidth = 800;
  globalThis.innerHeight = 600;
  const { overlay, orderedCallsAnswered, surfaces } = await import("../host.js");
  const menu = document.getElementById("menu");
  // JSDOM has no layout, so the rectangle of the menu is given to the element as its layout.
  menu.getBoundingClientRect = () => ({ left: 12.5, top: 24.25, width: 160.5, height: 90.75 });
  // A toast stays in the main document while a menu is shown, and the menu decides the pointer there: no toast is cut (F1147).
  document.querySelector(".error-toast").getBoundingClientRect = () => ({ left: 300, top: 520, width: 420, height: 44 });
  overlay.show(menu, { x: 12.5, y: 24.25, w: 160.5, h: 90.75 }, () => {});
  await surfaces.place({ surfaces: [], grabs: [], settled: true, drawn: false });
  const sync = wire.calls.find(({ name }) => name === "syncSurfaces");
  assert.deepEqual(sync.payload.overlays, [{ x: 12.5, y: 24.25, w: 160.5, h: 90.75, cut: false }]);
  overlay.hide();
  await orderedCallsAnswered();
  wire.finish();
  dom.window.close();
});

// The grab area of a boundary reaches over the edges of the cards beside it, and a native view at that edge would take a press, the
// cursor and the hit test from the divider, so the page gives each grab area to its own document as a window overlay
// (docs/spec/native-surfaces.md#surface-host-container). The preparation carries the grab areas of the layout that it prepares, and the
// drawn commit measures the same areas, so a drawn layout sends no second request.
test("native surface synchronization includes the grab areas of the dividers of the prepared layout", async () => {
  const wire = selectPageWire("overlay-routing-divider-grab-sync");
  const dom = new JSDOM('<div id="plane"><div class="sp-divider" role="separator"></div></div>', { pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  // JSDOM has no layout, so the plane and the divider that the draw places are given their rectangles in the page.
  document.getElementById("plane").getBoundingClientRect = () => ({ left: 10, top: 40, width: 1000, height: 600 });
  const divider = document.querySelector(".sp-divider");
  divider.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0 });
  const compositor = await import("../compositor.js?divider-grab");
  const { surfaces } = await import("../host.js");
  const records = [];
  compositor.onCommit((record) => {
    records.push(record);
    return surfaces.place(record);
  });
  const grabs = [{ x: 584, y: 0, w: 11, h: 600 }];
  const prepared = compositor.publishAhead(new Map(), new Map(), 40, grabs);
  assert.deepEqual(records[0].grabs, grabs, "the preparation carries the grab areas of the layout that it prepares");
  await prepared;
  // The draw places the divider at its grab area.
  divider.getBoundingClientRect = () => ({ left: 594, top: 40, width: 11, height: 600 });
  await compositor.publish();
  assert.deepEqual(records[1].grabs, grabs, "the drawn commit measures the grab areas of the drawn dividers");
  assert.deepEqual(wire.calls.map(({ name }) => name), ["syncSurfaces", "presentSurfaces"], "the drawn layout sent a second request");
  assert.deepEqual(wire.calls[0].payload.overlays, [{ x: 594, y: 40, w: 11, h: 600, cut: false }]);
  wire.finish();
  dom.window.close();
});

// The error toast of the main document is drawn under the container of the surface hosts, so a surface covers it (F1147). While no
// modal and no dialog surface is open, the page gives each toast to the host as a window overlay with cut true, and the host leaves
// that rectangle out of the container, so the toast is drawn above the surfaces and takes the pointer
// (docs/spec/native-surfaces.md#surface-host-container).
test("native surface synchronization cuts each error toast out of the container of the surface hosts", async () => {
  const wire = selectPageWire("overlay-routing-toast-cut-sync");
  const dom = new JSDOM('<div id="plane"></div><div id="errorToasts"><div class="error-toast"></div></div>');
  globalThis.document = dom.window.document;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  const { orderedCallsAnswered, surfaces } = await import("../host.js");
  document.getElementById("plane").getBoundingClientRect = () => ({ left: 0, top: 0, width: 1024, height: 768 });
  // JSDOM has no layout, so the toast is given its rectangle in the page.
  document.querySelector(".error-toast").getBoundingClientRect = () => ({ left: 300, top: 520, width: 420, height: 44 });
  await surfaces.place({ surfaces: [], grabs: [], settled: true, drawn: false });
  await orderedCallsAnswered();
  wire.finish();
  dom.window.close();
});
