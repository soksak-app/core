// The view path of a surface over the page wire: the mount of a view, the answers of the page to its calls, its exposure registrations,
// regions and sidecar sends, and the end of its process. The host calls and the notices of each test are the page-wire case of its
// name (docs/spec/cases/page-wire/README.md): a view call reaches the page as the notice view-call, which the test plays with
// deliverNotice, and every call that the page sends to the host is compared with the case. A test selects its case before it imports a
// module that imports host.js, because host.js reads the host when it is imported.
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { host, selectPageWire } from "@soksak/runtime";
import { drained } from "./support/drained.mjs";

let wire = selectPageWire("surface-view-log-clock");
// The modules that register the listeners of the page when they are imported are imported over the first case, which records no listener.
await import("../surface-modules.js");
await import("../retained-surface-mounts.js");
const { registerPlugin } = await import("../registry.js");
const { endSourceOrigin, registerSourceOrigin, seedSourceOrigins, sourceOrigin } = await import("../source-origins.js");
const { recordOrigin } = await import("../tab-reports.js");
const { setSurfaceTextSize } = await import("../text-size.js");
const { pageIdentity } = await import("../page-identity.js");
const { logGate } = await import("../log-gate.js");
const { flushEvents, recordWorkbenchStart } = await import("../page-log.js");

setSurfaceTextSize(() => 1);

// The first batch of the events of the page reads the clock of the host (the call log with the action clock), so the page starts its
// record here, over the case that holds the clock reads; the tests then see only the batches of their own events.
const CALL_DEBUG = { lifecycle: "error", input: "error", call: "debug", io: "error", frame: "error" };
const ERRORS_ONLY = { lifecycle: "error", input: "error", call: "error", io: "error", frame: "error" };
logGate.set({ ...ERRORS_ONLY, lifecycle: "info" });
recordWorkbenchStart(new URL("http://localhost/"), performance.timeOrigin);
await flushEvents();
logGate.set(ERRORS_ONLY);
wire.finish();
wire = selectPageWire("surface-view-source-generation");

function seedViewSource(plugin, surface, generation = 1) {
  seedSourceOrigins({ floor: generation, views: { [surface]: generation } });
}

/** The document of a test, with the observers that the surface mounts read. */
function openDocument(markup = "<main><div id=slot></div></main>", url = "http://localhost/") {
  const dom = new JSDOM(markup, { url });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  return dom;
}

const declarations = { status: [], commands: [], element: [] };
/** The surface descriptor of a view. */
const viewSurface = (surfaceId, pluginId, more = {}) => ({
  module: null, surfaceId, pluginId, declarations, sidecars: [], composition: { kind: "view", page: "ui/page.html" }, ...more,
});

/** The calls of the page to the host that carry the name, with their payloads. */
const callsNamed = (name) => wire.calls.filter((call) => call.name === name);
const replies = () => callsNamed("viewReply").map(({ payload }) => payload);

/** Ends a test: the flush reports the events that the closed gate refused, and the case must have been played to its end. */
async function end() {
  await flushEvents();
  wire.finish();
}

test("a queued view call from a retired source generation does not reach the replacement command layer", { timeout: 5000 }, async () => {
  const dom = openDocument();
  const { mountSurface, authorizeSurface, disposeSurface, viewCallsIdle } = await import("../surface-modules.js?view-source-generation");
  const pluginId = "fixture-generation-plugin";
  const surfaceId = "fixture-generation-surface";
  recordOrigin(surfaceId, null, "test fixture");
  registerPlugin({ id: pluginId, surface: () => null });
  const surface = viewSurface(surfaceId, pluginId);
  try {
    authorizeSurface(surfaceId);
    // The source generation 2 is the current one, so the call of generation 1 is the retired one.
    seedViewSource(pluginId, surfaceId, 2);
    await mountSurface(document.querySelector("#slot"), surface);
    wire.deliverNotice();
    await viewCallsIdle();
    assert.deepEqual(replies(), [], "the old view call reached the replacement command layer");

    wire.deliverNotice();
    await viewCallsIdle();
    assert.deepEqual(replies(), [{ id: 2, result: {}, page: pageIdentity, generation: 2, surface: surfaceId }], "the current view call did not reply with its source identity");
    await disposeSurface(surfaceId);
    await end();
  } finally {
    dom.window.close();
  }
});

test("a view mount waits for its actual source registration before serving the first call", { timeout: 5000 }, async () => {
  wire = selectPageWire("surface-view-delayed-origin");
  const dom = openDocument();
  const { mountSurface, authorizeSurface, disposeSurface, waitSurfaceCompositionDeclared, viewCallsIdle } = await import("../surface-modules.js?view-delayed-source-origin");
  const pluginId = "fixture-view-delayed-origin";
  const surfaceId = "fixture-view-delayed-origin-surface";
  recordOrigin(surfaceId, null, "test fixture");
  registerPlugin({ id: pluginId, surface: () => null });
  const surface = viewSurface(surfaceId, pluginId);
  try {
    authorizeSurface(surfaceId);
    seedSourceOrigins({ floor: 0, views: {} });
    await mountSurface(document.querySelector("#slot"), surface);
    await waitSurfaceCompositionDeclared(surfaceId);
    assert.equal(wire.calls.some(({ name }) => name === "viewRequest"), false, "mount invented a view command generation");
    wire.deliverNotice();
    await viewCallsIdle();
    assert.deepEqual(replies(), [], "an unregistered generation was served");
    assert.equal(registerSourceOrigin(pluginId, surfaceId, 1), true, "the native source registration was not accepted");
    assert.equal(endSourceOrigin(pluginId, surfaceId, 1), true, "the source end did not retire its exact generation");
    wire.deliverNotice();

    assert.equal(registerSourceOrigin(pluginId, surfaceId, 2), true, "the replacement source registration was not accepted");
    wire.deliverNotice();
    wire.deliverNotice();
    await viewCallsIdle();
    assert.deepEqual(replies(), [{ id: 2, result: {}, page: pageIdentity, generation: 2, surface: surfaceId }], "the first current call was not served after actual registration");
    await disposeSurface(surfaceId);
    await end();
  } finally {
    dom.window.close();
  }
});

test("a retained view reads the text scale of its stored owner card", { timeout: 5000 }, async () => {
  wire = selectPageWire("surface-view-retained-text-size");
  const dom = openDocument("<main></main>");
  let liveScale = null;
  setSurfaceTextSize(() => liveScale);
  const { prepareRetainedSurface, releaseRetainedSurfaceSlots } = await import("../retained-surface-mounts.js");
  const { authorizeSurface, disposeSurface, viewCallsIdle } = await import("../surface-modules.js");
  const pluginId = "fixture-retained-text-size";
  const surfaceId = "fixture-retained-text-size-tab";
  const ownerCard = { data: { textSize: 1.25 } };
  let frameFactor = 1.5;
  const retainedTextSize = () => frameFactor * (ownerCard.data?.textSize ?? 1);
  const surface = viewSurface(surfaceId, pluginId);
  recordOrigin(surfaceId, null, "test fixture");
  registerPlugin({ id: pluginId, surface: () => null });
  seedViewSource(pluginId, surfaceId);
  const read = async (id) => {
    wire.deliverNotice();
    await viewCallsIdle();
    return replies().at(-1);
  };
  try {
    authorizeSurface(surfaceId);
    await prepareRetainedSurface({
      id: surfaceId, surface,
      retainedTextSize,
    });
    assert.deepEqual(await read(1), { id: 1, result: 1.875, page: pageIdentity, generation: 1, surface: surfaceId },
      "a cold retained view did not read frame scale multiplied by its stored owner-card scale");
    frameFactor = 2;
    ownerCard.data.textSize = 1.5;
    assert.deepEqual(await read(2), { id: 2, result: 1.875, page: pageIdentity, generation: 1, surface: surfaceId },
      "a mounted retained view changed its cached scale while it remained outside the plane");
    liveScale = 3;
    await read(3);
    liveScale = null;
    await read(4);
    assert.deepEqual(replies(), [
      { id: 1, result: 1.875, page: pageIdentity, generation: 1, surface: surfaceId },
      { id: 2, result: 1.875, page: pageIdentity, generation: 1, surface: surfaceId },
      { id: 3, result: 3, page: pageIdentity, generation: 1, surface: surfaceId },
      { id: 4, result: 3, page: pageIdentity, generation: 1, surface: surfaceId },
    ], "a retained view did not adopt the live plane scale and retain it after leaving the plane");
    await end();
  } finally {
    releaseRetainedSurfaceSlots({ surfaces: [] }, new Set());
    await disposeSurface(surfaceId);
    setSurfaceTextSize(() => 1);
    dom.window.close();
  }
});

test("a view declares its composition only after native call listeners are ready", { timeout: 5000 }, async () => {
  wire = selectPageWire("surface-view-listener-ready");
  const dom = openDocument();
  const { mountSurface, authorizeSurface, disposeSurface, waitSurfaceCompositionDeclared, viewCallsIdle } = await import("../surface-modules.js?view-listener-ready");
  const pluginId = "fixture-view-listener-ready";
  const surfaceId = "fixture-view-listener-ready-surface";
  recordOrigin(surfaceId, null, "test fixture");
  registerPlugin({ id: pluginId, surface: () => null });
  const surface = viewSurface(surfaceId, pluginId);
  let mounting;
  try {
    seedSourceOrigins({ floor: 1, views: { [surfaceId]: 1 } });
    mounting = mountSurface(document.querySelector("#slot"), surface);
    authorizeSurface(surfaceId);
    // The case holds the registrations of view-call and view-reply, as a native listener is held under load. The mount runs in
    // microtasks until it waits for them, so after the end of the microtask queue a mount that did not wait has declared its composition.
    await drained();
    assert.equal(callsNamed("compositionDeclare").length, 0,
      "composition was declared before the native view-call listener registration settled");
    wire.release();
    await drained();
    assert.equal(callsNamed("compositionDeclare").length, 0,
      "composition was declared before the native view-reply listener registration settled");
    wire.release();
    await mounting;
    await waitSurfaceCompositionDeclared(surfaceId);
    assert.equal(callsNamed("compositionDeclare").length, 1);
    // The view-call listener was ready when composition was declared: both calls of the view reach it.
    wire.deliverNotice();
    wire.deliverNotice();
    await viewCallsIdle();
    assert.deepEqual(replies(), [
      { id: 1, result: 1, page: pageIdentity, generation: 1, surface: surfaceId },
      { id: 2, result: null, page: pageIdentity, generation: 1, surface: surfaceId },
    ]);
    await disposeSurface(surfaceId);
    await end();
  } finally {
    dom.window.close();
  }
});

// A view surface has no module: the host loads its page into the view. Mounting it imports nothing and declares its view composition
// (docs/spec/plugins.md#view-surfaces), so a core command that waits for the declaration of the surface does not wait for a module.
test("mounting a view surface imports no module and declares its view composition", { timeout: 5000 }, async () => {
  wire = selectPageWire("surface-view-composition-declare");
  const dom = openDocument();
  const { mountSurface, authorizeSurface, disposeSurface, waitSurfaceCompositionDeclared } = await import("../surface-modules.js?view");
  const pluginId = "fixture-view";
  const surfaceId = "fixture-view-surface";
  recordOrigin(surfaceId, null, "test fixture");
  registerPlugin({ id: pluginId, surface: () => null });
  const composition = { kind: "view", page: "ui/page.html" };
  const surface = viewSurface(surfaceId, pluginId, { composition });
  try {
    authorizeSurface(surfaceId);
    seedViewSource(pluginId, surfaceId);
    await mountSurface(document.querySelector("#slot"), surface);
    await waitSurfaceCompositionDeclared(surfaceId);
    assert.deepEqual(callsNamed("compositionDeclare"), [{
      name: "compositionDeclare", payload: { plugin: pluginId, composition, surface: surfaceId },
    }]);
    await disposeSurface(surfaceId);
    await end();
  } finally {
    dom.window.close();
  }
});

// A view surface is ready once its composition is declared: the card leaves the loading state, as a module surface does after its module mounts.
test("a view surface reports phase ready after its view declares its composition", { timeout: 5000 }, async () => {
  wire = selectPageWire("surface-view-ready");
  const dom = openDocument();
  const { mountSurface, authorizeSurface, disposeSurface } = await import("../surface-modules.js?view-ready");
  const pluginId = "fixture-ready-view";
  const surfaceId = "fixture-ready-view-surface";
  recordOrigin(surfaceId, null, "test fixture");
  registerPlugin({ id: pluginId, surface: () => null });
  const surface = viewSurface(surfaceId, pluginId);
  const states = [];
  try {
    authorizeSurface(surfaceId);
    // The mount resolves after the composition is declared, so the last state is the state after the declaration.
    seedViewSource(pluginId, surfaceId);
    await mountSurface(document.querySelector("#slot"), surface, { onState: (state) => states.push(state) });
    assert.ok(wire.calls.some(({ name }) => name === "compositionDeclare"), "the view did not declare its composition");
    assert.equal(states.at(-1).phase, "ready", `the surface phase after its composition declaration is ${states.at(-1).phase}`);
    await disposeSurface(surfaceId);
    await end();
  } finally {
    dom.window.close();
  }
});

test("a view mount that declares its composition notifies the end of the mount without an error", { timeout: 5000 }, async () => {
  wire = selectPageWire("surface-view-mounted");
  const dom = openDocument();
  const { mountSurface, authorizeSurface, disposeSurface, onSurfaceMounted } = await import("../surface-modules.js?view-mounted");
  const pluginId = "fixture-mounted-view";
  const surfaceId = "fixture-mounted-view-surface";
  recordOrigin(surfaceId, null, "test fixture");
  registerPlugin({ id: pluginId, surface: () => null });
  const surface = viewSurface(surfaceId, pluginId);
  // The memory saver ends the restore of a tab at this notification (docs/spec/plugins.md#memory-saver).
  const ends = [];
  const removeListener = onSurfaceMounted((id, error) => ends.push({ id, error }));
  try {
    authorizeSurface(surfaceId);
    seedViewSource(pluginId, surfaceId);
    await mountSurface(document.querySelector("#slot"), surface);
    assert.deepEqual(ends, [{ id: surfaceId, error: null }], `the ends of the mount are ${JSON.stringify(ends)}`);
    await disposeSurface(surfaceId);
    await end();
  } finally {
    removeListener();
    dom.window.close();
  }
});

// core.surfaces lists a mounted view outside the compositor record from liveMounts, and each change of the mounted views notifies
// the core state, which reads core.surfaces again (docs/spec/exposure.md#plugin-processes).
test("a mounted view is listed by liveMounts until it is disposed, and each change notifies the mounted-change listeners", { timeout: 5000 }, async () => {
  wire = selectPageWire("surface-view-live-mounts");
  const dom = openDocument();
  const { mountSurface, authorizeSurface, disposeSurface, liveMounts, onMountedChange, waitSurfaceCompositionDeclared } = await import("../surface-modules.js?view-live-mounts");
  const pluginId = "fixture-live-view";
  const surfaceId = "fixture-live-view-surface";
  recordOrigin(surfaceId, null, "test fixture");
  registerPlugin({ id: pluginId, surface: () => null });
  const surface = viewSurface(surfaceId, pluginId);
  let changes = 0;
  const removeListener = onMountedChange(() => { changes += 1; });
  try {
    assert.deepEqual(liveMounts(), [], "a document with no mount lists a mounted view");
    authorizeSurface(surfaceId);
    seedViewSource(pluginId, surfaceId);
    await mountSurface(document.querySelector("#slot"), surface);
    await waitSurfaceCompositionDeclared(surfaceId);
    assert.deepEqual(liveMounts(), [{ surface: surfaceId, plugin: pluginId, descriptor: surface, status: { phase: "ready", error: null } }],
      "the mounted view is not listed with its plugin and phase");
    const before = changes;
    await disposeSurface(surfaceId);
    assert.deepEqual(liveMounts(), [], "a disposed view is still listed");
    assert.ok(changes > before, "disposing a mounted view did not notify the mounted-change listeners");
    await end();
  } finally {
    removeListener();
    dom.window.close();
  }
});

/** The events of the log batches that the page sent, in order, as {level, event, fields}. */
const loggedEvents = () => callsNamed("log").filter(({ payload }) => payload.action === "batch")
  .flatMap(({ payload }) => payload.events).map(({ level, event, fields }) => ({ level, event, fields }));

// The receipt of a view call and its reply are written at the debug level, so a call that never replies shows as a receipt without a reply.
test("a view call writes receipt and reply records with its source generation", { timeout: 5000 }, async () => {
  wire = selectPageWire("surface-view-call-records");
  const dom = openDocument();
  logGate.set(CALL_DEBUG);
  const { mountSurface, authorizeSurface, disposeSurface, viewCallsIdle } = await import("../surface-modules.js?view-records");
  const pluginId = "fixture-records-view";
  const surfaceId = "fixture-records-view-surface";
  recordOrigin(surfaceId, null, "test fixture");
  registerPlugin({ id: pluginId, surface: () => null });
  const surface = viewSurface(surfaceId, pluginId);
  try {
    authorizeSurface(surfaceId);
    seedViewSource(pluginId, surfaceId);
    await mountSurface(document.querySelector("#slot"), surface, { onState: () => {} });
    wire.deliverNotice();
    // The reply is sent after the call has settled, and the emitted reply record follows the send: viewCallsIdle waits for both.
    await viewCallsIdle();
    await flushEvents();
    assert.deepEqual(loggedEvents().filter(({ event }) => event === "workbench.view.call"), [{ level: "debug", event: "workbench.view.call",
      fields: { plugin: pluginId, surface: surfaceId, generation: 1, id: 7, command: "runtime.settings.read" } }]);
    assert.deepEqual(loggedEvents().filter(({ event }) => event === "workbench.view.reply"), [{ level: "debug", event: "workbench.view.reply",
      fields: { plugin: pluginId, surface: surfaceId, generation: 1, id: 7, outcome: "result" } }]);
    assert.deepEqual(replies(), [{ id: 7, result: {}, page: pageIdentity, generation: 1, surface: surfaceId }]);
    await disposeSurface(surfaceId);
    await end();
  } finally {
    logGate.set(ERRORS_ONLY);
    dom.window.close();
  }
});

// The text size registration of a view resolves with a promise of its off function (docs/spec/native-surfaces.md, view subscriptions).
test("a view subscription to the text size resolves with a result", { timeout: 5000 }, async () => {
  wire = selectPageWire("surface-view-text-size-subscription");
  const dom = openDocument();
  logGate.set(CALL_DEBUG);
  const { mountSurface, authorizeSurface, disposeSurface, viewCallsIdle } = await import("../surface-modules.js?view-text-size");
  const pluginId = "fixture-text-size-view";
  const surfaceId = "fixture-text-size-view-surface";
  recordOrigin(surfaceId, null, "test fixture");
  registerPlugin({ id: pluginId, surface: () => null });
  const surface = viewSurface(surfaceId, pluginId);
  try {
    authorizeSurface(surfaceId);
    seedViewSource(pluginId, surfaceId);
    await mountSurface(document.querySelector("#slot"), surface, { onState: () => {} });
    wire.deliverNotice();
    await viewCallsIdle();
    await flushEvents();
    assert.deepEqual(loggedEvents().filter(({ event }) => event === "workbench.view.reply"), [{ level: "debug", event: "workbench.view.reply",
      fields: { plugin: pluginId, surface: surfaceId, generation: 1, id: 8, outcome: "result" } }]);
    assert.deepEqual(replies().map(({ id, result }) => ({ id, result })), [{ id: 8, result: null }]);
    await disposeSurface(surfaceId);
    await end();
  } finally {
    logGate.set(ERRORS_ONLY);
    dom.window.close();
  }
});

test("a view watch of a core status delivers the value and the changes of the core status", { timeout: 5000 }, async () => {
  wire = selectPageWire("surface-view-core-status");
  const dom = openDocument();
  const { registry } = await import("../exposure.js");
  const name = "core.fixture-grid";
  registry.declare("core", { status: [{ name, description: "Fixture grid.", schema: { type: "object" } }], commands: [], element: [] });
  let grid = { cards: ["a"] };
  const gridListeners = new Set();
  registry.status(name, () => grid, (fn) => { gridListeners.add(fn); return () => gridListeners.delete(fn); });
  const { mountSurface, authorizeSurface, disposeSurface, viewCallsIdle } = await import("../surface-modules.js?view-core-status");
  const pluginId = "fixture-core-status-view";
  const surfaceId = "fixture-core-status-view-surface";
  recordOrigin(surfaceId, null, "test fixture");
  registerPlugin({ id: pluginId, surface: () => null });
  const surface = viewSurface(surfaceId, pluginId);
  /** The values that the page pushed to the view for the watched status. */
  const events = () => callsNamed("viewEvent").filter(({ payload }) => payload.event === "status").map(({ payload }) => payload.data);
  try {
    authorizeSurface(surfaceId);
    seedViewSource(pluginId, surfaceId);
    await mountSurface(document.querySelector("#slot"), surface, { onState: () => {} });
    wire.deliverNotice();
    await viewCallsIdle();
    await drained();
    grid = { cards: ["a", "b"] };
    for (const fn of gridListeners) fn(grid);
    await drained();
    assert.deepEqual(events(), [{ name, value: { cards: ["a"] } }, { name, value: { cards: ["a", "b"] } }],
      `the view received ${JSON.stringify(events())}`);
    await disposeSurface(surfaceId);
    await end();
  } finally {
    dom.window.close();
  }
});

// contract: view.restart.limit-shows-error
// The view-stopped event of the surface is shown as the error state of the surface, and mounting the surface again replaces that state.
test("a view that stopped its restarts shows its reason as the error state of its surface until it is mounted again", { timeout: 5000 }, async () => {
  wire = selectPageWire("surface-view-stop");
  const dom = openDocument();
  const { mountSurface, authorizeSurface, disposeSurface, waitSurfaceCompositionDeclared } = await import("../surface-modules.js?view-stop");
  const pluginId = "fixture-stopped-view";
  const surfaceId = "fixture-stopped-view-surface";
  recordOrigin(surfaceId, null, "test fixture");
  registerPlugin({ id: pluginId, surface: () => null });
  const surface = viewSurface(surfaceId, pluginId);
  const reason = "the view failed 4 times within 300 seconds and is created again when its tab is reopened";
  try {
    authorizeSurface(surfaceId);
    const states = [];
    seedViewSource(pluginId, surfaceId);
    await mountSurface(document.querySelector("#slot"), surface, { onState: (state) => states.push(state) });
    await waitSurfaceCompositionDeclared(surfaceId);
    wire.deliverNotice();
    const stopped = states.at(-1);
    assert.equal(stopped.phase, "error");
    assert.equal(stopped.error.message, reason);

    await disposeSurface(surfaceId);
    authorizeSurface(surfaceId);
    const reopened = [];
    seedViewSource(pluginId, surfaceId);
    await mountSurface(document.querySelector("#slot"), surface, { onState: (state) => reopened.push(state) });
    assert.notEqual(reopened.at(-1).phase, "error", "mounting the surface again shows no error");
    await disposeSurface(surfaceId);
    await end();
  } finally {
    dom.window.close();
  }
});

// contract: view.responsiveness.relay
// The view-responsiveness event of a view is the state of its surface in core.plugin.views, and dispose removes that state.
test("a view responsiveness notice is the state of its surface until the surface is disposed", { timeout: 20000 }, async () => {
  wire = selectPageWire("surface-view-responsive");
  const dom = openDocument();
  logGate.set(CALL_DEBUG);
  const { mountSurface, authorizeSurface, disposeSurface, waitSurfaceCompositionDeclared } = await import("../surface-modules.js?view-responsive");
  const { views } = await import("../plugin-processes.js");
  const pluginId = "fixture-responsive-view";
  const surfaceId = "fixture-responsive-view-surface";
  recordOrigin(surfaceId, null, "test fixture");
  registerPlugin({ id: pluginId, surface: () => null });
  const surface = viewSurface(surfaceId, pluginId);
  const ofSurface = () => views().filter((entry) => entry.surface === surfaceId);
  try {
    authorizeSurface(surfaceId);
    seedViewSource(pluginId, surfaceId);
    await mountSurface(document.querySelector("#slot"), surface, { onState: () => {} });
    await waitSurfaceCompositionDeclared(surfaceId);
    wire.deliverNotice();
    assert.deepEqual(ofSurface(), [{ plugin: pluginId, surface: surfaceId, responsive: false }]);
    wire.deliverNotice();
    assert.deepEqual(ofSurface(), [{ plugin: pluginId, surface: surfaceId, responsive: true }]);
    assert.equal(registerSourceOrigin(pluginId, surfaceId, 2), true, "the replacement source did not advance its generation");
    wire.deliverNotice();
    assert.deepEqual(ofSurface(), [{ plugin: pluginId, surface: surfaceId, responsive: true }],
      "a delayed responsiveness notice of the retired view changed the replacement state");
    wire.deliverNotice();
    assert.deepEqual(ofSurface(), [{ plugin: pluginId, surface: surfaceId, responsive: false }],
      "the current generation responsiveness notice was not applied");
    await flushEvents();
    assert.deepEqual(loggedEvents().filter(({ event }) => event === "workbench.view.event.cancel").map(({ fields }) => fields), [
      { plugin: pluginId, surface: surfaceId, event: "view-responsiveness" },
    ], "the stale notice cancellation was not recorded");
    await disposeSurface(surfaceId);
    assert.deepEqual(ofSurface(), [], "dispose removes the responsiveness of the surface");
    await end();
  } finally {
    logGate.set(ERRORS_ONLY);
    dom.window.close();
  }
});

// The start values of a view (docs/spec/native-surfaces.md#view-surfaces): the host injects them as window.sokSurface before the
// page of the view runs. origin is the directory that the tab that opened the tab recorded, and project is the project that the
// window shows, or null.
test("the start values of a view carry its params, origin, project, declarations and diagnostic declaration", async () => {
  const { viewStartValues } = await import("../surface-modules.js?view-start");
  const { reportDirectory } = await import("../tab-reports.js");
  reportDirectory("tab-with-directory", "/work/one");
  recordOrigin("tab-of-directory", "tab-with-directory", "test fixture");
  const diagnostics = { module: "ui/fixture-diagnostics.js", exposes: { commands: [] } };
  const surface = { surfaceId: "tab-of-directory", params: { path: "a.md" }, declarations: { commands: [] }, diagnostics };
  assert.deepEqual(viewStartValues(surface, { id: "prj-one", root: "/work/one" }), {
    params: { path: "a.md" },
    origin: { directory: "/work/one" },
    project: { id: "prj-one", root: "/work/one" },
    declarations: { status: [], commands: [], element: [] },
    diagnostics,
    section: null,
  });
  recordOrigin("tab-without-directory", null, "test fixture");
  assert.deepEqual(viewStartValues({ surfaceId: "tab-without-directory", declarations: {}, diagnostics: null }, null), {
    params: null,
    origin: { directory: null },
    project: null,
    declarations: { status: [], commands: [], element: [] },
    diagnostics: null,
    section: null,
  });
});

// A tab whose origin was pruned from the layout memory while it was out of the displayed layout is refused at its presentation. The
// refusal names the tab, its plugin, space and project, the path that created it, whether this session recorded its origin, and the
// operation whose stored layout dropped the origin.
test("a view whose origin is missing names the tab, its plugin, space, project, creation path, session history, the drop and the tabs of the stored layout", async () => {
  const { viewStartValues } = await import("../surface-modules.js?view-origin-record");
  const { forgetTabsLeft, recordOrigin, storedLayoutState } = await import("../tab-reports.js");
  recordOrigin("tab-pruned", null, "new tab");
  const previous = [{ id: "card-pruned", data: { tabs: [{ id: "tab-pruned", plugin: "fixture-view" }] } }];
  storedLayoutState({ cards: previous });
  forgetTabsLeft(previous, [{ id: "card-kept", data: { tabs: [{ id: "tab-kept", plugin: "fixture-view" }] } }],
    "saved layout of space spc-pruned, project prj-pruned");
  assert.throws(() => viewStartValues({ surfaceId: "tab-pruned", pluginId: "fixture-view", declarations: {} }, null), (error) => {
    assert.equal(error.message, "tab tab-pruned has no origin: plugin fixture-view, space none, project none, created by new tab, " +
      "held by this session: yes, origin dropped by saved layout of space spc-pruned, project prj-pruned, " +
      "whose stored layout held the tabs tab-kept");
    return true;
  });
});

// The refusal of a commit candidate without an origin names the layout that made it a candidate, so a record tells which layout
// still held a tab whose origin a stored layout dropped (docs/spec/projects.md#tab-origin).
test("a commit candidate without an origin is refused with the holder that made it a candidate", async () => {
  const { surfacePlacementsForHost } = await import("../surface-modules.js?view-origin-holder");
  const { forgetTabsLeft } = await import("../tab-reports.js");
  recordOrigin("tab-held", null, "new tab");
  forgetTabsLeft([{ id: "card-held", data: { tabs: [{ id: "tab-held", plugin: "fixture-view" }] } }], [], "close space spc-a, project prj-a");
  const candidate = { id: "tab-held", surface: { surfaceId: "tab-held", pluginId: "fixture-view", declarations: {},
    composition: { kind: "view", page: "ui/page.html" } } };
  assert.throws(() => surfacePlacementsForHost([candidate], null, (entry) => `the stored layout of space spc-b, project prj-b (${entry.id})`),
    (error) => {
      assert.equal(error.message, "tab tab-held has no origin: plugin fixture-view, space none, project none, created by new tab, " +
        "held by this session: yes, origin dropped by close space spc-a, project prj-a, whose stored layout held no tab, " +
        "a commit candidate of the stored layout of space spc-b, project prj-b (tab-held)");
      return true;
    });
});

/** Resolves when the registration of the status of the surface is present or absent, at the registration change that makes it so. */
function untilRegistration(registry, statusId, surfaceId, present) {
  return new Promise((resolve) => {
    const reached = () => registry.registrants("status", statusId).includes(surfaceId) === present;
    if (reached()) {
      resolve();
      return;
    }
    const stop = registry.onRegistrationChange(() => {
      if (!reached()) return;
      stop();
      resolve();
    });
  });
}

// contract: view.exposure.register
// A registered call of the view applies the entry through the exposure registry, relays it to the host, and the view's port
// consumes the forwarded exposure requests so the page never forwards them twice (docs/spec/exposure.md#relay).
test("a view registers its exposure through the page and its port consumes forwarded requests", { timeout: 20000 }, async () => {
  wire = selectPageWire("surface-view-exposure-register");
  const dom = openDocument();
  // The registry and the port live in the shared exposure module, which the query-suffixed surface-modules instance imports too.
  const { registry, dispatchSurfaceRequest } = await import("../exposure.js");
  const { mountSurface, authorizeSurface, disposeSurface } = await import("../surface-modules.js?view-exp");
  const pluginId = "fixture-exp";
  const surfaceId = "fixture-exp-surface";
  recordOrigin(surfaceId, null, "test fixture");
  registry.configure({ surfacePlugin: () => pluginId });
  registry.declare(pluginId, {
    status: [{ name: `${pluginId}.lines`, description: "Lines.", schema: { type: "array" } }],
    commands: [], element: [],
  });
  registerPlugin({ id: pluginId, surface: () => null });
  const surface = viewSurface(surfaceId, pluginId);
  try {
    authorizeSurface(surfaceId);
    seedViewSource(pluginId, surfaceId);
    await mountSurface(document.querySelector("#slot"), surface);
    wire.deliverNotice();
    await drained();
    assert.deepEqual(registry.registrants("status", `${pluginId}.lines`), [surfaceId], "the registration did not reach the registry");
    assert.deepEqual(callsNamed("exposureRegister"), [{
      name: "exposureRegister", payload: { kind: "status", name: `${pluginId}.lines`, surface: surfaceId },
    }], "the registration was not relayed to the host");
    assert.equal(await dispatchSurfaceRequest({ surface: surfaceId, id: 7, method: "status.get", params: { name: `${pluginId}.lines` } }),
      true, "the forwarded request was not consumed by the view's port");
    await disposeSurface(surfaceId);
    assert.equal(await dispatchSurfaceRequest({ surface: surfaceId, id: 8, method: "status.get", params: {} }),
      false, "the port survived the surface");
    await end();
  } finally {
    dom.window.close();
  }
});

// The view source contract binds a registration to its source process. Ending the current view process removes that process's
// registrations; a replacement can register again, while a delayed end from the old generation cannot remove the replacement.
test("a view process end removes its status registrations and preserves replacement registrations", { timeout: 20000 }, async () => {
  wire = selectPageWire("surface-view-process-end-registrations");
  const dom = openDocument();
  const { registry } = await import("../exposure.js");
  const registrationObservations = [];
  const { mountSurface, authorizeSurface, disposeSurface, viewCallsIdle } = await import("../surface-modules.js?view-exposure-generation-end");
  const pluginId = "fixture-view-exposure-generation";
  const surfaceId = "fixture-view-exposure-generation-surface";
  const statusId = `${pluginId}.lines`;
  recordOrigin(surfaceId, null, "test fixture");
  registry.configure({ surfacePlugin: () => pluginId });
  registry.declare(pluginId, { status: [{ name: statusId, description: "Lines.", schema: { type: "array" } }], commands: [], element: [] });
  registerPlugin({ id: pluginId, surface: () => null });
  const surface = viewSurface(surfaceId, pluginId);
  const stopRegistrationObservation = registry.onRegistrationChange(() => {
    registrationObservations.push({
      registrants: registry.registrants("status", statusId),
      generation: sourceOrigin(pluginId, surfaceId),
    });
  });
  try {
    authorizeSurface(surfaceId);
    seedViewSource(pluginId, surfaceId, 1);
    await mountSurface(document.querySelector("#slot"), surface);
    wire.deliverNotice();
    await viewCallsIdle();
    await untilRegistration(registry, statusId, surfaceId, true);

    assert.equal(endSourceOrigin(pluginId, surfaceId, 1), true, "the current source generation did not end");
    assert.deepEqual(registry.registrants("status", statusId), [], "the ended view registration remained available before process-end cleanup");
    assert.deepEqual(registrationObservations.at(-1), { registrants: [], generation: undefined }, "observers saw an ended generation with a live registration");
    wire.deliverNotice();
    await viewCallsIdle();
    await untilRegistration(registry, statusId, surfaceId, false);
    assert.equal(sourceOrigin(pluginId, surfaceId), undefined, "the ended generation remains current");

    assert.equal(registerSourceOrigin(pluginId, surfaceId, 2), true, "the replacement source generation did not register");
    wire.deliverNotice();
    await viewCallsIdle();
    await untilRegistration(registry, statusId, surfaceId, true);

    assert.equal(endSourceOrigin(pluginId, surfaceId, 1), false, "a delayed old end retired the replacement generation");
    wire.deliverNotice();
    assert.deepEqual(registry.registrants("status", statusId), [surfaceId], "a delayed old end removed the replacement registration");
    assert.equal(callsNamed("exposureRegister").length, 2, "both view generations must register the status with the host");
    await disposeSurface(surfaceId);
    await end();
  } finally {
    stopRegistrationObservation();
    dom.window.close();
  }
});

// The dispose of a view removes its registrations while its view process still runs, so a closed tab is not found by the name
// of its status (docs/spec/exposure.md), and the next mount of the same surface registers again.
test("the dispose of a view removes its registrations before the same surface is mounted again", { timeout: 20000 }, async () => {
  wire = selectPageWire("surface-view-dispose-registrations");
  const dom = openDocument();
  const { registry } = await import("../exposure.js");
  const { mountSurface, authorizeSurface, disposeSurface, viewCallsIdle } = await import("../surface-modules.js?view-exposure-dispose");
  const pluginId = "fixture-view-exposure-dispose";
  const surfaceId = "fixture-view-exposure-dispose-surface";
  const statusId = `${pluginId}.lines`;
  recordOrigin(surfaceId, null, "test fixture");
  registry.configure({ surfacePlugin: () => pluginId });
  registry.declare(pluginId, { status: [{ name: statusId, description: "Lines.", schema: { type: "array" } }], commands: [], element: [] });
  registerPlugin({ id: pluginId, surface: () => null });
  const surface = viewSurface(surfaceId, pluginId);
  try {
    authorizeSurface(surfaceId);
    seedViewSource(pluginId, surfaceId, 1);
    await mountSurface(document.querySelector("#slot"), surface);
    wire.deliverNotice();
    await viewCallsIdle();
    await untilRegistration(registry, statusId, surfaceId, true);

    await disposeSurface(surfaceId);
    assert.equal(sourceOrigin(pluginId, surfaceId), 1, "the view process of the fixture ended with the dispose");
    assert.deepEqual(registry.registrants("status", statusId), [], "the disposed view kept its registration");
    assert.equal(registry.chosen("status", statusId, surfaceId, true), null, "a request that names the disposed surface chose it");
    assert.equal(registry.list().status.find(({ name }) => name === statusId).registered, false, "exposure.list kept the disposed registration");

    authorizeSurface(surfaceId);
    await mountSurface(document.querySelector("#slot"), surface);
    wire.deliverNotice();
    await viewCallsIdle();
    await untilRegistration(registry, statusId, surfaceId, true);
    assert.deepEqual(registry.registrants("status", statusId), [surfaceId], "the next mount did not register again");
    await disposeSurface(surfaceId);
    await end();
  } finally {
    dom.window.close();
  }
});

// A view watches a status only when the exposure declares it: a watch of an undeclared status is refused with its name and
// replies with that refusal (docs/spec/native-surfaces.md#view-surfaces, view calls).
test("a view watch of a status that the exposure does not declare is refused with its name", { timeout: 20000 }, async () => {
  wire = selectPageWire("surface-view-undeclared-status");
  const dom = openDocument();
  const { registry } = await import("../exposure.js");
  const { mountSurface, authorizeSurface, disposeSurface, viewCallsIdle } = await import("../surface-modules.js?view-status");
  const pluginId = "fixture-status";
  const surfaceId = "fixture-status-surface";
  recordOrigin(surfaceId, null, "test fixture");
  registry.configure({ surfacePlugin: () => pluginId });
  registry.declare(pluginId, { status: [{ name: `${pluginId}.lines`, description: "Lines.", schema: { type: "array" } }], commands: [], element: [] });
  registerPlugin({ id: pluginId, surface: () => null });
  const surface = viewSurface(surfaceId, pluginId);
  try {
    authorizeSurface(surfaceId);
    seedViewSource(pluginId, surfaceId);
    await mountSurface(document.querySelector("#slot"), surface);
    wire.deliverNotice();
    await viewCallsIdle();
    assert.deepEqual(callsNamed("viewReply"), [{
      name: "viewReply",
      payload: { id: 3, error: { code: -32000, message: `view call runtime.status.watch ${pluginId}.missing is not a declared status` }, generation: 1, surface: surfaceId, page: pageIdentity },
    }]);
    await disposeSurface(surfaceId);
    await end();
  } finally {
    dom.window.close();
  }
});

// A view names the sidecar of each send, and the surface sends only to a sidecar that it declares (docs/spec/native-surfaces.md#view-surfaces).
// A send that names another sidecar is refused with its reason and reaches no sidecar.
test("a view sends only to a sidecar its surface declares and a send to another sidecar is refused", { timeout: 20000 }, async () => {
  wire = selectPageWire("surface-view-sidecar");
  const dom = openDocument();
  const { mountSurface, authorizeSurface, disposeSurface, viewCallsIdle } = await import("../surface-modules.js?view-sidecar");
  const pluginId = "fixture-view-sidecar";
  const surfaceId = "fixture-view-sidecar-surface";
  recordOrigin(surfaceId, null, "test fixture");
  registerPlugin({ id: pluginId, surface: () => null });
  const surface = viewSurface(surfaceId, pluginId, { sidecars: ["fixture-sidecar"] });
  /** The sends that reached a sidecar through the host. */
  const sent = () => callsNamed("viewSidecarSend").map(({ payload }) => payload);
  try {
    authorizeSurface(surfaceId);
    seedViewSource(pluginId, surfaceId);
    await mountSurface(document.querySelector("#slot"), surface);
    wire.deliverNotice();
    await viewCallsIdle();
    assert.deepEqual(replies().at(-1), { id: 1, error: { code: -32000, message: `surface ${surfaceId} cannot send to sidecar other-sidecar` }, page: pageIdentity, generation: 1, surface: surfaceId },
      "a send to an undeclared sidecar was not refused with its reason");
    assert.deepEqual(sent(), [], "a send to an undeclared sidecar reached a sidecar");
    wire.deliverNotice();
    await viewCallsIdle();
    assert.deepEqual(replies().at(-1), { id: 2, result: null, page: pageIdentity, generation: 1, surface: surfaceId }, "a send to the declared sidecar was refused");
    assert.deepEqual(sent(), [{ source: surfaceId, generation: 1, sidecar: "fixture-sidecar", surface: surfaceId, body: { n: 2 }, cids: [] }]);
    await disposeSurface(surfaceId);
    await end();
  } finally {
    dom.window.close();
  }
});

// The composition and region calls of a view run the page operations of its surface: the attach goes through the region record of
// the memory saver and the placement carries the composition revision of the document (docs/spec/native-surfaces.md#view-surfaces).
test("the region calls of a view run the page operations of its surface", { timeout: 20000 }, async () => {
  wire = selectPageWire("surface-view-regions");
  const dom = openDocument();
  const { documentRegions } = await import("../document-regions.js");
  // The tab sessions are not open in this test, so the regions attach without a stored session.
  documentRegions.useSessions(null);
  const { mountSurface, authorizeSurface, disposeSurface, viewCallsIdle } = await import("../surface-modules.js?view-region");
  const pluginId = "fixture-region";
  const surfaceId = "fixture-region-surface";
  recordOrigin(surfaceId, null, "test fixture");
  registerPlugin({ id: pluginId, surface: () => null });
  const composition = { kind: "view", page: "ui/page.html", regions: [{ name: "doc", kind: "document", input: "native" }], overlays: [] };
  const surface = viewSurface(surfaceId, pluginId, { composition });
  try {
    authorizeSurface(surfaceId);
    seedViewSource(pluginId, surfaceId);
    await mountSurface(document.querySelector("#slot"), surface);
    wire.deliverNotice();
    wire.deliverNotice();
    await viewCallsIdle();
    wire.deliverNotice();
    await viewCallsIdle();
    assert.deepEqual(replies(), [
      { id: 1, result: { kind: "view", regions: composition.regions, overlays: [] }, page: pageIdentity, generation: 1, surface: surfaceId },
      { id: 2, result: { history: false }, page: pageIdentity, generation: 1, surface: surfaceId },
      { id: 3, result: null, page: pageIdentity, generation: 1, surface: surfaceId },
    ]);
    assert.deepEqual(callsNamed("documentAttach"), [
      { name: "documentAttach", payload: { document: "doc", surface: surfaceId } },
    ]);
    const placed = callsNamed("compositionPlace");
    assert.equal(placed.length, 1);
    assert.ok(Number.isInteger(placed[0].payload.revision) && placed[0].payload.revision > 0, "the placement carries the revision of the document");
    assert.deepEqual(placed[0].payload.regions, [{ name: "doc", left: 1, top: 2, right: 3, bottom: 4, visible: true }]);
    assert.deepEqual(documentRegions.tabs(), [surfaceId], "the attach is recorded by the region record");
    await disposeSurface(surfaceId);
    await end();
  } finally {
    dom.window.close();
  }
});

// The host reports the end of a view process with view-process-ended, and the host has closed the regions of the surface with it,
// so the region record of the page forgets them before the restarted view attaches them again.
test("a view process end forgets the regions that its surface attached", { timeout: 20000 }, async () => {
  wire = selectPageWire("surface-view-process-end-regions");
  const dom = openDocument();
  const { documentRegions } = await import("../document-regions.js");
  documentRegions.useSessions(null);
  const { mountSurface, authorizeSurface, disposeSurface, viewCallsIdle } = await import("../surface-modules.js?view-process-end");
  const pluginId = "fixture-region-end";
  const surfaceId = "fixture-region-process-end";
  recordOrigin(surfaceId, null, "test fixture");
  registerPlugin({ id: pluginId, surface: () => null });
  const composition = { kind: "view", page: "ui/page.html", regions: [{ name: "doc", kind: "document", input: "native" }], overlays: [] };
  const surface = viewSurface(surfaceId, pluginId, { composition });
  try {
    authorizeSurface(surfaceId);
    seedViewSource(pluginId, surfaceId);
    await mountSurface(document.querySelector("#slot"), surface);
    wire.deliverNotice();
    await viewCallsIdle();
    assert.deepEqual(documentRegions.tabs(), [surfaceId], "the attached region is recorded before the process end");
    wire.deliverNotice();
    assert.deepEqual(documentRegions.tabs(), [], "the process end forgets the regions of the surface");
    await disposeSurface(surfaceId);
    await end();
  } finally {
    dom.window.close();
  }
});

// A view mount that fails releases the exposure port it registered, so the surface can be mounted again. The host refuses the first
// composition declaration of the view; the port of the failed mount must not remain after the failure.
test("a failed view mount releases its exposure port, and a retry mounts the surface", { timeout: 5000 }, async () => {
  wire = selectPageWire("surface-view-failed-mount");
  const dom = openDocument();
  const { mountSurface, authorizeSurface, disposeSurface, waitSurfaceCompositionDeclared } = await import("../surface-modules.js?view-failed-mount");
  const { dispatchSurfaceRequest } = await import("../exposure.js");
  const pluginId = "fixture-failed-view";
  const surfaceId = "fixture-failed-view-surface";
  recordOrigin(surfaceId, null, "test fixture");
  registerPlugin({ id: pluginId, surface: () => null });
  const surface = viewSurface(surfaceId, pluginId);
  try {
    authorizeSurface(surfaceId);
    seedViewSource(pluginId, surfaceId);
    await assert.rejects(mountSurface(document.querySelector("#slot"), surface), /composition declaration/);
    assert.equal(await dispatchSurfaceRequest({ surface: surfaceId, id: 1, method: "status.list", params: {} }), false,
      "the failed mount left its exposure port registered");
    seedViewSource(pluginId, surfaceId);
    await mountSurface(document.querySelector("#slot"), surface);
    await waitSurfaceCompositionDeclared(surfaceId);
    await disposeSurface(surfaceId);
    await end();
  } finally {
    dom.window.close();
  }
});

/** Installs the core declarations of exposure.json once for the document. */
async function installCoreExposure() {
  const exposureFile = (await import("../exposure.json", { with: { type: "json" } })).default;
  const { installExposure, registry } = await import("../exposure.js");
  if (!registry.declared("status", "core.surface.document")) installExposure(structuredClone(exposureFile));
}

// A view receives the core declarations at startup and registers them from its own document, never from the main-page placeholder.
test("a view surface mounts with the core surface entries that exposure.json declares", { timeout: 5000 }, async () => {
  wire = selectPageWire("surface-view-core-exposure");
  const dom = openDocument();
  await installCoreExposure();
  const { registry, dispatchSurfaceRequest } = await import("../exposure.js");
  const { mountSurface, authorizeSurface, disposeSurface, waitSurfaceCompositionDeclared, viewStartValues } = await import("../surface-modules.js?view-core-exposure");
  const pluginId = "fixture-core-view";
  const surfaceId = "fixture-core-view-surface";
  recordOrigin(surfaceId, null, "test fixture");
  registerPlugin({ id: pluginId, surface: () => null });
  const surface = viewSurface(surfaceId, pluginId);
  try {
    authorizeSurface(surfaceId);
    seedViewSource(pluginId, surfaceId);
    await mountSurface(document.querySelector("#slot"), surface);
    await waitSurfaceCompositionDeclared(surfaceId);
    assert.deepEqual(registry.namesOf(surfaceId), [], "the main placeholder registered view document entries");
    const start = viewStartValues(surface, null);
    assert.deepEqual(start.declarations.status.map(({ name }) => name).sort(), ["core.surface.document", "core.surface.input"]);
    assert.deepEqual(start.declarations.commands.map(({ name }) => name), ["core.surface.hit", "core.surface.clock"]);
    assert.equal(await dispatchSurfaceRequest({ surface: surfaceId, id: 7, method: "status.get", params: { name: "core.surface.document" } }),
      true, "the core entry of the view surface is not served by its page");
    await disposeSurface(surfaceId);
    await end();
  } finally {
    dom.window.close();
  }
});

// A view mount, then the core registration of the surface, then a command that the view registers: all three use the one exposure
// port of the surface, so the mount succeeds and the command reaches the registry of the surface.
test("a view mount, its core registration and its command registration share one exposure port", { timeout: 5000 }, async () => {
  wire = selectPageWire("surface-view-one-port");
  const dom = openDocument();
  await installCoreExposure();
  const { registry, dispatchSurfaceRequest } = await import("../exposure.js");
  const { mountSurface, authorizeSurface, disposeSurface, waitSurfaceCompositionDeclared, viewCallsIdle } = await import("../surface-modules.js?view-one-port");
  const pluginId = "fixture-one-port-view";
  const surfaceId = "fixture-one-port-view-surface";
  const command = `${pluginId}.run`;
  const commands = [{ name: command, description: "Runs the fixture.", params: { type: "object" }, result: { type: "null" } }];
  recordOrigin(surfaceId, null, "test fixture");
  registry.configure({ surfacePlugin: () => pluginId });
  registry.declare(pluginId, { status: [], element: [], commands });
  registerPlugin({ id: pluginId, surface: () => null });
  const surface = viewSurface(surfaceId, pluginId, { declarations: { status: [], commands, element: [] } });
  try {
    authorizeSurface(surfaceId);
    seedViewSource(pluginId, surfaceId);
    await mountSurface(document.querySelector("#slot"), surface);
    await waitSurfaceCompositionDeclared(surfaceId);
    assert.equal(await dispatchSurfaceRequest({ surface: surfaceId, id: 1, method: "status.get", params: { name: "core.surface.document" } }),
      true, "the core entry of the view surface is not served by its page");
    wire.deliverNotice();
    await viewCallsIdle();
    assert.ok(registry.namesOf(surfaceId).includes(`command ${command}`), `the view command is not registered: ${JSON.stringify(registry.namesOf(surfaceId))}`);
    await disposeSurface(surfaceId);
    await end();
  } finally {
    dom.window.close();
  }
});

// A command that the view registers with runtime.command.register is answered by the forwarding handler of the page: its forwarded
// request runs on the surface port and reaches the view as a command request, and the exposure-request listener of the view does not
// receive it, while the other requests of the view surface still reach the view.
test("a forwarded run of a command that the view registered runs on the page port and not as an exposure request of the view", { timeout: 5000 }, async () => {
  wire = selectPageWire("surface-view-page-command");
  const dom = openDocument();
  await installCoreExposure();
  const { registry, dispatchSurfaceRequest } = await import("../exposure.js");
  const { mountSurface, authorizeSurface, disposeSurface, waitSurfaceCompositionDeclared, viewCallsIdle } = await import("../surface-modules.js?view-page-command");
  const pluginId = "fixture-page-command-view";
  const surfaceId = "fixture-page-command-view-surface";
  const command = `${pluginId}.run`;
  const commands = [{ name: command, description: "Runs the fixture.", params: { type: "object" }, result: { type: "null" } }];
  recordOrigin(surfaceId, null, "test fixture");
  registry.configure({ surfacePlugin: () => pluginId });
  registry.declare(pluginId, { status: [], element: [], commands });
  registerPlugin({ id: pluginId, surface: () => null });
  const surface = viewSurface(surfaceId, pluginId, { declarations: { status: [], commands, element: [] } });
  try {
    authorizeSurface(surfaceId);
    seedViewSource(pluginId, surfaceId);
    await mountSurface(document.querySelector("#slot"), surface);
    await waitSurfaceCompositionDeclared(surfaceId);
    assert.equal(await dispatchSurfaceRequest({ surface: surfaceId, id: 1, method: "status.get", params: { name: "core.surface.document" } }),
      true, "the core entry of the view surface is not served by its page");
    wire.deliverNotice();
    await viewCallsIdle();
    assert.ok(registry.namesOf(surfaceId).includes(`command ${command}`), `the view command is not registered: ${JSON.stringify(registry.namesOf(surfaceId))}`);
    wire.deliverNotice();
    await viewCallsIdle();
    const before = wire.calls.length;
    const run = { surface: surfaceId, id: 4, method: "command.run", params: { name: command, params: {} } };
    wire.deliverNotice();
    assert.equal(await dispatchSurfaceRequest(run), true);
    await drained();
    const after = () => wire.calls.slice(before);
    assert.deepEqual(after().filter(({ name }) => name === "viewRequest").map(({ payload }) => payload.command), [command],
      "the forwarded command run did not reach the view as a command request");
    assert.deepEqual(after().filter(({ name, payload }) => name === "viewEvent" && payload.event === "exposure-request"), [],
      "the command run that the page answers was pushed to the view as an exposure request");
    const status = { surface: surfaceId, id: 5, method: "status.get", params: { name: "core.surface.document" } };
    wire.deliverNotice();
    assert.equal(await dispatchSurfaceRequest(status), true);
    await drained();
    assert.deepEqual(after().filter(({ name, payload }) => name === "viewEvent" && payload.event === "exposure-request").map(({ payload }) => payload.data.id), [5],
      "a request that the view answers did not reach the view");
    await disposeSurface(surfaceId);
    await end();
  } finally {
    dom.window.close();
  }
});

test("a validated native view call uses only the private sidecar bridge with its original generation", { timeout: 5000 }, async () => {
  wire = selectPageWire("surface-view-typed-sidecar");
  const dom = openDocument();
  const { mountSurface, authorizeSurface, disposeSurface, viewCallsIdle } = await import("../surface-modules.js?typed-view-sidecar-source");
  const pluginId = "fixture-typed-sidecar";
  const surfaceId = "fixture-typed-sidecar-source";
  const sidecar = "@fixture/sidecar";
  recordOrigin(surfaceId, null, "test fixture");
  registerPlugin({ id: pluginId, surface: () => null });
  const surface = viewSurface(surfaceId, pluginId, { sidecars: [sidecar] });
  try {
    authorizeSurface(surfaceId);
    seedViewSource(pluginId, surfaceId, 41);
    await mountSurface(document.querySelector("#slot"), surface, { onState: () => {} });
    wire.deliverNotice();
    await viewCallsIdle();
    assert.deepEqual(callsNamed("viewSidecarSend").map(({ payload }) => payload),
      [{ source: surfaceId, generation: 41, sidecar, surface: surfaceId, body: { generation: 999 }, cids: ["op-1"] }]);
    assert.deepEqual(callsNamed("sidecarSend"), [], "native view operations must not enter generic/window sidecarSend");
    await disposeSurface(surfaceId);
    await end();
  } finally {
    dom.window.close();
  }
});

// A place that leaves an unmounted view out of the host request removes that surface in the host, its declaration included
// (docs/spec/native-surfaces.md#view-surfaces). The view declares after that place has its reply, so the removal cannot take a
// declaration that the view made while the place was in flight.
test("a view declares its composition only after a place that left it out has its reply", { timeout: 5000 }, async () => {
  wire = selectPageWire("surface-view-left-out-place");
  const dom = openDocument();
  const { mountSurface, authorizeSurface, disposeSurface, waitSurfaceCompositionDeclared, holdCompositionDeclarations } =
    await import("../surface-modules.js?view-left-out-place");
  const pluginId = "fixture-view-left-out";
  const surfaceId = "fixture-view-left-out-surface";
  recordOrigin(surfaceId, null, "test fixture");
  registerPlugin({ id: pluginId, surface: () => null });
  const surface = viewSurface(surfaceId, pluginId);
  let mounting;
  try {
    // The place is the host call that leaves the view out of the request; the case holds its reply.
    const place = host.call("syncSurfaces", { settled: true, overlays: [], surfaces: [] });
    place.catch(() => {});
    holdCompositionDeclarations([surfaceId], place);
    authorizeSurface(surfaceId);
    seedViewSource(pluginId, surfaceId);
    mounting = mountSurface(document.querySelector("#slot"), surface);
    // The mount runs in microtasks until it waits for the reply of the place, so after the end of the microtask queue a mount that
    // did not wait for that reply has declared its composition.
    await drained();
    assert.equal(callsNamed("compositionDeclare").length, 0,
      "the view declared its composition while a place that left it out had no reply");
    // A refused place removes nothing in the host, so its end also releases the declaration.
    wire.release();
    await mounting;
    await waitSurfaceCompositionDeclared(surfaceId);
    assert.equal(callsNamed("compositionDeclare").length, 1);
    await disposeSurface(surfaceId);
    await end();
  } finally {
    dom.window.close();
  }
});

// The host ends one view document while its calls and subscriptions are in flight. Late work from that document must stay canceled
// after a new document registers its subscriptions, while the new document's live work continues to report refusals.
test("a view process end cancels its pending work across restart and accepts new document subscriptions", { timeout: 20000 }, async () => {
  wire = selectPageWire("surface-view-process-end-pending-work");
  const dom = openDocument();
  logGate.set(CALL_DEBUG);
  const { mountSurface, authorizeSurface, disposeSurface, viewCallsIdle } = await import("../surface-modules.js?view-process-end-pending-work");
  const pluginId = "fixture-view-process-generation";
  const surfaceId = "fixture-view-process-generation-surface";
  recordOrigin(surfaceId, null, "test fixture");
  registerPlugin({ id: pluginId, surface: () => null });
  const surface = viewSurface(surfaceId, pluginId, { sidecars: ["fixture-sidecar"] });
  const routes = () => callsNamed("viewSidecarRoute")
    .map(({ payload }) => ({ generation: payload.generation, sidecar: payload.sidecar, id: payload.id, on: payload.on }));
  try {
    authorizeSurface(surfaceId);
    seedViewSource(pluginId, surfaceId);
    await mountSurface(document.querySelector("#slot"), surface);
    wire.deliverNotice();
    await viewCallsIdle();
    assert.ok(replies().some(({ id }) => id === 10));
    // The reply of the host to the send of the old document is held by the case until the test releases it.
    wire.deliverNotice();
    await drained();
    assert.equal(callsNamed("viewSidecarSend").length, 1, "the send of the old document did not start");
    assert.equal(endSourceOrigin(pluginId, surfaceId, 1), true, "the old source was not retired before its process-ended event");
    wire.deliverNotice();
    assert.equal(registerSourceOrigin(pluginId, surfaceId, 2), true, "the replacement source generation did not register after the old process ended");

    // A restarted document sends a new subscription before the old call settles.
    wire.deliverNotice();
    await drained();
    assert.ok(replies().some(({ id }) => id === 12));
    wire.release();
    await viewCallsIdle();
    await flushEvents();

    assert.deepEqual({
      staleReplies: replies().filter(({ id }) => id === 11),
      staleReplyReachedReplacement: replies().some(({ id }) => id === 11),
      oldCallCancellation: loggedEvents().filter(({ event, fields }) => event === "workbench.view.call.cancel" && fields.id === 11)
        .map(({ fields }) => ({ generation: fields.generation, id: fields.id })),
      routes: routes(),
      relayedEvents: callsNamed("viewEvent").length,
    }, {
      staleReplies: [], staleReplyReachedReplacement: false,
      oldCallCancellation: [{ generation: 1, id: 11 }],
      routes: [
        { generation: 1, sidecar: "fixture-sidecar", id: "probe", on: true },
        { generation: 1, sidecar: "fixture-sidecar", id: "probe", on: false },
        { generation: 2, sidecar: "fixture-sidecar", id: "probe", on: true },
      ],
      relayedEvents: 0,
    });
    await disposeSurface(surfaceId);
    await end();
  } finally {
    logGate.set(ERRORS_ONLY);
    dom.window.close();
  }
});

// The exposure port of a view is released when its surface is disposed, not when the view's listener registrations settle: a
// registration that settles after the dispose (a slow native listener) must not keep the port, or mounting the same surface again
// fails with "already has an exposure port".
test("a view surface mounted again after its dispose registers its port while the earlier listener registrations are pending", { timeout: 5000 }, async () => {
  wire = selectPageWire("surface-view-remount");
  const dom = openDocument();
  const { mountSurface, authorizeSurface, disposeSurface, waitSurfaceCompositionDeclared, viewCallsIdle } = await import("../surface-modules.js?view-remount");
  const pluginId = "fixture-view-remount";
  const surfaceId = "fixture-view-remount-surface";
  recordOrigin(surfaceId, null, "test fixture");
  registerPlugin({ id: pluginId, surface: () => null });
  const surface = viewSurface(surfaceId, pluginId);
  try {
    // The case holds the registration of view-call of the first mount, as a native listener is held under load.
    authorizeSurface(surfaceId);
    seedViewSource(pluginId, surfaceId);
    const firstMount = mountSurface(document.querySelector("#slot"), surface);
    await drained();
    assert.equal(callsNamed("compositionDeclare").length, 0, "the first mount declared before its delayed view-call listener registration");
    await disposeSurface(surfaceId);
    await firstMount;

    authorizeSurface(surfaceId);
    seedViewSource(pluginId, surfaceId);
    // The registrations of the replacement mount settle while the registration of the first mount is pending.
    await mountSurface(document.querySelector("#slot"), surface);
    await waitSurfaceCompositionDeclared(surfaceId);
    // The replacement composition waited for its own listener: its view-call listener answers.
    wire.deliverNotice();
    await viewCallsIdle();
    assert.equal(replies().length, 1, "the replacement composition did not wait for its own listener");
    // The late registration of the disposed mount settles and is removed at once.
    wire.release();
    await drained();
    assert.equal(wire.unsubscribed.filter((event) => event === "view-call").length, 1,
      "the late listener of the disposed mount stayed active");
    // The late listener of the disposed mount did not remove the replacement listener: one listener answers the call.
    wire.deliverNotice();
    await viewCallsIdle();
    assert.equal(replies().length, 2, "the late listener of the disposed mount removed the replacement listener");
    await disposeSurface(surfaceId);
    await end();
  } finally {
    dom.window.close();
  }
});

/** Routes the error event of the page to a list: the page reports a failure through the error event of its window. */
function collectPageErrors(dom) {
  const reported = [];
  const previousError = globalThis.ErrorEvent;
  const previousDispatch = globalThis.dispatchEvent;
  globalThis.ErrorEvent = dom.window.ErrorEvent;
  globalThis.dispatchEvent = dom.window.dispatchEvent.bind(dom.window);
  dom.window.addEventListener("error", (event) => reported.push(event.message));
  return { reported, restore() { globalThis.dispatchEvent = previousDispatch; globalThis.ErrorEvent = previousError; } };
}

test("a view reply the host refuses is reported through the page error path", { timeout: 20000 }, async () => {
  wire = selectPageWire("surface-view-reply-refused");
  const dom = openDocument();
  // The page error path is the error event of the window, so its errors are collected here.
  const errors = collectPageErrors(dom);
  const { registry } = await import("../exposure.js");
  const { mountSurface, authorizeSurface, disposeSurface, viewCallsIdle } = await import("../surface-modules.js?view-reply-report");
  const pluginId = "fixture-reply";
  const surfaceId = "fixture-reply-surface";
  recordOrigin(surfaceId, null, "test fixture");
  registry.configure({ surfacePlugin: () => pluginId });
  registry.declare(pluginId, { status: [], commands: [], element: [] });
  registerPlugin({ id: pluginId, surface: () => null });
  const surface = viewSurface(surfaceId, pluginId);
  try {
    authorizeSurface(surfaceId);
    seedViewSource(pluginId, surfaceId);
    await mountSurface(document.querySelector("#slot"), surface);
    wire.deliverNotice();
    await viewCallsIdle();
    assert.ok(errors.reported.includes(`view call 3 reply: ${surfaceId} has no ready document`),
      `the refused reply was not reported: ${JSON.stringify(errors.reported)}`);
    await disposeSurface(surfaceId);
    await end();
  } finally {
    errors.restore();
    dom.window.close();
  }
});

test("closing a view cancels a pending call reply and removes its sidecar route", { timeout: 20000 }, async () => {
  wire = selectPageWire("surface-view-close-pending");
  const dom = openDocument();
  logGate.set(CALL_DEBUG);
  const errors = collectPageErrors(dom);
  const { mountSurface, authorizeSurface, disposeSurface, viewCallsIdle } = await import("../surface-modules.js?view-close-pending-delivery");
  const pluginId = "fixture-close-pending-view";
  const surfaceId = "fixture-close-pending-surface";
  recordOrigin(surfaceId, null, "test fixture");
  registerPlugin({ id: pluginId, surface: () => null });
  const surface = viewSurface(surfaceId, pluginId, { sidecars: ["fixture-sidecar"] });
  try {
    authorizeSurface(surfaceId);
    seedViewSource(pluginId, surfaceId);
    await mountSurface(document.querySelector("#slot"), surface);
    wire.deliverNotice();
    await viewCallsIdle();
    // The reply of the host to the send is held by the case until the test releases it.
    wire.deliverNotice();
    await drained();
    assert.equal(callsNamed("viewSidecarSend").length, 1, "the send did not start");
    await disposeSurface(surfaceId);
    const closed = wire.calls.length;
    wire.release();
    await viewCallsIdle();
    await flushEvents();
    assert.deepEqual({
      staleHostCalls: wire.calls.slice(closed).filter(({ name }) => name === "viewReply").map(({ name }) => name),
      reported: errors.reported,
      callCancellation: loggedEvents().filter(({ event, fields }) => event === "workbench.view.call.cancel" && fields.id === 11)
        .map(({ fields }) => ({ generation: fields.generation, id: fields.id })),
      routes: callsNamed("viewSidecarRoute").map(({ payload }) => ({ generation: payload.generation, id: payload.id, on: payload.on })),
    }, {
      staleHostCalls: [], reported: [], callCancellation: [{ generation: 1, id: 11 }],
      routes: [{ generation: 1, id: "probe", on: true }, { generation: 1, id: "probe", on: false }],
    });
    await end();
  } finally {
    errors.restore();
    logGate.set(ERRORS_ONLY);
    dom.window.close();
  }
});

test("a page-start view waits for the initial project context and a disposed preview cannot declare composition", { timeout: 5000 }, async () => {
  wire = selectPageWire("surface-view-initial-project-context");
  const dom = openDocument("<main><div id=slot></div></main>", "http://localhost/?project=prj-startup");
  // The window of the page: the address and the history that the project list reads and writes.
  const errors = collectPageErrors(dom);
  const previousLocation = globalThis.location;
  const previousHistory = globalThis.history;
  globalThis.location = dom.window.location;
  globalThis.history = dom.window.history;
  const projects = await import("../projects.js");
  const { HostWorkspaceStore } = await import("../host-store.js");
  const { connectSettings } = await import("../settings.js");
  const layout = { state: { cards: [], name: "startup" } };
  const PROJECT = {
    id: "prj-startup", root: "/work/startup", identity: "1:1", title: "startup", color: "#fff", named: 1,
    activeSpaceId: "spc-startup", spaces: [{ id: "spc-startup", title: "SPACE1", layout }], settings: {},
  };
  // The plane of the window, which the project list calls when it draws, saves and clears a layout.
  projects.onSwitch({
    check: () => {}, save: () => layout, load: () => {}, update: () => {}, retain: async () => {},
    presented: async () => {}, empty: async () => {}, settleTabs: async () => true,
  });
  const { mountSurface, authorizeSurface, disposeSurface, waitSurfaceCompositionDeclared } = await import("../surface-modules.js?initial-project-context");
  const pluginId = "fixture-initial-project-context";
  const disposedId = "fixture-initial-project-context-disposed";
  const currentId = "fixture-initial-project-context-current";
  recordOrigin(disposedId, null, "test fixture");
  recordOrigin(currentId, null, "test fixture");
  registerPlugin({ id: pluginId, surface: () => null });
  let obsoleteMount;
  let currentMount;
  let initialising;
  try {
    // The first screen is drawn from the project of the address, so the context of the project is pending until the host shows it.
    projects.begin({ common: {}, projects: [PROJECT], open: [] });
    seedSourceOrigins({ floor: 1, views: { [disposedId]: 1, [currentId]: 1 } });
    authorizeSurface(disposedId);
    obsoleteMount = mountSurface(document.querySelector("#slot"), viewSurface(disposedId, pluginId));

    await disposeSurface(disposedId);
    authorizeSurface(currentId);
    currentMount = mountSurface(document.querySelector("#slot"), viewSurface(currentId, pluginId));
    // The start of the project list shows the project; the case holds the reply of projectShown, which commits the project root.
    const store = new HostWorkspaceStore(host);
    await connectSettings(store);
    initialising = projects.initialise(store);
    // The mount runs in microtasks until it waits for the project context, so after the end of the microtask queue a mount that
    // did not wait for it has declared its composition.
    await drained();
    assert.equal(callsNamed("projectShown").length, 1, "the project list did not reach projectShown");
    assert.equal(callsNamed("compositionDeclare").length, 0,
      "the startup preview declared native composition before projectShown committed the project root");
    wire.release();
    await initialising;
    await obsoleteMount;
    await currentMount;
    await waitSurfaceCompositionDeclared(currentId);
    assert.deepEqual(callsNamed("compositionDeclare").map(({ payload }) => payload.plugin), [pluginId],
      "a disposed first-layout preview declared composition after projectShown");
    assert.deepEqual(errors.reported, []);
    await disposeSurface(currentId);
    await end();
  } finally {
    errors.restore();
    if (initialising) await initialising.catch(() => {});
    if (obsoleteMount) await obsoleteMount.catch(() => {});
    if (currentMount) await currentMount.catch(() => {});
    globalThis.location = previousLocation;
    globalThis.history = previousHistory;
    dom.window.close();
  }
});
