// The view path of a surface over the page wire: the tab state and the tab reports that a view calls, the composition place and the
// sidecar sends of a view that a place leaves out, the release of a view and the authorization that gates the composition
// declaration of a view. The host calls of each test are answered by its page-wire case (docs/spec/cases/page-wire/README.md), and the
// case delivers each view call to the view-call listener of the surface as a notice (docs/spec/native-surfaces.md#view-surfaces). A test
// selects its case before it imports a module that imports host.js, because host.js reads the host when it is imported.
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { host, selectPageWire } from "@soksak/runtime";
import { pageIdentity } from "../page-identity.js";
import { drained } from "./support/drained.mjs";

let wire = selectPageWire("surface-view-path-tab-state");
const { registerPlugin } = await import("../registry.js");
const { endSourceOrigin, registerSourceOrigin, seedSourceOrigins } = await import("../source-origins.js");
const { setSurfaceTextSize } = await import("../text-size.js");
const { HostWorkspaceStore } = await import("../host-store.js");
const { flushEvents } = await import("../page-log.js");
const { documentRegions } = await import("../document-regions.js");
const { registry } = await import("../exposure.js");
const reports = await import("../tab-reports.js");
const projects = await import("../projects.js");

const UNLOAD = { format: 2, maxBytes: 64 };
for (const id of ["fixture-unload", "fixture-plain"]) registerPlugin({ id, surface: () => null });
setSurfaceTextSize(() => 1);
// projects.initialise reads the project parameter of the address of the window.
globalThis.location = new URL("http://soksak.test/index.html");

/**
 * The tab state store of the memory saver, which projects.initialise opens over the host store; the plugin fixture-unload declares
 * surface.unload. The test flushes the store before it ends, so no write remains for the timer of the store.
 */
async function openTabStateStore() {
  await projects.initialise(new HostWorkspaceStore(host), (plugin) => (plugin === "fixture-unload" ? UNLOAD : false));
  return projects.tabStateStore();
}

let instance = 0;
/** Mounts the views of a surface module of its own over the selected case; viewCall plays the next notice of the case and returns the reply of the view. */
async function harness() {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  const modules = await import(`../surface-modules.js?view-path-${++instance}`);
  // Plays the next view call of the case and resolves with the reply that the view receives. The calls of these tests run in microtasks,
  // so after the end of the microtask queue the reply has reached the wire.
  const viewCall = async () => {
    const before = wire.calls.length;
    wire.deliverNotice();
    await drained();
    const reply = wire.calls.slice(before).find(({ name }) => name === "viewReply");
    assert.ok(reply, "the view call was not answered");
    return reply.payload;
  };
  return { modules, viewCall, slot: document.querySelector("#slot"), close: () => dom.window.close() };
}

const expectedReply = (surface, id, result, generation = 1) => ({ id, result, page: pageIdentity, generation, surface });
const names = () => wire.calls.map(({ name }) => name);

const declarations = { status: [], commands: [], element: [] };
const viewOf = (surfaceId, pluginId, unload) => ({
  surfaceId, pluginId, declarations, sidecars: [], unload,
  composition: { kind: "view", page: "ui/page.html", regions: [], overlays: [] },
});

/** Mounts the view id of pluginId on the harness h and waits for its composition declaration. */
async function mountView(h, id, pluginId = "fixture-plain", unload = false) {
  reports.recordOrigin(id, null, "test fixture");
  seedSourceOrigins({ floor: 1, views: { [id]: 1 } });
  h.modules.authorizeSurface(id);
  await h.modules.mountSurface(h.slot, viewOf(id, pluginId, unload));
  await h.modules.waitSurfaceCompositionDeclared(id);
}

test("a declaring view writes its tab state and reads it back, and refusals name the tab", { timeout: 5000 }, async () => {
  const store = await openTabStateStore();
  const h = await harness();
  const id = "view-state-a";
  await mountView(h, id, "fixture-unload", UNLOAD);
  // tab.state.read
  assert.deepEqual(await h.viewCall(), expectedReply(id, 1, null));
  // tab.state.write {page: 3}
  assert.deepEqual(await h.viewCall(), expectedReply(id, 2, null));
  assert.deepEqual(store.entry(id).state, { format: 2, value: { page: 3 } });
  // tab.state.read
  assert.deepEqual(await h.viewCall(), expectedReply(id, 3, { page: 3 }));
  // tab.state.write {text: 100 characters}
  assert.deepEqual((await h.viewCall()).error,
    { code: -32000, message: `tab ${id} state of 111 bytes exceeds 64` });
  // tab.state.write without a value
  assert.deepEqual((await h.viewCall()).error,
    { code: -32000, message: `tab ${id} state is not JSON: undefined` });
  store.write(id, { format: 1, value: {} });
  // tab.state.read
  assert.deepEqual((await h.viewCall()).error,
    { code: -32000, message: `tab ${id} state format 1 is not 2` });
  await h.modules.disposeSurface(id);
  await store.flush();
  h.close();
  wire.finish();
});

test("a view whose plugin does not declare surface.unload has no tab state", { timeout: 5000 }, async () => {
  wire = selectPageWire("surface-view-path-no-tab-state");
  const h = await harness();
  const id = "view-state-plain";
  await mountView(h, id);
  // tab.state.read
  assert.deepEqual((await h.viewCall()).error,
    { code: -32000, message: "view call tab.state.read: the tab state is not declared" });
  await h.modules.disposeSurface(id);
  h.close();
  wire.finish();
});

test("the tab reports of a view set its title, its modified mark and its error", { timeout: 5000 }, async () => {
  wire = selectPageWire("surface-view-path-tab-reports");
  const h = await harness();
  const id = "view-report-a";
  await mountView(h, id);
  // tab.title "Notes"
  assert.deepEqual(await h.viewCall(), expectedReply(id, 1, null));
  assert.equal(reports.tabLabel(id), "Notes");
  // tab.modified true
  assert.deepEqual(await h.viewCall(), expectedReply(id, 2, null));
  assert.equal(reports.tabModified(id), true);
  // tab.error "disk full"
  assert.deepEqual(await h.viewCall(), expectedReply(id, 3, null));
  assert.equal(reports.tabError(id), "disk full");
  await h.modules.disposeSurface(id);
  h.close();
  wire.finish();
});

test("keep busy of a view protects its tab until an unload dispose, and keep modified follows the modified report", { timeout: 5000 }, async () => {
  wire = selectPageWire("surface-view-path-keep");
  const h = await harness();
  const id = "view-keep";
  await mountView(h, id);
  // tab.keep {reason: "busy", on: true}
  await h.viewCall();
  // tab.modified true
  await h.viewCall();
  assert.deepEqual(reports.tabKeeps(id), ["keep:modified", "keep:busy"]);
  // tab.keep {reason: "busy", on: false}
  await h.viewCall();
  assert.deepEqual(reports.tabKeeps(id), ["keep:modified"]);
  // tab.keep {reason: "busy", on: true}
  await h.viewCall();
  // tab.keep {reason: "other", on: true}
  assert.deepEqual((await h.viewCall()).error,
    { code: -32000, message: "unknown keep reason: other" });
  // tab.keep {reason: "busy", on: 1}
  assert.deepEqual((await h.viewCall()).error,
    { code: -32000, message: "keep busy must be true or false" });
  await h.modules.disposeSurface(id, { mode: "unload" });
  assert.deepEqual(reports.tabKeeps(id), ["keep:modified"], "an unload dispose kept the busy protection or dropped the modified one");
  reports.reportModified(id, false);
  h.close();
  wire.finish();
});

test("an unload dispose keeps the tab reports of a view except its error, and a close forgets them", { timeout: 5000 }, async () => {
  wire = selectPageWire("surface-view-path-report-disposal");
  const h = await harness();
  for (const [id, mode] of [["view-unload-reports", "unload"], ["view-close-reports", undefined]]) {
    await mountView(h, id);
    // tab.title "Doc"
    await h.viewCall();
    // tab.footer "foot"
    await h.viewCall();
    // tab.notify {text: "done"}
    await h.viewCall();
    // tab.error "failed"
    await h.viewCall();
    await h.modules.disposeSurface(id, mode === undefined ? undefined : { mode });
  }
  assert.deepEqual([reports.tabLabel("view-unload-reports"), reports.tabFooter("view-unload-reports"),
    reports.tabNotice("view-unload-reports"), reports.tabError("view-unload-reports")], ["Doc", "foot", "done", null]);
  assert.deepEqual(reports.tabOrigin("view-unload-reports"), { directory: null });
  assert.deepEqual([reports.tabLabel("view-close-reports"), reports.tabFooter("view-close-reports"),
    reports.tabNotice("view-close-reports"), reports.tabError("view-close-reports")], [null, null, null, null]);
  await assert.rejects(h.modules.disposeSurface("view-unload-reports", { mode: "other" }), /unknown dispose mode: other/);
  h.close();
  wire.finish();
});

test("a title report of a declaring view writes the label cache, and a removed title removes it", { timeout: 5000 }, async () => {
  wire = selectPageWire("surface-view-path-label-cache");
  const store = await openTabStateStore();
  const h = await harness();
  const id = "view-label-cache";
  await mountView(h, id, "fixture-unload", UNLOAD);
  // tab.title "Cached"
  await h.viewCall();
  assert.equal(store.label(id), "Cached");
  // tab.title null
  await h.viewCall();
  assert.equal(store.label(id), null);
  await h.modules.disposeSurface(id);
  await store.flush();
  h.close();
  wire.finish();
});

test("a tab state write that a view sent before its dispose and that runs after it is not answered and stores nothing", { timeout: 5000 }, async (t) => {
  wire = selectPageWire("surface-view-path-state-disposed");
  const store = await openTabStateStore();
  const h = await harness();
  const id = "view-state-disposed";
  const reported = [];
  const originalDispatchEvent = globalThis.dispatchEvent;
  globalThis.dispatchEvent = (event) => { reported.push(event.message); return true; };
  t.after(() => { globalThis.dispatchEvent = originalDispatchEvent; });
  await mountView(h, id, "fixture-unload", UNLOAD);
  // tab.state.write {page: 1}
  await h.viewCall();
  // The write of a declaring view waits for the tab state store, so it runs after the dispose that starts at once. The call is the
  // second notice of the case, with the id 2.
  wire.deliverNotice();
  await h.modules.disposeSurface(id, { mode: "unload" });
  await h.modules.viewCallsIdle();
  assert.deepEqual(wire.calls.filter(({ name, payload }) => name === "viewReply" && payload.id === 2), [],
    "a write that runs after the dispose was answered");
  assert.deepEqual(store.entry(id).state, { format: 2, value: { page: 1 } });
  assert.deepEqual(reported, [], "the write reached the tab state of the disposed view");
  await store.flush();
  h.close();
  wire.finish();
});

test("the composition of a view places nothing while a place that leaves the view out runs", { timeout: 5000 }, async () => {
  wire = selectPageWire("surface-view-path-place-composition");
  const h = await harness();
  const id = "view-place-a";
  await mountView(h, id);
  const placed = wire.calls.filter((call) => call.name === "compositionPlace").length;
  await h.modules.placeSurfaces(async () => {
    // The view runs a placement while the place that leaves it out is running: the placement is not sent. The call is composition.place
    // {regions: [], overlays: []}.
    await h.viewCall();
    assert.equal(wire.calls.filter((call) => call.name === "compositionPlace").length, placed, "a placement was sent while the place runs");
    return null;
  }, { retain: new Set() });
  await h.modules.disposeSurface(id);
  h.close();
  wire.finish();
});

test("a region query of a view that a running place leaves out waits for the place and asks no region of a released view", { timeout: 5000 }, async () => {
  wire = selectPageWire("surface-view-path-place-regions");
  const h = await harness();
  const id = "view-place-regions";
  await mountView(h, id);
  documentRegions.attached(id, "page");
  let interaction;
  let reasons;
  await h.modules.placeSurfaces(async () => {
    // The host closes the regions of the left-out view before its reply, so a query that starts now must not reach them.
    interaction = documentRegions.interaction(id);
    reasons = documentRegions.reasons(id);
    return null;
  }, { retain: new Set() });
  assert.equal(await interaction, undefined);
  assert.deepEqual(await reasons, []);
  assert.deepEqual(names(), ["compositionDeclare"], "a region query reached the regions of a released view or ran while the place ran");
  await h.modules.disposeSurface(id);
  h.close();
  wire.finish();
});

test("a region query of a view waits for a failed place that left the view out and then asks its regions", { timeout: 5000 }, async () => {
  wire = selectPageWire("surface-view-path-failed-place-regions");
  const h = await harness();
  const id = "view-failed-place-regions";
  await mountView(h, id);
  documentRegions.attached(id, "page");
  const failure = new Error("fixture placement rejected");
  let interaction;
  let callsAtPlaceEnd;
  await assert.rejects(h.modules.placeSurfaces(async () => {
    interaction = documentRegions.interaction(id);
    // The calls that reached the host when the place ends: a query that reached the host during the place is listed before it.
    callsAtPlaceEnd = names();
    throw failure;
  }, { retain: new Set() }), (error) => error === failure);
  // A failed place keeps the view and its regions, so the waiting query reads them.
  assert.deepEqual(await interaction, { page: "AAAA" });
  assert.deepEqual(callsAtPlaceEnd, ["compositionDeclare"], "a region query reached the host while the place that closes the region runs");
  assert.deepEqual(names(), ["compositionDeclare", "documentInteractionState"]);
  await h.modules.disposeSurface(id);
  h.close();
  wire.finish();
});

test("a sidecar send of a view waits for a failed place that leaves the view out, and a place that releases the view sends none", { timeout: 5000 }, async () => {
  wire = selectPageWire("surface-view-path-place-sidecar");
  const h = await harness();
  const id = "view-place-sidecar";
  reports.recordOrigin(id, null, "test fixture");
  seedSourceOrigins({ floor: 1, views: { [id]: 1 } });
  h.modules.authorizeSurface(id);
  await h.modules.mountSurface(h.slot, { ...viewOf(id, "fixture-plain", false), sidecars: ["fixture-sidecar"] });
  await h.modules.waitSurfaceCompositionDeclared(id);
  let callsAtPlaceEnd;
  await assert.rejects(h.modules.placeSurfaces(async () => {
    // The first view call of the case is runtime.sidecar.send of the body {op: "input"}, which the place holds.
    wire.deliverNotice();
    // The calls that reached the host when the place ends: a send that left during the place is listed before it.
    callsAtPlaceEnd = names();
    throw new Error("host.place refused the layout");
  }, { retain: new Set() }), /host.place refused the layout/);
  await drained();
  const reply = wire.calls.find(({ name }) => name === "viewReply");
  assert.ok(reply, "the held send was not answered after the failed place");
  assert.equal(reply.payload.error, undefined, "the held send was refused after the failed place");
  const sends = () => wire.calls.filter(({ name }) => name === "viewSidecarSend").map(({ payload }) => payload.body.op);
  assert.deepEqual(sends(), ["input"]);
  assert.deepEqual(callsAtPlaceEnd, ["compositionDeclare"], "a sidecar send left while the place ran");
  // The place ends the sidecar sessions of the view that it leaves out, so a send held by that place is not sent after it.
  assert.equal(await h.modules.placeSurfaces(async () => {
    // The second view call of the case is runtime.sidecar.send of the body {op: "end"}.
    wire.deliverNotice();
    return "placed";
  }, { retain: new Set() }), "placed");
  // The held send ends cancelled, without a reply, when the place releases the view: viewCallsIdle waits for that end.
  await h.modules.viewCallsIdle();
  assert.equal(h.modules.mountedSurface(id), null);
  assert.deepEqual(sends(), ["input"], "a send reached the sidecar after the place ended its sessions");
  h.close();
  wire.finish();
});

test("a view mount that a dispose ends before its authorization resolves null and declares no composition", { timeout: 5000 }, async () => {
  wire = selectPageWire("surface-view-path-dispose-before-authorization");
  const h = await harness();
  const id = "view-dispose-before-authorization";
  reports.recordOrigin(id, null, "test fixture");
  seedSourceOrigins({ floor: 1, views: { [id]: 1 } });
  // The mount puts the element of the surface into the slot before it waits for its authorization; the dispose follows that insertion.
  const inserted = new Promise((resolve) => {
    const observer = new h.slot.ownerDocument.defaultView.MutationObserver(() => {
      if (!h.slot.querySelector(`[data-surface="${id}"]`)) return;
      observer.disconnect();
      resolve();
    });
    observer.observe(h.slot, { childList: true, subtree: true });
  });
  const mounting = h.modules.mountSurface(h.slot, viewOf(id, "fixture-plain", false));
  await inserted;
  await h.modules.disposeSurface(id);
  assert.equal(h.slot.querySelector(`[data-surface="${id}"]`), null, "the surface was not removed before its authorization");
  // The mount ends only by its resolution, so the resolution is the event that the check waits for.
  const outcome = await mounting.then((value) => ({ value }), (error) => ({ error: error.message }));
  assert.deepEqual(outcome, { value: null }, "the mount that the dispose ended did not resolve");
  // The resolution of the mount ends the only path that declares its composition, and the dispose dropped the authorization gate
  // that the mount waited for, so the authorization after it reaches no mount.
  h.modules.authorizeSurface(id);
  await drained();
  assert.equal(wire.calls.filter(({ name }) => name === "compositionDeclare").length, 0, "a disposed mount declared its composition");
  h.close();
  wire.finish();
});

test("a view declares its composition only after the host authorizes its surface", { timeout: 5000 }, async () => {
  wire = selectPageWire("surface-view-path-authorization");
  const h = await harness();
  const { mountSurface, authorizeSurface, disposeSurface, waitSurfaceCompositionDeclared } = h.modules;
  const id = "view-auth-a";
  reports.recordOrigin(id, null, "test fixture");
  seedSourceOrigins({ floor: 1, views: { [id]: 1 } });
  const mounted = mountSurface(h.slot, viewOf(id, "fixture-plain", false));
  await drained();
  const authorizedAt = wire.calls.length;
  authorizeSurface(id);
  await mounted;
  await waitSurfaceCompositionDeclared(id);
  assert.equal(wire.calls.slice(0, authorizedAt).filter((call) => call.name === "compositionDeclare").length, 0, "the view declared before authorization");
  assert.equal(wire.calls.filter((call) => call.name === "compositionDeclare").length, 1);
  await disposeSurface(id);
  h.close();
  wire.finish();
});

test("a remounted view sends a higher composition revision in the same document", { timeout: 5000 }, async () => {
  wire = selectPageWire("surface-view-path-remounted-revision");
  const h = await harness();
  const { mountSurface, authorizeSurface, disposeSurface, waitSurfaceCompositionDeclared } = h.modules;
  const id = "view-remounted-revision";
  try {
    for (const generation of [1, 2]) {
      reports.recordOrigin(id, null, "test fixture");
      seedSourceOrigins({ floor: generation, views: { [id]: generation } });
      authorizeSurface(id);
      await mountSurface(h.slot, viewOf(id, "fixture-plain", false));
      await waitSurfaceCompositionDeclared(id);
      // composition.place {regions: [], overlays: []} of the generation
      const reply = await h.viewCall();
      assert.equal(reply.error, undefined, "the placement of the current view was refused");
      assert.equal(reply.generation, generation, "the placement reply belongs to another view generation");
      await disposeSurface(id);
    }
    const revisions = wire.calls.filter(({ name }) => name === "compositionPlace").map(({ payload }) => payload.revision);
    assert.equal(revisions.length, 2, "both view generations must send their placement");
    assert.ok(Number.isInteger(revisions[0]) && revisions[0] > 0, "the first placement needs a positive revision");
    assert.ok(revisions[1] > revisions[0], `a remounted view reused a composition revision: ${revisions.join(", ")}`);
  } finally {
    await disposeSurface(id);
    h.close();
  }
  wire.finish();
});

test("a mount of a view waits for a pending dispose of the same tab and creates a new surface", { timeout: 5000 }, async () => {
  wire = selectPageWire("surface-view-path-remount-pending-dispose");
  const h = await harness();
  const id = "view-remount-pending-dispose";
  await mountView(h, id);
  const first = h.modules.mountedSurface(id);
  const disposing = h.modules.disposeSurface(id, { mode: "unload" });
  const remounting = h.modules.mountSurface(h.slot, viewOf(id, "fixture-plain", false));
  await disposing;
  h.modules.authorizeSurface(id);
  await remounting;
  const second = h.modules.mountedSurface(id);
  assert.notEqual(second, null, "the mount after the pending dispose left no mounted surface");
  assert.notEqual(second, first, "the mount reused the surface that the dispose released");
  assert.equal(second.disposed, false);
  assert.equal(second.closing.signal.aborted, false);
  assert.equal(h.slot.querySelectorAll(`[data-surface="${id}"]`).length, 1);
  await h.modules.disposeSurface(id);
  h.close();
  wire.finish();
});

test("each view mount reports its end to the mount listeners, with the error of a failed mount", { timeout: 5000 }, async () => {
  // The host refuses the composition declaration of the second view, and the page records the failed mount as an error event.
  wire = selectPageWire("surface-view-path-mount-end");
  const h = await harness();
  const ended = [];
  const off = h.modules.onSurfaceMounted((id, error) => ended.push([id, error?.message ?? null]));
  await mountView(h, "view-mount-ok");
  const failed = "view-mount-refused";
  reports.recordOrigin(failed, null, "test fixture");
  seedSourceOrigins({ floor: 1, views: { [failed]: 1 } });
  h.modules.authorizeSurface(failed);
  await assert.rejects(h.modules.mountSurface(h.slot, viewOf(failed, "fixture-plain", false)), /the host refused compositionDeclare/);
  off();
  assert.deepEqual(ended, [["view-mount-ok", null], [failed, "the host refused compositionDeclare"]]);
  await h.modules.disposeSurface("view-mount-ok");
  await h.modules.disposeSurface(failed);
  await flushEvents();
  h.close();
  wire.finish();
});

test("a later retained mount waits for the preceding placement release", { timeout: 5000 }, async () => {
  wire = selectPageWire("surface-view-path-retained-placement-order");
  const h = await harness();
  const { mountSurface, authorizeSurface, disposeSurface, mountedSurface, placeSurfaces } = h.modules;
  const id = "view-retained-placement-order";
  reports.recordOrigin(id, null, "test fixture");
  seedSourceOrigins({ floor: 1, views: { [id]: 1 } });
  let release, entered;
  const held = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const order = [];
  const previous = placeSurfaces(async () => {
    entered();
    await held;
    order.push("previous placed");
  }, { retain: new Set() });
  await started;
  const next = placeSurfaces(async () => {
    order.push("next prepare");
    authorizeSurface(id);
    await mountSurface(h.slot, viewOf(id, "fixture-plain", false));
  }, { retain: new Set([id]) });
  try {
    release();
    await Promise.all([previous, next]);
    assert.deepEqual(order, ["previous placed", "next prepare"]);
    assert.equal(mountedSurface(id)?.disposed, false,
      "the preceding placement released the retained mount prepared by its successor");
  } finally {
    release();
    await Promise.allSettled([previous, next]);
    await disposeSurface(id);
    h.close();
  }
  wire.finish();
});

test("a rejected placement reports its error and allows the next placement", { timeout: 5000 }, async () => {
  wire = selectPageWire("surface-view-path-rejected-placement");
  const h = await harness();
  const failure = new Error("fixture placement rejected");
  const rejected = h.modules.placeSurfaces(async () => { throw failure; }, { retain: new Set() });
  const following = h.modules.placeSurfaces(async () => "next placed", { retain: new Set() });
  try {
    await assert.rejects(rejected, (error) => error === failure);
    assert.equal(await following, "next placed");
  } finally {
    await Promise.allSettled([rejected, following]);
    h.close();
  }
  wire.finish();
});

test("a replacement view registers its command once in its own source generation", { timeout: 5000 }, async () => {
  wire = selectPageWire("surface-view-path-restarted-command");
  const h = await harness();
  const id = "view-restarted-command";
  const command = "fixture-plain.run";
  registry.declare("fixture-plain", { status: [], commands: [{ name: command, description: "Runs the fixture command.", params: { type: "object" }, result: { type: "null" } }], element: [] });
  registry.configure({ surfacePlugin: (surface) => (surface === id ? "fixture-plain" : null) });
  reports.recordOrigin(id, null, "test fixture");
  seedSourceOrigins({ floor: 1, views: { [id]: 1 } });
  h.modules.authorizeSurface(id);
  await h.modules.mountSurface(h.slot, { ...viewOf(id, "fixture-plain", false),
    declarations: { status: [], commands: [{ name: command, description: "Runs the fixture command.", params: { type: "object" }, result: { type: "null" } }], element: [] },
  });
  try {
    // runtime.command.register {name}
    assert.deepEqual(await h.viewCall(), expectedReply(id, 1, null));
    assert.deepEqual(registry.registrants("command", command), [id], "the command was not registered");
    // runtime.command.register {name}
    assert.match((await h.viewCall()).error.message, /already registered/);
    assert.equal(endSourceOrigin("fixture-plain", id, 1), true);
    assert.deepEqual(registry.registrants("command", command), [], "the end of the source generation left the registration of the command");
    assert.equal(registerSourceOrigin("fixture-plain", id, 2), true);
    // runtime.command.register {name} of the generation 2
    assert.deepEqual(await h.viewCall(), expectedReply(id, 3, null, 2));
    assert.deepEqual(registry.registrants("command", command), [id],
      "the replacement did not restore the command's public registration");
    // runtime.command.register {name} of the generation 2
    assert.match((await h.viewCall()).error.message, /already registered/);
  } finally {
    registry.configure({ surfacePlugin: () => null });
    await h.modules.disposeSurface(id);
    h.close();
  }
  wire.finish();
});

test("a failed view command registration returns its declaration error", { timeout: 5000 }, async () => {
  wire = selectPageWire("surface-view-path-invalid-command-registration");
  const h = await harness();
  const id = "view-invalid-command-registration";
  reports.recordOrigin(id, null, "test fixture");
  seedSourceOrigins({ floor: 1, views: { [id]: 1 } });
  h.modules.authorizeSurface(id);
  await h.modules.mountSurface(h.slot, viewOf(id, "fixture-plain", false));
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      // runtime.command.register {name: "fixture-plain.undeclared"}
      const reply = await h.viewCall();
      assert.match(reply.error?.message ?? "registration incorrectly succeeded", /not declared/);
    }
  } finally {
    await h.modules.disposeSurface(id);
    await flushEvents();
    h.close();
  }
  wire.finish();
});
