import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { JSDOM } from "jsdom";

test("native surface synchronization includes the active app-DOM menu bounds", async () => {
  const dom = new JSDOM('<div id="plane"></div><div id="menu" data-native-modal="menu" aria-label="Menu"></div>');
  globalThis.document = dom.window.document;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.innerWidth = 800;
  globalThis.innerHeight = 600;
  const calls = [];
  mock.module("@soksak/runtime", { namedExports: { host: {
    on: () => {}, page: (path) => path,
    call: async (name, request) => { calls.push({ name, request }); return name === "syncSurfaces" ? { placements: [], chrome: { controls: { x: 13, y: 13, w: 54, h: 14 }, row: 40 } } : request?.placements ?? []; },
  } } });
  const { overlay, surfaces } = await import("../host.js");
  const menu = document.getElementById("menu");
  menu.getBoundingClientRect = () => ({ left: 12.5, top: 24.25, width: 160.5, height: 90.75 });
  overlay.show(menu, { x: 12.5, y: 24.25, w: 160.5, h: 90.75 }, () => {});
  await surfaces.place({ surfaces: [], settled: true, drawn: false });
  const sync = calls.find(({ name }) => name === "syncSurfaces");
  assert.deepEqual(sync.request.overlays, [{ x: 12.5, y: 24.25, w: 160.5, h: 90.75 }]);
  overlay.hide();
  dom.window.close();
});
