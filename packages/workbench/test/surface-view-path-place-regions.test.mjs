// The view path of a surface over the page wire: the tab state and the tab reports that a view calls, the composition place and the
// sidecar sends of a view that a place leaves out, the release of a view and the authorization that gates the composition
// declaration of a view. The host calls of each test are answered by its page-wire case (docs/spec/cases/page-wire/README.md), and the
// case delivers each view call to the view-call listener of the surface as a notice (docs/spec/native-surfaces.md#view-surfaces). A test
// selects its case before it imports a module that imports host.js, because host.js reads the host when it is imported.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { host, selectPageWire } from "@soksak/runtime";
import { pageIdentity } from "../page-identity.js";
import { drained } from "./support/drained.mjs";

let wire = selectPageWire("surface-view-path-place-regions");
const { registerPlugin } = await import("../registry.js");
const { endSourceOrigin, registerSourceOrigin, seedSourceOrigins } = await import("../source-origins.js");
const { setSurfaceTextSize } = await import("../text-size.js");
const { HostWorkspaceStore } = await import("../host-store.js");
const { flushEvents } = await import("../page-log.js");
const { endNoticesWriter } = await import("../notices-file.js");
const { documentRegions } = await import("../document-regions.js");
const { registry } = await import("../exposure.js");
// The core declarations, as the sibling tests declare them, so the elements of the page bind their commands.
registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
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
  // The notice writer ends with its test, so no later test's change reaches this case's wire.
  // The page sends the events of the test before its case ends, so the close flushes them first and ends the notice writer with the test.
  return { modules, viewCall, slot: document.querySelector("#slot"), close: async () => { await flushEvents(); endNoticesWriter(); dom.window.close(); } };
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
  await h.close();
  wire.finish();
});
