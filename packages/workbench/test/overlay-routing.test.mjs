import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";

test("native surface synchronization includes the active app-DOM menu bounds", async () => {
  // The host calls of the page are answered by the case of this test; it is selected before host.js is imported, because the page reads the host when it is imported.
  const wire = selectPageWire("overlay-routing-menu-sync");
  const dom = new JSDOM('<div id="plane"></div><div id="menu" data-native-modal="menu" aria-label="Menu" style="border-top-color: rgb(7, 8, 9); background-color: rgb(10, 11, 12); border-top-left-radius: 4px"></div>');
  globalThis.document = dom.window.document;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.innerWidth = 800;
  globalThis.innerHeight = 600;
  const { overlay, orderedCallsAnswered, surfaces } = await import("../host.js");
  const menu = document.getElementById("menu");
  // JSDOM has no layout, so the rectangle of the menu is given to the element as its layout.
  menu.getBoundingClientRect = () => ({ left: 12.5, top: 24.25, width: 160.5, height: 90.75 });
  overlay.show(menu, { x: 12.5, y: 24.25, w: 160.5, h: 90.75 }, () => {});
  await surfaces.place({ surfaces: [], settled: true, drawn: false });
  const sync = wire.calls.find(({ name }) => name === "syncSurfaces");
  assert.deepEqual(sync.payload.overlays, [{ x: 12.5, y: 24.25, w: 160.5, h: 90.75 }]);
  overlay.hide();
  await orderedCallsAnswered();
  wire.finish();
  dom.window.close();
});
