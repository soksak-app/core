import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

// A preparation keeps an unmounted view out of its host request, and the host removes a surface that a place leaves out, its
// composition declaration included (docs/spec/native-surfaces.md#view-surfaces). After a page reload the host still holds the view of
// the earlier page under the same surface id, so a declaration that the new page sends while that preparation is in flight is removed
// by it, and the next placement of the view is refused for having no declaration. The preparation holds the declaration of each view
// that it leaves out until it has its reply.
test("a preparation holds the declaration of each view it leaves out until the host replies", { timeout: 5000 }, async (t) => {
  const dom = new JSDOM('<div id="plane"></div>');
  globalThis.document = dom.window.document;
  const holds = [];
  let replySync;
  const syncReplied = new Promise((resolve) => { replySync = resolve; });
  let syncSent;
  const syncStarted = new Promise((resolve) => { syncSent = resolve; });
  t.mock.module("../page-log.js", { namedExports: {
    rawConsole: { error: () => {}, info: () => {} }, emitEvent: () => {}, eventEnabled: () => false,
    reportRecord: async () => {}, flushEvents: async () => {},
  } });
  t.mock.module("../surface-modules.js", { namedExports: {
    mountedSurface: (id) => (id === "mounted-view" ? { surfaceId: id, disposed: false } : null),
    compositionState: () => ({ state: "declared" }),
    holdCompositionDeclarations: (ids, place) => {
      const hold = { ids: [...ids], ended: false };
      place.then(() => { hold.ended = true; }, () => { hold.ended = true; });
      holds.push(hold);
    },
  } });
  t.mock.module("@soksak/runtime", { namedExports: { windows: {}, host: {
    on: () => {},
    page: (path) => path,
    call: (name, request) => {
      if (name === "setTheme") return Promise.resolve(null);
      if (name === "syncSurfaces") {
        syncSent(request);
        return syncReplied.then(() => ({ ticket: 1, placements: [], chrome: { controls: { x: 13, y: 13, w: 54, h: 14 }, row: request.titlebar } }));
      }
      if (name === "presentSurfaces") return Promise.resolve(request.placements);
      throw new Error(`unexpected host call ${name}`);
    },
  } } });
  const { surfaces } = await import("../host.js?place-declaration-hold");
  const view = (id) => ({ id, plugin: "probe", dim: false, visible: true,
    surface: { pluginId: "probe", composition: { kind: "view", page: "ui/page.html" } }, applied: { x: 0, y: 0, w: 3, h: 4 } });
  try {
    await surfaces.theme({ scheme: "dark", tokens: {} });
    const placing = surfaces.place({ surfaces: [view("mounted-view"), view("cold-view")], settled: true, drawn: false, titlebar: 40 });
    const request = await syncStarted;
    assert.deepEqual(request.surfaces.map(({ id }) => id), ["mounted-view"], "the preparation sent an unmounted view");
    assert.deepEqual(holds.map(({ ids }) => ids), [["cold-view"]], "the preparation did not hold the declaration of the view it left out");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(holds[0].ended, false, "the hold ended before the host replied to the preparation");
    replySync();
    await placing;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(holds[0].ended, true, "the hold did not end with the reply of the preparation");
  } finally {
    replySync();
    dom.window.close();
  }
});
