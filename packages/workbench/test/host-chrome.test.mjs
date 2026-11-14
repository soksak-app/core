// A preparation holds the title bar height, and the page reads the window button region of the preparation whose presentation it confirmed as the committed state. No call
// requests the title bar separately after drawing (docs/spec/native-surfaces.md#title-bar-height).
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";
import { drained } from "./support/drained.mjs";
import { recordsOf } from "./support/records.mjs";

// The views of the tests below are real mounts of the surface modules over their page-wire cases: a view that is authorized declares
// its composition to the host, and the host answers the declaration after the test releases it when the case holds the reply.
const emptySurfaceDeclarations = { status: [], commands: [], element: [] };
const descriptor = (id) => ({ surfaceId: id, pluginId: "probe", declarations: emptySurfaceDeclarations, sidecars: [],
  composition: { kind: "view", page: "ui/page.html" }, params: null, diagnostics: null, unload: false });

let instance = 0;
let pluginRegistered = false;
/**
 * Opens a document, sends the theme of the host and returns a new host module with the surface modules. mount(id) mounts the view id in
 * its own slot, and the surface becomes declared only after authorize(id) and the host answer of its declaration.
 */
async function openViews(t, tokens = {}) {
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
  const hostModule = await import(`../host.js?host-chrome-${++instance}`);
  const { surfaces } = hostModule;
  setSurfaceTextSize(() => 1);
  if (!pluginRegistered) {
    registerPlugin({ id: "probe", surface: () => null });
    pluginRegistered = true;
  }
  await surfaces.theme({ scheme: "dark", tokens });
  const mounted = [];
  const mount = (id) => {
    seedSourceOrigins({ floor: 1, views: { [id]: 1 } });
    recordOrigin(id, null, "test fixture");
    const slot = document.createElement("div");
    document.querySelector("#plane").append(slot);
    mounted.push(id);
    return modules.mountSurface(slot, descriptor(id));
  };
  t.after(async () => {
    for (const id of mounted) await modules.disposeSurface(id);
    dom.window.close();
  });
  return { surfaces, modules, mount, onSurfacePrepared: hostModule.onSurfacePrepared };
}

const names = (wire) => wire.calls.map(({ name }) => name);
const syncedViews = (wire) => wire.calls.filter(({ name }) => name === "syncSurfaces").map(({ payload }) => payload.surfaces.map(({ id }) => id));
const view = (id, applied = { x: 0, y: 0, w: 3, h: 4 }, extra = {}) => ({ id, dim: false, visible: true,
  surface: { module: null, pluginId: "probe", composition: { kind: "view", page: "ui/page.html" } },
  applied, start: { origin: { directory: null }, declarations: emptySurfaceDeclarations }, ...extra });

test("the preparation carries the title bar height and the presented chrome is the committed one", async () => {
  // The host replies of the case give the window button region of each preparation, which the page reads after its presentation.
  const wire = selectPageWire("host-chrome-title-bar");
  const dom = new JSDOM('<div id="plane"></div>');
  globalThis.document = dom.window.document;
  const { chrome, surfaces } = await import("../host.js");
  const calls = wire.calls;
  const record = (titlebar, drawn, viewport = { width: 800, height: 600 }) => ({
    surfaces: [{
      id: "surface", dim: false, visible: true,
      surface: { module: "surface-module", composition: { kind: "dom" } },
      applied: { x: 1, y: 2, w: 3, h: 4 },
    }],
    settled: true, drawn, titlebar, viewport,
  });
  try {
    assert.equal("titlebar" in chrome, false, "the page has no title bar request apart from the preparation");
    assert.equal(chrome.presented(), null, "no preparation has been presented");

    const prepared = await surfaces.place(record(54, false));
    assert.deepEqual(prepared.placements, [{ id: "surface", visible: true, scale: 2, x: 1, y: 2, w: 3, h: 4 }],
      "the answer keeps the scale whose device pixels the host fitted the surface to");
    assert.deepEqual(calls.map((c) => c.name), ["syncSurfaces"]);
    assert.equal(calls[0].payload.titlebar, 54, "the preparation carries the row of the next draw");
    assert.deepEqual(calls[0].payload.viewport, { width: 800, height: 600 }, "the preparation carries the viewport of its layout");
    assert.deepEqual(calls[0].payload.declarations, [], "a request without views must carry its empty declaration table");
    assert.equal(chrome.presented(), null, "a preparation is not the committed state before its presentation");

    await surfaces.place(record(54, true));
    assert.deepEqual(calls.map((c) => c.name), ["syncSurfaces", "presentSurfaces"],
      "the draw makes no request other than the presentation");
    assert.deepEqual(Object.keys(calls[1].payload).sort(), ["placements", "settled", "ticket"],
      "the presentation sends the prepared ticket and placements");
    assert.deepEqual(chrome.presented(), { controls: { x: 13, y: 20, w: 54, h: 14 }, row: 54 });

    // The preparation of the next layout does not change the committed state until its presentation is confirmed.
    await surfaces.place(record(40, false));
    assert.equal(calls.at(-1).payload.titlebar, 40);
    assert.equal(chrome.presented().row, 54, "an unpresented preparation replaced the committed chrome");
    await surfaces.place(record(40, true));
    assert.equal(chrome.presented().row, 40);

    // The same request is not sent again. When the state of the window changed without a request (a window that left full screen), the same
    // request is sent after forget.
    calls.length = 0;
    await surfaces.place(record(40, false));
    assert.deepEqual(calls, [], "an unchanged request was sent");
    // The viewport tells the host the size that the layout was made at; a layout at another size that places the same is no change.
    await surfaces.place(record(40, false, { width: 900, height: 600 }));
    assert.deepEqual(calls, [], "a request that changed only its viewport was sent");
    surfaces.forget();
    await surfaces.place(record(40, false));
    await surfaces.place(record(40, true));
    assert.deepEqual(calls.map((c) => c.name), ["syncSurfaces", "presentSurfaces"],
      "a forgotten request was not sent again");
    assert.equal(calls[0].payload.titlebar, 40);
  } finally {
    dom.window.close();
  }
  wire.finish();
});

test("a release during an open preparation presents that preparation as settled without a second synchronization", { timeout: 5000 }, async () => {
  const wire = selectPageWire("host-chrome-release-open");
  const dom = new JSDOM('<div id="plane"></div>');
  globalThis.document = dom.window.document;
  const { surfaces } = await import("../host.js?release");
  const calls = wire.calls;
  const record = (drawn, settled) => ({ surfaces: [], settled, drawn, titlebar: 40 });
  try {
    await surfaces.place(record(false, false));
    await surfaces.place(record(true, true));
    assert.deepEqual(calls.map((c) => c.name), ["syncSurfaces", "presentSurfaces"],
      "the settled value alone sent a second synchronization of an open preparation");
    assert.deepEqual([calls[1].payload.ticket, calls[1].payload.settled], [1, true],
      "the open preparation was not presented as settled");
    await surfaces.place(record(false, false));
    await surfaces.place(record(true, false));
    calls.length = 0;
    await surfaces.place(record(true, true));
    assert.deepEqual(calls.map((c) => c.name), ["syncSurfaces", "presentSurfaces"],
      "a release after the presentation of an equal placement did not end the run");
    assert.equal(calls[1].payload.settled, true);
  } finally {
    dom.window.close();
  }
  wire.finish();
});

test("a cancelled preparation sends its ticket once and the next equal request is sent again", { timeout: 5000 }, async () => {
  const wire = selectPageWire("host-chrome-cancelled");
  const dom = new JSDOM('<div id="plane"></div>');
  globalThis.document = dom.window.document;
  const { surfaces } = await import("../host.js?cancel");
  const calls = wire.calls;
  const record = (drawn) => ({ surfaces: [], settled: true, drawn, titlebar: 40 });
  try {
    await surfaces.cancelPrepared({ handover: false });
    assert.deepEqual(calls, [], "no preparation is open");
    await surfaces.place(record(false));
    await surfaces.cancelPrepared({ handover: false });
    assert.deepEqual(calls.map((c) => c.name), ["syncSurfaces", "cancelSurfaces"]);
    assert.deepEqual(calls[1].payload, { ticket: 1 });
    await surfaces.cancelPrepared({ handover: false });
    assert.equal(calls.length, 2, "a cancelled preparation is not cancelled again");
    await surfaces.place(record(false));
    await surfaces.place(record(true));
    assert.deepEqual(calls.slice(2).map((c) => c.name), ["syncSurfaces", "presentSurfaces"], "the equal request after a cancellation was not sent");
    await surfaces.cancelPrepared({ handover: false });
    assert.equal(calls.length, 4, "a presented preparation is not cancelled");
  } finally {
    dom.window.close();
  }
  wire.finish();
});

// A handed-over preparation stays open for the next preparation of the window, which places every surface again and commits
// both with its own presentation (F484). Every exit ends it: a failed next preparation and a cancel without a handover cancel it.
test("a handed-over preparation sends no cancel and only a failed or cancelled next preparation ends it", { timeout: 5000 }, async () => {
  const wire = selectPageWire("host-chrome-handover");
  const dom = new JSDOM('<div id="plane"></div>');
  globalThis.document = dom.window.document;
  const { surfaces } = await import("../host.js?handover");
  const calls = wire.calls;
  const record = (drawn, titlebar = 40) => ({ surfaces: [], settled: true, drawn, titlebar });
  const names = () => calls.map((c) => c.name);
  try {
    await surfaces.place(record(false));
    await surfaces.cancelPrepared({ handover: true });
    assert.deepEqual(names(), ["syncSurfaces"], "a handed-over preparation was cancelled and committed");
    await surfaces.place(record(false));
    await surfaces.place(record(true));
    await surfaces.cancelPrepared({ handover: false });
    assert.deepEqual(names(), ["syncSurfaces", "syncSurfaces", "presentSurfaces"],
      "the next preparation did not take over the handed-over preparation");

    calls.length = 0;
    await surfaces.place(record(false, 41));
    await surfaces.cancelPrepared({ handover: true });
    await assert.rejects(surfaces.place(record(false, 99)), /preparation refused/);
    assert.deepEqual(names(), ["syncSurfaces", "syncSurfaces", "cancelSurfaces"], "a failed next preparation left the handed-over one open");
    assert.deepEqual(calls[2].payload, { ticket: 3 });
    await surfaces.cancelPrepared({ handover: false });
    assert.equal(calls.length, 3, "the cancel after a failed preparation sent a call or found an open preparation");

    calls.length = 0;
    await surfaces.place(record(false, 42));
    await surfaces.cancelPrepared({ handover: true });
    await surfaces.cancelPrepared({ handover: false });
    assert.deepEqual(names(), ["syncSurfaces", "cancelSurfaces"], "a cancel without a handover left the handed-over preparation open");
    assert.deepEqual(calls[1].payload, { ticket: 4 });
  } finally {
    dom.window.close();
  }
  wire.finish();
});

test("a view surface carries its start values in the preparation and a surface without them carries none", async (t) => {
  const wire = selectPageWire("host-chrome-start-values");
  const { surfaces, modules, mount } = await openViews(t, { "--bg": "#000" });
  mount("view");
  modules.authorizeSurface("view");
  await modules.waitSurfaceCompositionDeclared("view");
  const values = {
    params: { path: "a.md" },
    origin: { directory: "/work/one" },
    project: { root: "/work/one" },
    declarations: { commands: [] },
  };
  const record = {
    surfaces: [
      { id: "view", dim: false, visible: true,
        surface: { module: null, pluginId: "probe", composition: { kind: "view", page: "ui/page.html" },
          params: { path: "a.md" }, declarations: { commands: [] } },
        applied: { x: 0, y: 0, w: 3, h: 4 }, start: values },
      { id: "dom", dim: false, visible: true,
        surface: { module: "surface-module", pluginId: "other", composition: { kind: "dom" } },
        applied: { x: 0, y: 4, w: 3, h: 4 } },
    ],
    settled: true, drawn: false, titlebar: 40,
  };
  await surfaces.place(record);
  const request = wire.calls.find(({ name }) => name === "syncSurfaces").payload;
  assert.equal(request.surfaces[0].start.declarations, 0);
  assert.deepEqual(request.declarations, [values.declarations]);
  assert.deepEqual({ params: request.surfaces[0].start.params,
    origin: request.surfaces[0].start.origin, project: request.surfaces[0].start.project },
  { params: values.params, origin: values.origin, project: values.project });
  assert.equal("start" in request.surfaces[1], false);
  wire.finish();
});

// A declaration in flight is a host call that the host answers in its own step, so a placement waits for that answer and sends
// the view (docs/spec/native-surfaces.md#view-surfaces, placement).
test("native view placement waits for the answer of a composition declaration in flight", async (t) => {
  const wire = selectPageWire("host-chrome-declaration-in-flight");
  const { surfaces, modules, mount } = await openViews(t);
  mount("view-ready-barrier");
  modules.authorizeSurface("view-ready-barrier");
  await drained();
  assert.deepEqual(names(wire), ["setTheme", "compositionDeclare"], "the view did not send its declaration");
  const placement = surfaces.place({ surfaces: [view("view-ready-barrier")], settled: true, drawn: false, titlebar: 40 });
  await drained();
  assert.equal(names(wire).includes("syncSurfaces"), false,
    "native view placement began before the host answered the declaration in flight");
  wire.release();
  assert.deepEqual(await placement, { placements: [{ id: "view-ready-barrier", visible: true, scale: 2, x: 0, y: 0, w: 3, h: 4 }], deferred: [] });
  assert.deepEqual(syncedViews(wire), [["view-ready-barrier"]], "the placement did not send the view after its declaration answered");
  wire.finish();
});

// A surface disposed before its declaration was answered leaves no declaration in the host: the placement defers that view and sends
// the rest of the window (docs/spec/native-surfaces.md#view-surfaces, placement).
test("native view placement defers a view whose surface was disposed before its declaration answered", async (t) => {
  const wire = selectPageWire("host-chrome-declaration-disposed");
  const { surfaces, modules, mount } = await openViews(t);
  const mounting = mount("view-disposed");
  modules.authorizeSurface("view-disposed");
  await drained();
  assert.deepEqual(names(wire), ["setTheme", "compositionDeclare"], "the view did not send its declaration");
  const placement = surfaces.place({ surfaces: [view("view-disposed")], settled: true, drawn: true, titlebar: 40 });
  await drained();
  const disposing = modules.disposeSurface("view-disposed");
  wire.release();
  await mounting.catch(() => {});
  await disposing;
  assert.deepEqual(await placement, { placements: [], deferred: ["view-disposed"] },
    "the placement did not defer the view whose surface was disposed");
  assert.deepEqual(syncedViews(wire), [[]], "the placement sent a view that has no declaration");
  assert.equal(surfaces.waitsForDeclaration("view-disposed"), true);
  wire.finish();
});

// A preparation defers a view that has no mount yet; the drawn commit follows the plane draw that mounts it, and a declaration
// that is in flight then is answered before the commit sends the view (docs/spec/native-surfaces.md#view-surfaces).
test("an initial placement defers an unmounted view until its drawn commit", async (t) => {
  const wire = selectPageWire("host-chrome-unmounted-view");
  const { surfaces, modules, mount } = await openViews(t);
  const record = (drawn) => ({ surfaces: [view("view-mount-order", { x: 1, y: 2, w: 30, h: 40 })], settled: true, drawn, titlebar: 40 });
  const first = await surfaces.place(record(false));
  assert.deepEqual(first, { placements: [], deferred: ["view-mount-order"] },
    "the unmounted view must be explicitly deferred without a fabricated placement");
  assert.deepEqual(wire.calls.find(({ name }) => name === "syncSurfaces").payload.surfaces, [],
    "the host declaration fence must not receive an unmounted view");
  assert.equal(names(wire).includes("compositionDeclare"), false,
    "pre-draw placement waited for a replacement mount that drawing has not started");

  // The plane draw mounts the view, whose declaration is in flight when the drawn commit starts.
  mount("view-mount-order");
  modules.authorizeSurface("view-mount-order");
  await drained();
  assert.deepEqual(names(wire), ["setTheme", "syncSurfaces", "compositionDeclare"], "the mounted view did not declare after the first reply");
  const secondPending = surfaces.place(record(true));
  await drained();
  assert.equal(wire.calls.filter(({ name }) => name === "syncSurfaces").length, 1,
    "the drawn view was sent while its declaration was in flight");
  wire.release();
  const second = await secondPending;
  assert.deepEqual(second, {
    placements: [{ id: "view-mount-order", visible: true, scale: 2, x: 1, y: 2, w: 30, h: 40 }], deferred: [],
  });
  assert.deepEqual(syncedViews(wire).at(-1), ["view-mount-order"], "the declared view was not sent after mount registration");
  assert.deepEqual(names(wire), ["setTheme", "syncSurfaces", "compositionDeclare", "syncSurfaces", "presentSurfaces"]);
  wire.finish();
});

// A preparation authorizes its surfaces through the prepared listeners only after it completes, and a listener added later receives the
// current preparation. The drawn commit presents each prepared ticket once with the visibility of its preparation. A rejected
// preparation or presentation is the failure of the placing caller, which reports it, and is not reused for the next request at the
// same geometry.
test("a view preparation notifies its prepared listeners, presents each ticket once, and a rejected stage is not reused", async (t) => {
  const wire = selectPageWire("host-chrome-presentation");
  const { surfaces, modules, mount, onSurfacePrepared } = await openViews(t);
  for (const id of ["shown", "hidden"]) {
    mount(id);
    modules.authorizeSurface(id);
    await modules.waitSurfaceCompositionDeclared(id);
  }
  const record = { surfaces: [view("shown"), { ...view("hidden"), visible: false }], settled: false, drawn: false, titlebar: 40 };
  const calls = wire.calls;
  const placing = () => calls.filter(({ name }) => name === "syncSurfaces" || name === "presentSurfaces");
  const prepared = [];
  const removePrepared = onSurfacePrepared((placements) => prepared.push(placements.map(({ id }) => id)));
  try {
    const preparation = await surfaces.place(record);
    assert.deepEqual(preparation.placements.map(({ id, visible }) => [id, visible]), [["shown", true], ["hidden", false]],
      "the preparation did not keep the visibility that the host placed");
    assert.deepEqual(placing().map(({ name }) => name), ["syncSurfaces"]);
    assert.deepEqual(prepared, [["shown", "hidden"]], "the prepared listeners were not told after the preparation completed");
    const latePrepared = [];
    const removeLatePrepared = onSurfacePrepared((placements) => latePrepared.push(placements.map(({ id }) => id)));
    assert.deepEqual(latePrepared, [["shown", "hidden"]], "a listener added after the preparation did not receive it");
    removeLatePrepared();
    await surfaces.place({ ...record, drawn: true });
    await surfaces.place({ ...record, drawn: true });
    assert.deepEqual(placing().map(({ name }) => name), ["syncSurfaces", "presentSurfaces"], "a prepared ticket was presented twice");
    const presented = placing()[1].payload;
    assert.equal(presented.ticket, 1);
    assert.deepEqual(presented.placements.map(({ id, visible }) => [id, visible]), [["shown", true], ["hidden", false]],
      "the presentation did not keep the visibility of its preparation");
    for (const stage of ["syncSurfaces", "presentSurfaces"]) {
      calls.length = 0;
      const changed = { ...record, settled: stage === "syncSurfaces" };
      if (stage === "syncSurfaces") {
        await assert.rejects(surfaces.place(changed), /surface "shown" changed its composition declaration/);
      } else {
        await surfaces.place(changed);
        await assert.rejects(surfaces.place({ ...changed, drawn: true }), /surface "shown" closed before presentation/);
      }
      // The page log that host.js loaded relays the records of the turn; a record of the rejection would be among them.
      await (await import("../page-log.js")).flushEvents();
      assert.deepEqual(calls.flatMap((call) => recordsOf(call.name, call.payload)), [],
        `the ${stage} rejection that the placing caller received was written again`);
      calls.length = 0;
      await surfaces.place(changed);
      await surfaces.place({ ...changed, drawn: true });
      assert.deepEqual(placing().map(({ name }) => name), ["syncSurfaces", "presentSurfaces"],
        `the ${stage} rejection was reused for the next request at the same geometry`);
    }
  } finally {
    removePrepared();
  }
  wire.finish();
});
