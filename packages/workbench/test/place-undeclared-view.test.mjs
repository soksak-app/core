import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

// No placement waits for the composition declaration of a view (docs/spec/native-surfaces.md#view-surfaces, placement). A placement
// keeps a view that has not declared out of its request and defers it, so only its place stays empty: the other surfaces of the
// window are placed and the next layout runs. A declaration in flight is a host call that the host answers in its own step, so a
// placement that starts during it waits for that answer and places the view.
const view = (id, x = 0) => ({ id, plugin: "probe", dim: false, visible: true,
  surface: { pluginId: "probe", composition: { kind: "view", page: "ui/page.html" } }, applied: { x, y: 0, w: 3, h: 4 } });

async function placement(t, states, read = () => {}) {
  const dom = new JSDOM('<div id="plane"></div>');
  globalThis.document = dom.window.document;
  const holds = [];
  const syncs = [];
  t.mock.module("../page-log.js", { namedExports: {
    rawConsole: { error: () => {}, info: () => {} }, emitEvent: () => {}, eventEnabled: () => false,
    reportRecord: async () => {}, flushEvents: async () => {},
  } });
  t.mock.module("../surface-modules.js", { namedExports: {
    mountedSurface: (id) => ({ surfaceId: id, disposed: false }),
    compositionState: (id) => {
      const state = states.get(id);
      read(id, state);
      return state;
    },
    // The declaration of a view that never declares never comes: a placement that waited for it would never reach the host.
    waitSurfaceCompositionDeclared: () => new Promise(() => {}),
    holdCompositionDeclarations: (ids, place) => {
      const hold = { ids: [...ids], ended: false };
      place.then(() => { hold.ended = true; }, () => { hold.ended = true; });
      holds.push(hold);
    },
  } });
  t.mock.module("@soksak/runtime", { namedExports: { windows: {}, host: {
    on: () => {},
    page: (path) => path,
    call: async (name, request) => {
      if (name === "setTheme") return null;
      if (name === "syncSurfaces") {
        syncs.push(request.surfaces.map(({ id }) => id));
        return { ticket: syncs.length, chrome: { controls: { x: 13, y: 13, w: 54, h: 14 }, row: request.titlebar },
          placements: request.surfaces.map(({ id, x, y, w, h }) => ({ id, visible: true, scale: 2, x, y, w, h })) };
      }
      if (name === "presentSurfaces") return request.placements;
      throw new Error(`unexpected host call ${name}`);
    },
  } } });
  const { surfaces } = await import(`../host.js?place-undeclared-${Math.random()}`);
  await surfaces.theme({ scheme: "dark", tokens: {} });
  t.after(() => dom.window.close());
  return { surfaces, holds, syncs };
}

test("a view that does not declare leaves its place empty and the other views and the next layout are placed", { timeout: 5000 }, async (t) => {
  const states = new Map([["declared-view", { state: "declared" }], ["silent-view", { state: "pending" }]]);
  const { surfaces, holds, syncs } = await placement(t, states);
  const first = await surfaces.place({ surfaces: [view("declared-view"), view("silent-view", 5)], settled: true, drawn: true, titlebar: 40 });
  assert.deepEqual(syncs, [["declared-view"]], "the placement sent the view that has not declared or waited for its declaration");
  assert.deepEqual(first.placements.map(({ id }) => id), ["declared-view"]);
  assert.deepEqual(first.deferred, ["silent-view"], "the placement did not defer the view that has not declared");
  assert.deepEqual(holds.map(({ ids }) => ids), [["silent-view"]], "the placement did not hold the declaration of the view it left out");
  assert.equal(holds[0].ended, true, "the hold did not end with the placement");
  assert.equal(surfaces.waitsForDeclaration("silent-view"), true, "the page is not told to lay out again at the declaration");
  assert.equal(surfaces.waitsForDeclaration("declared-view"), false);

  const next = await surfaces.place({ surfaces: [view("declared-view", 1), view("silent-view", 6)], settled: true, drawn: true, titlebar: 40 });
  assert.deepEqual(syncs, [["declared-view"], ["declared-view"]], "the next layout did not reach the host");
  assert.deepEqual(next.deferred, ["silent-view"]);

  states.set("silent-view", { state: "declared" });
  const declared = await surfaces.place({ surfaces: [view("declared-view", 1), view("silent-view", 6)], settled: true, drawn: true, titlebar: 40 });
  assert.deepEqual(syncs.at(-1), ["declared-view", "silent-view"], "the layout after the declaration did not place the view");
  assert.deepEqual(declared.deferred, []);
  assert.equal(surfaces.waitsForDeclaration("silent-view"), false);
});

test("a placement that starts while a declaration is in flight waits for its answer and places the view", { timeout: 5000 }, async (t) => {
  let answer;
  const declaring = new Promise((resolve) => { answer = resolve; });
  const states = new Map([["declaring-view", { state: "declaring", answered: declaring }]]);
  // The declaration answers after the placement has read it in flight; the requests sent at that answer show whether it waited.
  let atAnswer = null;
  const { surfaces, holds, syncs } = await placement(t, states, (id, state) => {
    if (state.state !== "declaring" || atAnswer) return;
    atAnswer = new Promise((resolve) => setImmediate(() => {
      const sent = syncs.length;
      states.set("declaring-view", { state: "declared" });
      answer();
      resolve(sent);
    }));
  });
  const placed = await surfaces.place({ surfaces: [view("declaring-view")], settled: true, drawn: true, titlebar: 40 });
  assert.ok(atAnswer, "the placement did not read the declaration in flight");
  assert.equal(await atAnswer, 0, "the placement sent its request before the declaration answered");
  assert.deepEqual(syncs, [["declaring-view"]]);
  assert.deepEqual(placed.deferred, []);
  assert.deepEqual(holds.flatMap(({ ids }) => ids), [], "the placement held a declaration that was already in flight");
});
