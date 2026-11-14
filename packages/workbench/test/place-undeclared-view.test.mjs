import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";
import { drained } from "./support/drained.mjs";

// No placement waits for the composition declaration of a view (docs/spec/native-surfaces.md#view-surfaces, placement). A placement
// keeps a view that has not declared out of its request and defers it, so only its place stays empty: the other surfaces of the
// window are placed and the next layout runs. A declaration in flight is a host call that the host answers in its own step, so a
// placement that starts during it waits for that answer and places the view.
//
// The host calls of each test are answered by its page-wire case (docs/spec/cases/page-wire/README.md). A test selects its case before
// it imports a module that imports host.js, because host.js reads the host when it is imported. The views are real mounts of the
// surface modules: a view that is authorized declares its composition to the host, and a view that is not authorized has not declared.
const descriptor = (id) => ({ surfaceId: id, pluginId: "probe", declarations: { status: [], commands: [], element: [] }, sidecars: [],
  composition: { kind: "view", page: "ui/page.html" }, params: null, diagnostics: null, unload: false });
const view = (id, x = 0) => ({ id, plugin: "probe", dim: false, visible: true, surface: descriptor(id), applied: { x, y: 0, w: 3, h: 4 } });
const record = (...views) => ({ surfaces: views, settled: true, drawn: true, titlebar: 40 });
const names = (wire) => wire.calls.map(({ name }) => name);
const syncedViews = (wire) => wire.calls.filter(({ name }) => name === "syncSurfaces").map(({ payload }) => payload.surfaces.map(({ id }) => id));

let instance = 0;
let pluginRegistered = false;
// Mounts the views of ids in their own slots and returns the placement interface of a new host module, after the host theme.
async function start(t, ids) {
  const dom = new JSDOM('<div id="plane"></div>', { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  const { registerPlugin } = await import("../registry.js");
  const { seedSourceOrigins } = await import("../source-origins.js");
  const { recordOrigin } = await import("../tab-reports.js");
  const { setSurfaceTextSize } = await import("../text-size.js");
  const modules = await import("../surface-modules.js");
  const { surfaces } = await import(`../host.js?place-undeclared-${++instance}`);
  setSurfaceTextSize(() => 1);
  if (!pluginRegistered) {
    registerPlugin({ id: "probe", surface: () => null });
    pluginRegistered = true;
  }
  seedSourceOrigins({ floor: 1, views: Object.fromEntries(ids.map((id) => [id, 1])) });
  await surfaces.theme({ scheme: "dark", tokens: {} });
  for (const id of ids) {
    recordOrigin(id, null, "test fixture");
    const slot = document.createElement("div");
    document.querySelector("#plane").append(slot);
    modules.mountSurface(slot, descriptor(id));
  }
  t.after(async () => {
    for (const id of ids) await modules.disposeSurface(id);
    dom.window.close();
  });
  return { surfaces, modules };
}

test("a view that does not declare leaves its place empty and the other views and the next layout are placed", async (t) => {
  const wire = selectPageWire("place-undeclared-view-silent");
  const { surfaces, modules } = await start(t, ["declared-view", "silent-view"]);
  // The host authorizes the view that declares; the view that has not declared stays unauthorized.
  modules.authorizeSurface("declared-view");
  await modules.waitSurfaceCompositionDeclared("declared-view");
  const first = await surfaces.place(record(view("declared-view"), view("silent-view", 5)));
  assert.deepEqual(syncedViews(wire), [["declared-view"]], "the placement sent the view that has not declared or waited for its declaration");
  assert.deepEqual(first.placements.map(({ id }) => id), ["declared-view"]);
  assert.deepEqual(first.deferred, ["silent-view"], "the placement did not defer the view that has not declared");
  assert.equal(surfaces.waitsForDeclaration("silent-view"), true, "the page is not told to lay out again at the declaration");
  assert.equal(surfaces.waitsForDeclaration("declared-view"), false);

  const next = await surfaces.place(record(view("declared-view", 1), view("silent-view", 6)));
  assert.deepEqual(syncedViews(wire), [["declared-view"], ["declared-view"]], "the next layout did not reach the host");
  assert.deepEqual(next.deferred, ["silent-view"]);

  // The host authorizes the view that has not declared, which then declares its composition.
  modules.authorizeSurface("silent-view");
  await modules.waitSurfaceCompositionDeclared("silent-view");
  const declared = await surfaces.place(record(view("declared-view", 1), view("silent-view", 6)));
  assert.deepEqual(syncedViews(wire).at(-1), ["declared-view", "silent-view"], "the layout after the declaration did not place the view");
  assert.deepEqual(declared.deferred, []);
  assert.equal(surfaces.waitsForDeclaration("silent-view"), false);
  wire.finish();
});

test("a declaration that starts while the place that leaves the view out runs waits for the reply of that place", async (t) => {
  // The host holds the reply of the placement: a place that leaves a view out removes the view and its declaration in the host, so the
  // declaration of that view is sent only after the reply (docs/spec/native-surfaces.md#view-surfaces).
  const wire = selectPageWire("place-undeclared-view-hold");
  const { surfaces, modules } = await start(t, ["declared-view", "silent-view"]);
  modules.authorizeSurface("declared-view");
  await modules.waitSurfaceCompositionDeclared("declared-view");
  const placing = surfaces.place(record(view("declared-view"), view("silent-view", 5)));
  await drained();
  assert.deepEqual(names(wire), ["setTheme", "compositionDeclare", "syncSurfaces"], "the placement did not send its request");
  modules.authorizeSurface("silent-view");
  await drained();
  assert.deepEqual(names(wire), ["setTheme", "compositionDeclare", "syncSurfaces"],
    "the declaration of the view that the place leaves out was sent before the reply of the place");
  wire.release();
  const placed = await placing;
  assert.deepEqual(placed.deferred, ["silent-view"]);
  await modules.waitSurfaceCompositionDeclared("silent-view");
  assert.equal(names(wire).filter((name) => name === "compositionDeclare").length, 2, "the hold did not end with the placement");
  assert.deepEqual(syncedViews(wire), [["declared-view"]]);
  wire.finish();
});

test("a placement that starts while a declaration is in flight waits for its answer and places the view", async (t) => {
  // The host holds the answer of the declaration. The placement sends no host request before that answer, so the order of the calls
  // that reach the host shows whether the placement waited.
  const wire = selectPageWire("place-undeclared-view-declaring");
  const { surfaces, modules } = await start(t, ["declaring-view"]);
  modules.authorizeSurface("declaring-view");
  await drained();
  assert.deepEqual(names(wire), ["setTheme", "compositionDeclare"], "the view did not send its declaration");
  const placing = surfaces.place(record(view("declaring-view")));
  await drained();
  assert.deepEqual(names(wire), ["setTheme", "compositionDeclare"], "the placement sent its request before the declaration answered");
  wire.release();
  const placed = await placing;
  assert.deepEqual(names(wire), ["setTheme", "compositionDeclare", "syncSurfaces", "presentSurfaces"],
    "the placement sent its request before the declaration answered");
  assert.deepEqual(syncedViews(wire), [["declaring-view"]]);
  assert.deepEqual(placed.deferred, []);
  assert.equal(surfaces.waitsForDeclaration("declaring-view"), false, "the placement held a declaration that was already in flight");
  wire.finish();
});
