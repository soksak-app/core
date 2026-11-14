// Checks the answers of the workbench to the call requests of a view (docs/spec/native-surfaces.md#view-surfaces). A test mounts a view
// surface with the real surface modules, and the case that it selects (docs/spec/cases/page-wire/README.md) delivers each call of the
// view to the view-call listener of the surface as a notice and answers the host calls of the page. The reply of the page to each
// call reaches the host as the call viewReply, which the test reads.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { host, selectPageWire } from "@soksak/runtime";
import { viewStopState } from "../view-calls.js";
import { pageIdentity } from "../page-identity.js";
import { drained } from "./support/drained.mjs";

// The host is read when host.js is imported, so the case of the import is selected first; the page sends no call while it imports.
const importing = selectPageWire("view-calls-import");
const { registerPlugin } = await import("../registry.js");
const { seedSourceOrigins } = await import("../source-origins.js");
const { notifyTextSize, setSurfaceTextSize } = await import("../text-size.js");
const { contributionsOf, contributionsState, installContributions } = await import("../contributions.js");
const { beginSettings, setPluginSettings } = await import("../settings.js");
const { logGate } = await import("../log-gate.js");
const reports = await import("../tab-reports.js");
const { HostWorkspaceStore } = await import("../host-store.js");
const projects = await import("../projects.js");

setSurfaceTextSize(() => 1);
// The plugin probe declares surface.menu, and the plugin probe-bare declares none (null, as the declaration of a plugin without it).
registerPlugin({ id: "probe", surface: () => null, menu: [{ label: "Run", command: "probe.run" }] });
registerPlugin({ id: "probe-bare", surface: () => null, menu: null });
registerPlugin({ id: "fixture-unload", surface: () => null });
setPluginSettings([{ id: "probe", settings: { home: { label: "홈 주소", type: "address", default: "https://example.test" } } }]);
globalThis.location = new URL("http://soksak.test/index.html");
// The first flush of the events of the page reads the clock of the host, which belongs to the start of the page and not to a test.
const { flushEvents, recordWorkbenchStart } = await import("../page-log.js");
recordWorkbenchStart({ href: "http://soksak.test/index.html" }, 0);
await flushEvents();
importing.finish();

const UNLOAD = { format: 2, maxBytes: 64 };

// The registry of the window holds the declarations of the core (exposure.json) and of the plugin probe. The surfaces of the window that a
// test registers belong to the plugin probe through the table of data that the registry reads (owners), and the applied frame of a
// surface through the table frames, as the layout of the window gives them.
const { registry } = await import("../exposure.js");
const { declareProjectData } = await import("../plugin-data.js");
registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
const probeExposes = {
  status: [
    { name: "probe.lines", description: "Lines.", schema: { type: "array" } },
    { name: "probe.count", description: "Count.", schema: { type: "integer" } },
    { name: "probe.state", description: "State.", schema: {} },
  ],
  commands: [{ name: "probe.run", description: "Runs.", params: { type: "object" }, result: {} }],
  element: [{ name: "probe.view", description: "View." }],
};
registry.declare("probe", probeExposes);
declareProjectData("probe", { note: { schema: { type: "string" }, default: "default" } });
const owners = new Map();
const frames = new Map();
const preferredSurfaces = [];
registry.configure({ surfacePlugin: (surface) => owners.get(surface) ?? null, preferred: () => preferredSurfaces, surfaceFrame: (surface) => frames.get(surface) ?? null });
// The core commands that the tests run. A core command is registered by the module that owns it; these record the params that they receive.
const ran = { core: [] };
const failing = new Set();
for (const name of ["core.tab.select", "core.library.search.focus", "core.surface.menu"]) {
  registry.command(name, async (params, context) => {
    ran.core.push({ name, params, cids: context?.cids });
    if (failing.has(name)) throw new Error("no focus target");
    return null;
  });
}
// The core status core.grid holds a value that its module changes; the listeners are the watches of the document.
const grid = { value: null, listeners: new Set() };
registry.status("core.grid", () => grid.value, (listener) => {
  grid.listeners.add(listener);
  return () => grid.listeners.delete(listener);
});
const setGrid = (value) => {
  grid.value = value;
  for (const listener of [...grid.listeners]) listener(value);
};

/** Registers the surfaces of the plugin probe in the registry for the entries, as the surface pages of the window do; returns the function that ends them. */
function holdSurfaces(...entries) {
  for (const [surface, kind, name] of entries) {
    owners.set(surface, "probe");
    registry.registered({ surface, kind, name });
  }
  return () => {
    for (const surface of new Set(entries.map(([entry]) => entry))) {
      registry.registered({ surface, closed: true });
      owners.delete(surface);
    }
  };
}

/** The tab state store of the memory saver, which projects.initialise opens over the host store; the plugin fixture-unload declares surface.unload. */
async function openTabStateStore() {
  await projects.initialise(new HostWorkspaceStore(host), (plugin) => (plugin === "fixture-unload" ? UNLOAD : false));
  return projects.tabStateStore();
}

let wire;
let instance = 0;
// The surfaces of the plugin probe declare what the plugin declares.
const declarations = probeExposes;

/**
 * Mounts the view surface id of the plugin probe, which declares the sidecar fixture-sidecar, over the case of the name. store opens the project store of the window, which the document regions read their session from. unload makes the
 * plugin declare the tab state; project places the start values of the view with that project, as the placement of the window does,
 * and opens the project store of the window over the case.
 */
async function mountView(name, { id = "probe-surface", plugin = "probe", unload = false, project, regions = [], store: opensStore = false } = {}) {
  wire = selectPageWire(`view-calls-${name}`);
  const store = unload || project !== undefined || opensStore ? await openTabStateStore() : null;
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  const modules = await import(`../surface-modules.js?view-calls-${++instance}`);
  const mounted = [];
  const origins = {};
  // Mounts one more view of the case, which is answered by the same module instance.
  const mount = async (surfaceId, surfacePlugin, startProject) => {
    reports.recordOrigin(surfaceId, null, "test fixture");
    origins[surfaceId] = 1;
    seedSourceOrigins({ floor: 1, views: { ...origins } });
    modules.authorizeSurface(surfaceId);
    const surface = { surfaceId, pluginId: surfacePlugin, declarations, sidecars: ["fixture-sidecar"], unload,
      contributions: (point) => contributionsOf(surfacePlugin, point),
      composition: { kind: "view", page: "ui/page.html", regions, overlays: [] } };
    owners.set(surfaceId, surfacePlugin);
    if (startProject !== undefined) modules.surfacePlacementsForHost([{ id: surfaceId, surface }], startProject, () => "test fixture");
    await modules.mountSurface(document.querySelector("#slot"), surface);
    await modules.waitSurfaceCompositionDeclared(surfaceId);
    mounted.push(surfaceId);
  };
  await mount(id, plugin, project);
  // Plays the next view call of the case and resolves with the reply that the view receives; the calls of these tests run in
  // microtasks, so after the end of the microtask queue the reply has reached the wire.
  const deliver = async () => {
    const before = wire.calls.length;
    wire.deliverNotice();
    await drained();
    return wire.calls.slice(before).filter(({ name }) => name === "viewReply").map(({ payload }) => {
      assert.equal(payload.page, pageIdentity);
      return payload;
    });
  };
  const call = async () => {
    const replies = await deliver();
    assert.equal(replies.length, 1, `the view call was answered ${replies.length} times`);
    return replies[0];
  };
  const after = (from) => wire.calls.slice(from).filter(({ name }) => name !== "viewReply");
  /** The calls of the page to the host since from, as [name, payload] of the calls that are not the replies of the view. */
  const sent = (from, names) => after(from).filter((entry) => names.includes(entry.name)).map(({ name, payload }) => [name, payload]);
  // The surface is mounted again after its view ended, as the restart of a view does.
  const restart = async (surfaceId = id, surfacePlugin = plugin) => {
    await modules.disposeSurface(surfaceId);
    mounted.splice(mounted.indexOf(surfaceId), 1);
    await mount(surfaceId, surfacePlugin, project);
  };
  return { call, deliver, after, sent, mount, restart, id, modules, store, close: async () => {
    for (const surfaceId of mounted) {
      await modules.disposeSurface(surfaceId);
      owners.delete(surfaceId);
    }
    if (store) await store.flush();
    await flushEvents();
    dom.window.close();
    wire.finish();
  } };
}

// The project of the start values of a view: the project that the window shows, as the placement of the window names it.
const START_PROJECT = { id: "p1", root: "/projects/p1" };
/** The project data patches that the page sent to the host since from. */
const patches = (h, from) => h.sent(from, ["workspace"]).map(([, payload]) => payload).filter(({ kind }) => kind === "patch");

// The installed plugins whose manifests give the extension point language to probe and two contributions to it. The entry 0 of
// the plugin two names a range that the point does not accept, so only its entry 1 is connected.
const plugin = (id, manifest) => ({ id, package: `@scope/plugin-${id}`, version: "0.1.0", manifest: { id, name: id, description: "검사용.", ...manifest } });
const CONTRIBUTORS = () => [
  plugin("probe", { mark: "p", icon: "<path/>", surface: { module: "ui/probe.js", composition: { kind: "dom" } },
    extends: { language: { version: "1.0.0", schema: { type: "object" } } } }),
  plugin("one", { contributes: { "probe.language": [{ range: "^1.0.0", module: "ui/one.js", name: "one" }] } }),
  plugin("two", { contributes: { "probe.language": [{ range: "^2.0.0", module: "ui/skipped.js", name: "skipped" }, { range: "^1.0.0", module: "ui/two.js", name: "two" }] } }),
];

// The regions that a view declares: a document region and an image region.
const REGIONS = [{ name: "doc", kind: "document", input: "native" }, { name: "picture", kind: "image" }];
const REGION_HOST_NAMES = ["compositionPlace", "documentAttach", "documentLoad", "documentZoom", "documentGo", "documentPost", "documentSubscribe", "documentUnsubscribe",
  "documentDetach", "imageAttach", "imageFocus", "imageCaret", "imageText", "imageDetach"];
// The host calls that the page makes for them: each carries the surface of the view and only the named fields of the call, so the field
// surface of the params of composition.place and document.attach does not reach the host.
const EXPECTED_REGION_CALLS = [
  ["compositionPlace", { revision: 1, regions: [{ name: "doc", left: 1, top: 2, right: 3, bottom: 4, visible: true }], overlays: [], surface: "probe-surface" }],
  ["documentAttach", { document: "doc", surface: "probe-surface" }],
  ["documentLoad", { document: "doc", url: "https://example.test/", surface: "probe-surface" }],
  ["documentZoom", { document: "doc", zoom: 1.5, surface: "probe-surface" }],
  ["documentGo", { document: "doc", action: "back", surface: "probe-surface" }],
  ["documentGo", { document: "doc", action: "entry", offset: -2, surface: "probe-surface" }],
  ["documentPost", { document: "doc", message: { a: 1 }, surface: "probe-surface" }],
  ["documentSubscribe", { document: "doc", stream: "elements", surface: "probe-surface" }],
  ["documentUnsubscribe", { document: "doc", handle: 3, surface: "probe-surface" }],
  ["documentDetach", { document: "doc", surface: "probe-surface" }],
  ["imageAttach", { name: "picture", sidecar: "@probe/sidecar", surface: "probe-surface" }],
  ["imageFocus", { name: "picture", surface: "probe-surface" }],
  ["imageCaret", { name: "picture", x: 1, y: 2, width: 3, height: 4, surface: "probe-surface" }],
  ["imageText", { name: "picture", text: "probe", surface: "probe-surface" }],
  ["imageDetach", { name: "picture", surface: "probe-surface" }],
];

// A binary id of the binary store of the view (docs/spec/plugin-processes.md#binary-path).
const BINARY_ID = "0123456789abcdef0123456789abcdef";

test("a status watch with a surface follows the status on that surface of the view's plugin", async () => {
  const end = holdSurfaces(["tab-a", "status", "probe.lines"], ["spc-aaaaaa/left/files.tree", "status", "probe.lines"]);
  preferredSurfaces.push("tab-a");
  const h = await mountView("status-watch-surface");
  const from = wire.calls.length;
  try {
    // runtime.status.watch {name}, runtime.status.watch {name, surface of the section} and runtime.status.unwatch of that surface
    for (let n = 0; n < 3; n += 1) assert.equal((await h.call()).result, null);
    assert.deepEqual(h.sent(from, ["exposureForward"]).map(([, forward]) => [forward.surface, forward.method, forward.params]), [
      ["tab-a", "status.watch", { name: "probe.lines" }],
      ["spc-aaaaaa/left/files.tree", "status.watch", { name: "probe.lines" }],
      ["spc-aaaaaa/left/files.tree", "status.unwatch", { name: "probe.lines" }],
    ]);
  } finally {
    preferredSurfaces.length = 0;
    end();
    await h.close();
  }
});

test("a status watch names only a surface that the window holds for the view's plugin, and otherwise runs nothing", async () => {
  const h = await mountView("status-watch-other-surface");
  const from = wire.calls.length;
  // runtime.status.watch {name: "probe.lines", surface: "other-surface"}
  assert.match((await h.call()).error.message, /view call runtime.status.watch surface other-surface is not a surface of probe/);
  assert.deepEqual(h.after(from), []);
  await h.close();
});

test("a status unwatch of a surface that the window no longer holds ends the view's own watch", async () => {
  // An unwatch ends only a watch of this view, whose surface was checked when it started; the surface can close before the view
  // unwatches it. Here the view holds a watch of the surface tab-z, which closes before the unwatch.
  const end = holdSurfaces(["tab-z", "status", "probe.lines"]);
  const h = await mountView("status-unwatch-closed-surface");
  const from = wire.calls.length;
  // runtime.status.watch {name, surface: "tab-z"}, the close of tab-z, and runtime.status.unwatch of it
  assert.equal((await h.call()).result, null);
  end();
  assert.equal((await h.call()).result, null);
  assert.deepEqual(h.sent(from, ["exposureForward"]).map(([, forward]) => [forward.surface, forward.method]), [["tab-z", "status.watch"]]);
  await h.close();
});

test("runtime.command.run runs a command of the view's plugin on a surface that the window holds for the plugin", async () => {
  const end = holdSurfaces(["tab-a", "command", "probe.run"]);
  const h = await mountView("command-run-surface");
  const from = wire.calls.length;
  try {
    // runtime.command.run {name: "probe.run", params: {x: 1}, surface: "tab-a"}
    assert.deepEqual((await h.call()).result, { owned: true });
    assert.deepEqual(h.sent(from, ["exposureForward"]).map(([, forward]) => [forward.surface, forward.method, forward.params]),
      [["tab-a", "command.run", { name: "probe.run", params: { x: 1 }, surface: "tab-a" }]]);
  } finally {
    end();
    await h.close();
  }
});

test("runtime.command.run refuses a surface that the window does not hold for the plugin and a command of another owner", async () => {
  const end = holdSurfaces(["tab-a", "command", "probe.run"]);
  const h = await mountView("command-run-refused");
  const from = wire.calls.length;
  try {
    // runtime.command.run on the surface tab-z, of the command core.tab.select, and without a surface
    assert.match((await h.call()).error.message, /^view call runtime.command.run surface tab-z is not a surface of probe$/);
    assert.match((await h.call()).error.message, /^view call runtime.command.run core.tab.select is not a command of probe$/);
    assert.match((await h.call()).error.message, /^view call runtime.command.run requires a non-empty surface$/);
    assert.deepEqual(h.after(from), []);
  } finally {
    end();
    await h.close();
  }
});

test("runtime.data.get and runtime.data.set answer for the start project of the view", async () => {
  const h = await mountView("data-get-set", { project: START_PROJECT });
  const from = wire.calls.length;
  // runtime.data.get {key: "note"}, runtime.data.set {key: "note", value: "kept"}, runtime.data.get {key: "note"}
  assert.equal((await h.call()).result, "default");
  assert.equal((await h.call()).result, null);
  assert.equal((await h.call()).result, "kept");
  assert.deepEqual(patches(h, from), [{ kind: "patch", id: "p1", patch: { plugins: { probe: { note: { format: 1, value: "kept" } } } } }]);
  await h.close();
});

// contract: project-data.replace.requires-base
test("runtime.data.replace answers for the start project of the view and requires its base", async () => {
  const h = await mountView("data-replace", { project: START_PROJECT });
  const from = wire.calls.length;
  // runtime.data.replace {key: "note", base: "default", value: "kept"}, and the same without base
  assert.equal((await h.call()).result, true);
  assert.deepEqual(patches(h, from), [{ kind: "patch", id: "p1", patch: { plugins: { probe: { note: { format: 1, value: "kept" } } } } }]);
  assert.match((await h.call()).error.message, /^view call runtime.data.replace requires base$/);
  assert.equal(patches(h, from).length, 1);
  await h.close();
});

test("runtime.data calls refuse a view whose start values carry no project, and run nothing", async () => {
  const h = await mountView("data-no-project", { project: null });
  const from = wire.calls.length;
  // runtime.data.get {key: "note"}, runtime.data.set {key: "note", value: "x"}
  assert.match((await h.call()).error.message, /view call runtime.data.get requires a project/);
  assert.match((await h.call()).error.message, /view call runtime.data.set requires a project/);
  assert.deepEqual(patches(h, from), []);
  await h.close();
});

test("runtime.data.on subscribes to the changes of the project data of the start project, and a view without project is refused", async () => {
  const h = await mountView("data-on", { project: START_PROJECT });
  await h.mount("probe-surface-none", "probe", null);
  const from = wire.calls.length;
  // runtime.data.on, a write of the key note by the view, and runtime.data.on of a second view whose start values carry no project
  assert.equal((await h.call()).result, null);
  assert.equal(h.sent(from, ["viewEvent"]).length, 0);
  assert.equal((await h.call()).result, null);
  assert.deepEqual(h.sent(from, ["viewEvent"]), [["viewEvent", { generation: 1, event: "data", data: { key: "note" }, surface: "probe-surface" }]]);
  assert.match((await h.call()).error.message, /^view call runtime.data.on requires a project$/);
  assert.equal(h.sent(from, ["viewEvent"]).length, 1);
  await h.close();
});

test("runtime.data calls refuse a key that the plugin does not declare, and a key that is not text", async () => {
  const h = await mountView("data-key-refused", { project: START_PROJECT });
  const from = wire.calls.length;
  // runtime.data.get {key: "secret"}, runtime.data.set {key: "secret", value: 1}, runtime.data.get {key: ""}
  assert.match((await h.call()).error.message, /view call runtime.data.get secret is not a data key of probe/);
  assert.match((await h.call()).error.message, /view call runtime.data.set secret is not a data key of probe/);
  assert.match((await h.call()).error.message, /view call runtime.data.get requires a non-empty key/);
  assert.deepEqual(patches(h, from), []);
  await h.close();
});

test("a forwarded tab.state.read returns the tab state of its surface", { timeout: 5000 }, async () => {
  const h = await mountView("tab-state-read", { id: "tab-view", plugin: "fixture-unload", unload: UNLOAD });
  h.store.write("tab-view", { format: 2, value: { count: 2 } });
  // tab.state.read
  assert.deepEqual((await h.call()).result, { count: 2 });
  await h.close();
});

test("tab.state.read is refused when the surface declares no tab state", { timeout: 5000 }, async () => {
  const h = await mountView("tab-state-read-undeclared");
  // tab.state.read, twice: a surface without surface.unload has no tab state handlers
  assert.match((await h.call()).error.message, /tab state is not declared/);
  assert.match((await h.call()).error.message, /tab state is not declared/);
  await h.close();
});

test("a command of another plugin is refused and runs nothing", { timeout: 5000 }, async () => {
  const h = await mountView("other-plugin-command");
  const from = wire.calls.length;
  // other.run {}
  assert.match((await h.call()).error.message, /belongs to other, not probe/);
  assert.deepEqual(h.after(from), []);
  await h.close();
});

test("a core command runs through runCore and a command of the plugin through runOwned", async () => {
  const end = holdSurfaces(["probe-surface", "command", "probe.run"]);
  const h = await mountView("command-core-owned");
  const from = wire.calls.length;
  const before = ran.core.length;
  try {
    // core.tab.select {a: 1}... as the params of a core command, and probe.run {b: 2}
    assert.equal((await h.call()).result, null);
    assert.deepEqual((await h.call()).result, { owned: true });
    assert.deepEqual(ran.core.slice(before), [{ name: "core.tab.select", params: { tab: "tab-a" }, cids: undefined }]);
    assert.deepEqual(h.sent(from, ["exposureForward"]).map(([, forward]) => [forward.surface, forward.method, forward.params]),
      [["probe-surface", "command.run", { name: "probe.run", params: { b: 2 }, surface: "probe-surface" }]],
      "a command of the plugin carries the surface of the calling view");
  } finally {
    end();
    await h.close();
  }
});

test("a call request without an integer id is refused and runs nothing", { timeout: 5000 }, async () => {
  const h = await mountView("call-without-id");
  const from = wire.calls.length;
  // core.surface.open {}, without an id
  const reply = (await h.call());
  assert.match(reply.error.message, /has no integer id/);
  assert.deepEqual(h.after(from), []);
  await h.close();
});

test("tab.state.write stores the params as the tab state of its surface", { timeout: 5000 }, async () => {
  const h = await mountView("tab-state-write", { id: "tab-view", plugin: "fixture-unload", unload: UNLOAD });
  // tab.state.write {page: 3}
  assert.equal((await h.call()).result, null);
  assert.deepEqual(h.store.entry("tab-view").state, { format: 2, value: { page: 3 } });
  await h.close();
});

test("tab.state.write is refused when the surface declares no tab state", { timeout: 5000 }, async () => {
  const h = await mountView("tab-state-write-undeclared");
  const from = wire.calls.length;
  // tab.state.write {}, twice
  assert.match((await h.call()).error.message, /tab state is not declared/);
  assert.match((await h.call()).error.message, /tab state is not declared/);
  assert.deepEqual(h.after(from), [], "a refused write reached the host");
  await h.close();
});

test("runtime.native.call runs the host call of the surface with its name and payload", { timeout: 5000 }, async () => {
  const h = await mountView("native-call");
  const from = wire.calls.length;
  // runtime.native.call {name: "exposureReply", payload: {id: 7, result: "a"}}
  assert.equal((await h.call()).result, null);
  assert.deepEqual(h.after(from), [{ name: "exposureReply", payload: { id: 7, result: "a", surface: "probe-surface" } }]);
  await h.close();
});

test("runtime.native.call refuses a missing or empty name and runs nothing", { timeout: 5000 }, async () => {
  const h = await mountView("native-call-empty-name");
  const from = wire.calls.length;
  // runtime.native.call {name: ""}
  assert.match((await h.call()).error.message, /requires a non-empty name/);
  assert.deepEqual(h.after(from), []);
  await h.close();
});

// The page registers its listener of the sidecar failures with the first call that needs it, and keeps it for the rest of the run. This
// test is the first of the file that does, so its case is the one that delivers the failure of the sidecar.
test("a subscription call of the view runs its page subscription and replies null", async () => {
  const h = await mountView("subscription-calls");
  const from = wire.calls.length;
  // runtime.native.on {name: "document-state"}, runtime.sidecar.on {id: "probe", sidecar: "fixture-sidecar"} and runtime.sidecar.onFailure {id: "probe-surface"}
  for (let n = 0; n < 3; n += 1) assert.equal((await h.call()).result, null);
  assert.deepEqual(h.sent(from, ["viewSidecarRoute"]), [["viewSidecarRoute", { generation: 1, sidecar: "fixture-sidecar", id: "probe", on: true, surface: "probe-surface" }]]);
  // The host event document-state of the surface and the failure of its sidecar reach the view as events.
  wire.deliverNotice();
  wire.deliverNotice();
  await drained();
  assert.deepEqual(h.sent(from, ["viewEvent"]), [
    ["viewEvent", { generation: 1, event: "document-state", data: { surface: "probe-surface", name: "doc", url: "https://example.test/" }, surface: "probe-surface" }],
    ["viewEvent", { generation: 1, event: "sidecar.failure", data: { id: "probe-surface", reason: "the sidecar ended" }, surface: "probe-surface" }],
  ]);
  await h.close();
});

test("runtime.sidecar.send sends the body with its correlation identifiers through the named sidecar", { timeout: 5000 }, async () => {
  const h = await mountView("sidecar-send");
  const from = wire.calls.length;
  // runtime.sidecar.send {id: "probe-surface", sidecar: "fixture-sidecar", body: {n: 1}, cids: ["c1"]}
  assert.equal((await h.call()).result, null);
  assert.deepEqual(h.after(from), [{ name: "viewSidecarSend",
    payload: { source: "probe-surface", generation: 1, sidecar: "fixture-sidecar", surface: "probe-surface", body: { n: 1 }, cids: ["c1"] } }]);
  // runtime.sidecar.send without a sidecar, and with an empty one
  assert.match((await h.call()).error.message, /requires a non-empty sidecar/);
  assert.match((await h.call()).error.message, /requires a non-empty sidecar/);
  assert.equal(h.after(from).length, 1, "a send without a sidecar name reached the runtime");
  await h.close();
});

test("runtime.clipboard.read returns the text of the clipboard and refuses an unknown type", { timeout: 5000 }, async () => {
  const h = await mountView("clipboard-read-text");
  const from = wire.calls.length;
  // runtime.clipboard.read "text"
  assert.equal((await h.call()).result, "text value");
  assert.deepEqual(h.after(from), [{ name: "clipboardRead", payload: { type: "text", userInitiated: true } }]);
  // runtime.clipboard.read "image"
  assert.match((await h.call()).error.message, /runtime.clipboard.read image is not served/);
  assert.equal(h.after(from).length, 1);
  await h.close();
});

test("runtime.clipboard.read png returns the binary id of the PNG in the view store, or null when the clipboard holds none", { timeout: 5000 }, async () => {
  const h = await mountView("clipboard-read-png");
  const from = wire.calls.length;
  // runtime.clipboard.read "png"
  assert.deepEqual((await h.call()).result, { present: true, type: "png", binary: BINARY_ID });
  // runtime.clipboard.read "png", answered with an absent PNG
  assert.equal((await h.call()).result, null);
  assert.deepEqual(h.after(from), [
    { name: "clipboardReadViewPNG", payload: { userInitiated: true, surface: "probe-surface" } },
    { name: "clipboardReadViewPNG", payload: { userInitiated: true, surface: "probe-surface" } },
  ]);
  await h.close();
});

test("runtime.clipboard.read png refuses a host reply without a binary id", { timeout: 5000 }, async () => {
  const h = await mountView("clipboard-read-png-invalid");
  // runtime.clipboard.read "png", answered with {present: true, type: "png", data: "AQID"}
  assert.match((await h.call()).error.message,
    /clipboard png reply of the host is invalid: \{"present":true,"type":"png","data":"AQID"\}/);
  await h.close();
});

test("runtime.clipboard.persistPNG persists the PNG of a binary id of the view store and returns the shell path", { timeout: 5000 }, async () => {
  const h = await mountView("clipboard-persist-png");
  const from = wire.calls.length;
  // runtime.clipboard.persistPNG {binary: BINARY_ID}
  assert.deepEqual((await h.call()).result, { path: "/tmp/it's.png", shellQuotedPath: "'/tmp/it'\\''s.png'" });
  assert.deepEqual(h.after(from), [{ name: "clipboardPersistViewPNG", payload: { binary: BINARY_ID, surface: "probe-surface" } }]);
  await h.close();
});

test("runtime.clipboard.persistPNG refuses params without a binary id, and base64 data, and persists nothing", { timeout: 5000 }, async () => {
  const h = await mountView("clipboard-persist-png-refused");
  const from = wire.calls.length;
  // runtime.clipboard.persistPNG "AQID"
  assert.match((await h.call()).error.message, /requires an object/);
  // runtime.clipboard.persistPNG {}
  assert.match((await h.call()).error.message, /requires binary, the id of an upload to the binary path of the view/);
  // runtime.clipboard.persistPNG {binary: "ABC"}
  assert.match((await h.call()).error.message, /requires binary, the id of an upload to the binary path of the view/);
  // runtime.clipboard.persistPNG {data: "AQID"}
  assert.match((await h.call()).error.message, /takes the binary id of an upload, not base64 data/);
  assert.deepEqual(h.after(from), []);
  await h.close();
});

test("runtime.clipboard.writeText writes the text and replies null", { timeout: 5000 }, async () => {
  const h = await mountView("clipboard-write-text");
  const from = wire.calls.length;
  // runtime.clipboard.writeText "hi"
  assert.equal((await h.call()).result, null);
  assert.deepEqual(h.after(from), [{ name: "clipboardWriteText", payload: "hi" }]);
  await h.close();
});

test("runtime.links.open opens the link of its params", { timeout: 5000 }, async () => {
  const h = await mountView("links-open");
  const from = wire.calls.length;
  // runtime.links.open "https://example.test"
  assert.equal((await h.call()).result, null);
  assert.deepEqual(h.after(from), [{ name: "linkOpen", payload: { url: "https://example.test" } }]);
  await h.close();
});

test("the tab reports of a view reach the handlers of its surface and reply null", { timeout: 5000 }, async () => {
  const h = await mountView("tab-reports");
  const from = wire.calls.length;
  // tab.title, tab.footer "1 of 3", tab.directory "/tmp", tab.modified true and tab.error, with the Korean title and error of the case
  for (let id = 1; id <= 5; id += 1) assert.equal((await h.call()).result, null);
  assert.deepEqual([reports.tabLabel(h.id), reports.tabFooter(h.id), reports.tabModified(h.id), reports.tabError(h.id)],
    ["문서", "1 of 3", true, "저장하지 못했습니다"]);
  assert.deepEqual(h.after(from), []);
  await h.close();
  reports.reportModified(h.id, false);
});

test("tab.notify takes {text, policy} and tab.keep takes {reason, on} from the params", { timeout: 5000 }, async () => {
  const h = await mountView("tab-notify-keep");
  // tab.notify {text, policy: "system"} with the Korean text of the case
  assert.equal((await h.call()).result, null);
  // tab.keep {reason: "busy", on: true}
  assert.equal((await h.call()).result, null);
  assert.deepEqual(reports.tabNotices().filter(([tab]) => tab === h.id), [[h.id, "끝났습니다"]]);
  assert.equal(reports.tabNotice(h.id), null, "a notice with the policy system is not the notice of the tab");
  assert.deepEqual(reports.tabKeeps(h.id), ["keep:busy"]);
  await h.close();
});

test("tab.notify and tab.keep refuse params that are not the recorded objects and run nothing", { timeout: 5000 }, async () => {
  const h = await mountView("tab-notify-keep-refused");
  // tab.notify with the text of the case as a string instead of an object
  assert.match((await h.call()).error.message, /requires an object/);
  // tab.keep null
  assert.match((await h.call()).error.message, /requires an object/);
  assert.deepEqual([reports.tabNotice(h.id), reports.tabKeeps(h.id)], [null, []]);
  await h.close();
});

test("runtime.log writer batches are not handled by the workbench view-call relay", { timeout: 5000 }, async () => {
  const h = await mountView("log-batch");
  const from = wire.calls.length;
  // runtime.log {action: "batch", events: []}
  assert.equal((await h.call()).error.message, "view call runtime.log is not served");
  assert.deepEqual(h.after(from), []);
  await h.close();
});

test("a view call runtime.log.levels is refused as not served and runs no subscription", { timeout: 5000 }, async () => {
  // A view has no level query: the record is passed to runtime.log and the writer of the event log decides (docs/spec/native-surfaces.md).
  const h = await mountView("log-levels");
  const from = wire.calls.length;
  // runtime.log.levels
  assert.equal((await h.call()).error.message, "view call runtime.log.levels is not served");
  assert.deepEqual(h.after(from), []);
  await h.close();
});

test("the workbench does not accept the earlier single-record runtime.log payload", { timeout: 5000 }, async () => {
  const h = await mountView("log-single");
  const from = wire.calls.length;
  // runtime.log {level: "info", event: "saved", fields: {}}
  assert.equal((await h.call()).error.message, "view call runtime.log is not served");
  assert.deepEqual(h.after(from), []);
  await h.close();
});

test("runtime.error writes the error line of the view to the application log with its surface and replies null", { timeout: 5000 }, async () => {
  const h = await mountView("error-line");
  const from = wire.calls.length;
  // runtime.error {where: "save", text: "disk full"}
  assert.equal((await h.call()).result, null);
  await flushEvents();
  const batch = wire.calls.slice(from).find(({ name, payload }) => name === "log" && payload.action === "batch");
  assert.deepEqual(batch.payload.events.filter(({ level }) => level === "error").map(({ event, fields }) => [event, fields]),
    [["workbench.record.error", { where: "surface probe-surface save", text: "disk full" }]]);
  await h.close();
});

test("runtime.error refuses a place or a text that the error line cannot carry and writes nothing", { timeout: 5000 }, async () => {
  const h = await mountView("error-refused");
  const from = wire.calls.length;
  // runtime.error "disk full"
  assert.match((await h.call()).error.message, /view call runtime\.error requires an object/);
  // runtime.error with the places "", "save: now", "save\nnow" and 7
  for (let n = 0; n < 4; n += 1) {
    assert.match((await h.call()).error.message, /view call runtime\.error requires a non-empty where without a control character or ": "/);
  }
  // runtime.error with the texts "" and null
  for (let n = 0; n < 2; n += 1) assert.match((await h.call()).error.message, /view call runtime\.error requires a non-empty text/);
  await flushEvents();
  assert.deepEqual(wire.calls.slice(from).filter(({ name, payload }) => name === "log" && payload.events.some(({ level }) => level === "error")), []);
  await h.close();
});

test("runtime.contributions returns the connected items of the point with their modules on the core root", async () => {
  installContributions(CONTRIBUTORS());
  const h = await mountView("contributions");
  const from = wire.calls.length;
  // runtime.contributions {point: "language"} and {point: "format"}
  assert.deepEqual((await h.call()).result, [
    { plugin: "one", index: 0, item: { name: "one" }, module: "soksak://core/modules/@scope/plugin-one/ui/one.js" },
    { plugin: "two", index: 1, item: { name: "two" }, module: "soksak://core/modules/@scope/plugin-two/ui/two.js" },
  ]);
  assert.match((await h.call()).error.message, /extension point format is not declared by probe/);
  assert.deepEqual(h.after(from), []);
  await h.close();
});

test("runtime.contributions.fail makes the named connected item invalid with its reason and replies null", async () => {
  installContributions(CONTRIBUTORS());
  const h = await mountView("contributions-fail");
  // runtime.contributions.fail {point: "language", plugin: "two", index: 1, reason: "extend is not a function"}
  assert.equal((await h.call()).result, null);
  assert.deepEqual(contributionsState().map(({ plugin, index, state, reason }) => [plugin, index, state, reason]), [
    ["one", 0, "connected", null],
    ["two", 0, "version-mismatch", "range ^2.0.0 does not contain probe.language 1.0.0"],
    ["two", 1, "invalid", "extend failed: extend is not a function"],
  ]);
  await h.close();
});

test("runtime.contributions.fail refuses an item that is not connected and a reason that is not text", async () => {
  installContributions(CONTRIBUTORS());
  const h = await mountView("contributions-fail-refused");
  // runtime.contributions.fail of the entry 0 of two, which is not connected, and of the entry 1 with an empty reason
  assert.match((await h.call()).error.message, /view call runtime\.contributions\.fail: language has no connected item 0 of two/);
  assert.match((await h.call()).error.message, /view call runtime\.contributions\.fail requires a non-empty reason/);
  assert.deepEqual(contributionsState().map(({ state }) => state), ["connected", "version-mismatch", "connected"]);
  await h.close();
});

test("runtime.shortcuts.read returns the rows of the workbench and view owners, and no native menu row", async () => {
  const h = await mountView("shortcuts-read");
  // runtime.shortcuts.read: the rows of packages/workbench/shortcuts.json whose owner is the workbench or the view
  assert.deepEqual((await h.call()).result, [
    { key: "shift+cmd+n", owner: "workbench", command: "core.window.new" },
    { key: "cmd+k", owner: "workbench", command: "core.library.search.focus" },
    { key: "Enter", owner: "workbench", command: "core.rename.commit" },
    { key: "Escape", owner: "workbench", command: "core.rename.cancel" },
    { key: "Enter", owner: "workbench", command: "core.library.form.submit" },
    { key: "Escape", owner: "workbench", command: "core.picker.close" },
    { key: "Escape", owner: "workbench", command: "core.modal.dismiss" },
    { key: "Escape", owner: "view", command: "none" },
    { key: "text input keys", owner: "view", command: "none" },
  ]);
  await h.close();
});

test("runtime.shortcuts.missing and runtime.shortcuts.run are not served and write nothing", async () => {
  const h = await mountView("shortcuts-not-served");
  const from = wire.calls.length;
  const before = ran.core.length;
  // runtime.shortcuts.missing and runtime.shortcuts.run, each with {key: "cmd+j"}
  for (const command of ["runtime.shortcuts.missing", "runtime.shortcuts.run"]) {
    assert.match((await h.call()).error.message, new RegExp(`view call ${command.replace(/\./g, "\\.")} is not served`));
  }
  await flushEvents();
  assert.deepEqual(wire.calls.slice(from).filter(({ name, payload }) => name === "log" && payload.events.some(({ event }) => event === "workbench.input.shortcut.failed")), []);
  assert.deepEqual(h.sent(from, ["exposureForward", "workspace", "viewEvent"]), []);
  assert.equal(ran.core.length, before);
  await h.close();
});

test("runtime.command runs a core command through runCore, and a failed workbench row writes workbench.input.shortcut.failed", async () => {
  const h = await mountView("command-core-shortcut");
  const from = wire.calls.length;
  const before = ran.core.length;
  const failures = () => wire.calls.slice(from).filter(({ name, payload }) => name === "log" && payload.action === "batch")
    .flatMap(({ payload }) => payload.events).filter(({ event }) => event === "workbench.input.shortcut.failed").map(({ level, fields }) => [level, fields]);
  // core.library.search.focus is a row of the workbench in shortcuts.json: it runs, then it fails; core.tab.select is no row and fails
  assert.equal((await h.call()).result, null);
  assert.deepEqual(ran.core.slice(before), [{ name: "core.library.search.focus", params: {}, cids: undefined }]);
  failing.add("core.library.search.focus");
  failing.add("core.tab.select");
  try {
    assert.match((await h.call()).error.message, /no focus target/);
    await flushEvents();
    assert.deepEqual(failures(), [["error", { plugin: "probe", command: "core.library.search.focus" }]]);
    assert.match((await h.call()).error.message, /no focus target/);
    await flushEvents();
    assert.equal(failures().length, 1, "a core command that is not a workbench row wrote a shortcut record");
  } finally {
    failing.clear();
  }
  await h.close();
});

test("runtime.textSize.read returns the scale of the surface and runtime.textSize.on subscribes once", async () => {
  setSurfaceTextSize(() => 1.5);
  const h = await mountView("text-size");
  const from = wire.calls.length;
  try {
    // runtime.textSize.read, runtime.textSize.on twice, and a change of the scale
    assert.equal((await h.call()).result, 1.5);
    assert.equal((await h.call()).result, null);
    assert.equal((await h.call()).result, null);
    assert.deepEqual(h.sent(from, ["viewEvent"]), []);
    setSurfaceTextSize(() => 2);
    notifyTextSize();
    await drained();
    assert.deepEqual(h.sent(from, ["viewEvent"]), [["viewEvent", { generation: 1, event: "textSize", data: 2, surface: "probe-surface" }]]);
  } finally {
    setSurfaceTextSize(() => 1);
  }
  await h.close();
});

test("runtime.log.levels.on subscribes the view to the changes of the stored levels", async () => {
  // A page reads the stored levels to skip building data that the writer would not store (docs/spec/native-surfaces.md#view-surfaces).
  const kept = logGate.classes();
  const h = await mountView("log-levels-on");
  const from = wire.calls.length;
  try {
    // runtime.log.levels.on, and a change of the policy of the page gate
    assert.equal((await h.call()).result, null);
    logGate.set({ ...kept, lifecycle: "info" });
    await drained();
    assert.deepEqual(h.sent(from, ["viewEvent"]), [["viewEvent", { generation: 1, event: "log.levels", data: { ...kept, lifecycle: "info" }, surface: "probe-surface" }]]);
  } finally {
    logGate.set(kept);
  }
  await h.close();
});

test("runtime.settings.read returns the settings of the plugin and runtime.settings.on subscribes once", async () => {
  const h = await mountView("settings");
  const from = wire.calls.length;
  // runtime.settings.read, runtime.settings.on twice, and a change of the setting probe.home
  assert.deepEqual((await h.call()).result, { home: "https://example.test" });
  assert.equal((await h.call()).result, null);
  assert.equal((await h.call()).result, null);
  beginSettings({ common: { "probe.home": "https://changed.test" }, projects: [] }, null);
  await drained();
  assert.deepEqual(h.sent(from, ["viewEvent"]), [["viewEvent", { generation: 1, event: "settings", data: { home: "https://changed.test" }, surface: "probe-surface" }]]);
  beginSettings({ common: {}, projects: [] }, null);
  await h.close();
});

test("a runtime or tab entry that the route does not serve is refused as not served", { timeout: 5000 }, async () => {
  const h = await mountView("entry-not-served");
  const from = wire.calls.length;
  // runtime.unknown.run {}
  assert.match((await h.call()).error.message, /runtime.unknown.run is not served/);
  assert.deepEqual(h.after(from), []);
  await h.close();
});

test("a cancel ends the pending call, which replies cancelled, and the pending call is removed", { timeout: 5000 }, async () => {
  const h = await mountView("cancel-pending");
  const from = wire.calls.length;
  // runtime.sidecar.send with the id 5, whose host reply is held
  assert.deepEqual(await h.deliver(), []);
  assert.deepEqual(h.after(from).map(({ name }) => name), ["viewSidecarSend"]);
  // the cancel of the call 5 replies for the call that it ends
  const [cancelled] = await h.deliver();
  assert.deepEqual([cancelled.id, cancelled.error.message], [5, "cancelled"]);
  // the call 5 is removed from the pending calls, so the id 5 serves a later call
  assert.deepEqual([(await h.call()).id, wire.calls.at(-1).name], [5, "viewReply"]);
  wire.release();
  await h.close();
});

test("a cancel of a call that has no pending call ends nothing", { timeout: 5000 }, async () => {
  const h = await mountView("cancel-none");
  const from = wire.calls.length;
  // the cancel of the call 9, which is not pending
  assert.deepEqual(await h.deliver(), []);
  assert.deepEqual(h.after(from), []);
  await h.close();
});

test("a call whose id is pending is refused", { timeout: 5000 }, async () => {
  const h = await mountView("pending-id-refused");
  // runtime.sidecar.send with the id 6, whose host reply is held
  assert.deepEqual(await h.deliver(), []);
  // runtime.links.open with the id 6
  assert.match((await h.call()).error.message, /view call 6 is already pending/);
  // the cancel of the call 6 replies for the first call
  const [cancelled] = await h.deliver();
  assert.deepEqual([cancelled.id, cancelled.error.message], [6, "cancelled"]);
  wire.release();
  await h.close();
});


test("runtime.status.watch subscribes a core status or a status of the plugin and runtime.status.unwatch ends it", async () => {
  const h = await mountView("status-watch-core");
  const from = wire.calls.length;
  const events = () => h.sent(from, ["viewEvent"]).map(([, payload]) => [payload.data.name, payload.data.value]);
  // runtime.status.watch {name: "core.grid"}, and of probe.count, which no surface registers and which the page answers with null; the value of core.grid changes; the unwatch of core.grid
  assert.equal((await h.call()).result, null);
  assert.equal((await h.call()).result, null);
  setGrid("a");
  await drained();
  assert.deepEqual(events(), [["core.grid", null], ["probe.count", null], ["core.grid", "a"]]);
  assert.equal((await h.call()).result, null);
  setGrid("b");
  await drained();
  assert.deepEqual(events(), [["core.grid", null], ["probe.count", null], ["core.grid", "a"]], "a value after the unwatch reached the view");
  assert.deepEqual(h.sent(from, ["exposureForward"]), []);
  setGrid(null);
  await h.close();
});

test("runtime.status.watch and runtime.status.unwatch refuse a status of another plugin and a name that is not text, and subscribe to nothing", async () => {
  const h = await mountView("status-watch-refused");
  const from = wire.calls.length;
  // watch other.count, unwatch other.count, watch with an empty name, watch grid, watch with params that are not an object
  assert.match((await h.call()).error.message, /view call runtime\.status\.watch other\.count is neither a core status nor a status of probe/);
  assert.match((await h.call()).error.message, /view call runtime\.status\.unwatch other\.count is neither a core status nor a status of probe/);
  assert.match((await h.call()).error.message, /requires a non-empty name/);
  assert.match((await h.call()).error.message, /view call runtime\.status\.watch grid is neither a core status nor a status of probe/);
  assert.match((await h.call()).error.message, /requires an object/);
  assert.deepEqual(h.after(from), []);
  await h.close();
});

test("a subscription call without its name or id is refused and subscribes to nothing", { timeout: 5000 }, async () => {
  const h = await mountView("subscription-refused");
  const from = wire.calls.length;
  // runtime.native.on {name: ""}
  assert.match((await h.call()).error.message, /requires a non-empty name/);
  // runtime.sidecar.on null
  assert.match((await h.call()).error.message, /requires an object/);
  // runtime.sidecar.onFailure {id: 7}
  assert.match((await h.call()).error.message, /requires a non-empty id/);
  assert.deepEqual(h.after(from), []);
  await h.close();
});

test("runtime.theme is refused as a call, because the theme reaches a view as a host message", { timeout: 5000 }, async () => {
  const h = await mountView("theme-refused");
  // runtime.theme null
  assert.match((await h.call()).error.message, /view call runtime.theme is not served/);
  await h.close();
});

test("a registration call of the view declares its command on the page and replies null", async () => {
  const h = await mountView("command-register");
  const from = wire.calls.length;
  // runtime.command.register {name: "probe.run"}
  assert.equal((await h.call()).result, null);
  assert.deepEqual(registry.registrants("command", "probe.run"), ["probe-surface"]);
  // The command is registered on the page; the host is told nothing, because it forwards no request of this command to the main page.
  assert.deepEqual(h.after(from), []);
  await h.close();
  assert.deepEqual(registry.registrants("command", "probe.run"), []);
});

test("a registration call without a name is refused and declares nothing", async () => {
  const h = await mountView("command-register-refused");
  const from = wire.calls.length;
  // runtime.command.register {name: ""} and runtime.command.register "probe.run"
  assert.match((await h.call()).error.message, /requires a non-empty name/);
  assert.match((await h.call()).error.message, /requires an object/);
  assert.deepEqual(registry.registrants("command", "probe.run"), []);
  assert.deepEqual(h.after(from), []);
  await h.close();
});

test("a registered call of the view records the status or element of its surface", async () => {
  const h = await mountView("registered");
  const from = wire.calls.length;
  // runtime.native.call registered {kind: "status", name: "probe.state"} and {kind: "element", name: "probe.view"}
  assert.equal((await h.call()).result, null);
  assert.equal((await h.call()).result, null);
  assert.deepEqual([registry.registrants("status", "probe.state"), registry.registrants("element", "probe.view")], [["probe-surface"], ["probe-surface"]]);
  assert.deepEqual(h.sent(from, ["exposureRegister"]), [
    ["exposureRegister", { kind: "status", name: "probe.state", surface: "probe-surface" }],
    ["exposureRegister", { kind: "element", name: "probe.view", surface: "probe-surface" }],
  ]);
  assert.deepEqual(h.after(from).filter(({ name }) => name === "registered"), [], "the registration was forwarded to the host call route");
  await h.close();
});

test("a registered call without its kind or name is refused and records nothing", async () => {
  const h = await mountView("registered-refused");
  const from = wire.calls.length;
  // runtime.native.call registered with the payload "probe.state", with an empty kind and without a name
  assert.match((await h.call()).error.message, /requires an object/);
  assert.match((await h.call()).error.message, /requires a non-empty kind/);
  assert.match((await h.call()).error.message, /requires a non-empty name/);
  assert.deepEqual(registry.registrants("status", "probe.state"), []);
  assert.deepEqual(h.after(from), []);
  await h.close();
});

test("a changed call of the view gives the value of its watched status to the page and replies null", async () => {
  // The document watches the status probe.state of the surface of the view, as the core watches a status of a surface.
  const seen = [];
  const stop = registry.observe("probe.state", "probe-surface", (value, from) => seen.push([value, from]), { exact: true });
  const h = await mountView("changed");
  const from = wire.calls.length;
  // runtime.native.call registered {kind: "status", name: "probe.state"}, changed with the value 3 and the version 1, and changed with null and the version 2
  assert.equal((await h.call()).result, null);
  assert.equal((await h.call()).result, null);
  assert.equal((await h.call()).result, null);
  assert.deepEqual(seen, [[null, null], [3, "probe-surface"], [null, "probe-surface"]]);
  assert.deepEqual(h.after(from).filter(({ name }) => name === "changed"), [], "the change was forwarded to the host call route");
  stop();
  await h.close();
});

test("a changed call without its name, value or a positive integer version is refused and delivers nothing", async () => {
  const seen = [];
  const stop = registry.observe("probe.state", "probe-surface", (value, from) => seen.push([value, from]), { exact: true });
  const h = await mountView("changed-refused");
  const refused = /view call changed requires a non-empty name, a value and a positive integer version/;
  // runtime.native.call changed without a name, without a value, with the version 0 and with the version 1.5
  for (let n = 0; n < 4; n += 1) assert.match((await h.call()).error.message, refused);
  assert.deepEqual(seen, [[null, null]]);
  stop();
  await h.close();
});

test("a registered call of a plugin command is refused, because a view registers its commands with runtime.command.register", async () => {
  const h = await mountView("registered-command");
  const from = wire.calls.length;
  // runtime.native.call registered {kind: "command", name: "probe.run"} and {kind: "command", name: "core.surface.hit"}
  assert.match((await h.call()).error.message, /view call registered: command probe\.run is registered through runtime\.command\.register/);
  assert.equal((await h.call()).result, null);
  assert.deepEqual(registry.registrants("command", "core.surface.hit"), ["probe-surface"]);
  assert.deepEqual(registry.registrants("command", "probe.run"), []);
  assert.deepEqual(h.sent(from, ["exposureRegister"]), [["exposureRegister", { kind: "command", name: "core.surface.hit", surface: "probe-surface" }]]);
  await h.close();
});

// contract: view.restart.limit-shows-error
test("a view-stopped event becomes the error state of its surface with its reason", () => {
  const state = viewStopState({ surface: "probe-surface", plugin: "probe", reason: "the view failed 4 times within 300 seconds" });
  assert.equal(state.phase, "error");
  assert.equal(state.error.message, "the view failed 4 times within 300 seconds");
});

// contract: view.restart.limit-shows-error
test("a view-stopped event without a reason is refused", () => {
  assert.throws(() => viewStopState({ surface: "probe-surface", plugin: "probe" }), /has no reason/);
});

// contract: view.restart.restores-state
// The workbench keys the tab state by surface, so a view that is created again on the same surface reads the state that was saved before
// the restart. The restarted view has a new pending map, and the tab state of the surface is the same object.
test("a restarted view reads the tab state of its surface as it was saved before the restart", async () => {
  const h = await mountView("restart-tab-state", { id: "tab-view", plugin: "fixture-unload", unload: UNLOAD });
  // tab.state.write {page: 3}, the restart of the view on the same surface, and tab.state.read of the restarted view
  assert.equal((await h.call()).result, null);
  assert.deepEqual(h.store.entry("tab-view").state, { format: 2, value: { page: 3 } });
  await h.restart();
  assert.deepEqual((await h.call()).result, { page: 3 });
  await h.close();
});

test("the composition and region calls of a view run the page operations of its surface with their named fields", async () => {
  const h = await mountView("composition-calls", { regions: REGIONS, store: true });
  const from = wire.calls.length;
  // composition.declaration, composition.place, composition.report, the document calls attach, load, zoom, go (twice), post, subscribe,
  // unsubscribe and detach of the region doc, and the image calls attach, focus, caret, text and detach of the region picture
  const replies = [];
  for (let n = 0; n < 17; n += 1) replies.push(await h.call());
  assert.deepEqual(replies.map((reply) => reply.error?.message).filter(Boolean), []);
  assert.deepEqual(replies[0].result, { kind: "view", regions: REGIONS, overlays: [] });
  assert.deepEqual(h.sent(from, REGION_HOST_NAMES), EXPECTED_REGION_CALLS);
  // composition.report writes the failure text of the view to the application log.
  await flushEvents();
  assert.deepEqual(wire.calls.slice(from).filter(({ name, payload }) => name === "log" && payload.action === "batch").flatMap(({ payload }) => payload.events)
    .filter(({ level }) => level === "error").map(({ event, fields }) => [event, fields]),
  [["workbench.record.error", { where: "surface composition failed", text: "probe" }]]);
  await h.close();
});

test("document.subscribe of a view replies the handle number of the host reply and refuses a reply without one", async () => {
  // The hosts reply {handle} (docs/spec/native-surfaces.md#document-regions); the view call replies the handle number, the form of
  // the published case view.composition.stream-subscribe-and-close that the region record of the view keys its stream by.
  const h = await mountView("document-subscribe", { regions: REGIONS, store: true });
  // document.subscribe {name: "doc", stream: "elements"}, answered with {handle: 7}, and again, answered with {}
  assert.equal((await h.call()).result, 7);
  assert.equal((await h.call()).error.message, "document.subscribe doc elements: the host reply has no handle: {}");
  await h.close();
});

test("a region call without a region name or with params that are not its fields is refused and runs nothing", { timeout: 5000 }, async () => {
  const h = await mountView("region-refused");
  const from = wire.calls.length;
  // document.attach {name: ""}
  assert.match((await h.call()).error.message, /document.attach requires a non-empty region name/);
  // image.focus "picture"
  assert.match((await h.call()).error.message, /image.focus requires an object/);
  // composition.place {regions: {}, overlays: []}
  assert.match((await h.call()).error.message, /composition.place requires the arrays regions and overlays/);
  assert.deepEqual(h.after(from), []);
  await h.close();
});

test("runtime.native.call of a composition or region host call is refused and runs nothing", { timeout: 5000 }, async () => {
  const h = await mountView("native-call-region-refused");
  const from = wire.calls.length;
  // runtime.native.call with the names compositionDeclare, compositionPlace, documentAttach, documentLoad, imageAttach and documentQuery
  for (const name of ["compositionDeclare", "compositionPlace", "documentAttach", "documentLoad", "imageAttach", "documentQuery"]) {
    assert.equal((await h.call()).error.message, `view call runtime.native.call ${name} is not served: a view operates its regions through its composition`);
  }
  assert.deepEqual(h.after(from), []);
  await h.close();
});

test("a call that carries the cids of its cause hands them to the command of its plugin", async () => {
  const end = holdSurfaces(["probe-surface", "command", "probe.run"]);
  const h = await mountView("command-owned-cids");
  const from = wire.calls.length;
  try {
    // probe.run null, with the cids ["p1700000000000.4"]
    assert.deepEqual((await h.call()).result, { owned: true });
    assert.deepEqual(h.sent(from, ["exposureForward"]).map(([, forward]) => [forward.method, forward.params.name, forward.params.cids]),
      [["command.run", "probe.run", ["p1700000000000.4"]]]);
  } finally {
    end();
    await h.close();
  }
});

test("a call without cids hands no cids to the command of its plugin", async () => {
  const end = holdSurfaces(["probe-surface", "command", "probe.run"]);
  const h = await mountView("command-owned-no-cids");
  const from = wire.calls.length;
  try {
    // probe.run null, without cids
    assert.equal((await h.call()).result, null);
    assert.deepEqual(h.sent(from, ["exposureForward"]).map(([, forward]) => Object.hasOwn(forward.params, "cids")), [false]);
  } finally {
    end();
    await h.close();
  }
});

test("a call whose cids a line cannot hold is refused and runs nothing", { timeout: 5000 }, async () => {
  const h = await mountView("cids-refused");
  const from = wire.calls.length;
  // probe.run null, with the cids ['p1.7"x']
  assert.match((await h.call()).error.message, /cids must be an array of non-empty strings/);
  assert.deepEqual(h.after(from), []);
  await h.close();
});

test("a core command call that carries the cids of its cause hands them to runCore", async () => {
  const h = await mountView("command-core-cids");
  const before = ran.core.length;
  // core.tab.select {}, with the cids ["p1700000000000.5"]
  assert.equal((await h.call()).result, null);
  assert.deepEqual(ran.core.slice(before), [{ name: "core.tab.select", params: {}, cids: ["p1700000000000.5"] }]);
  await h.close();
});

test("surface.menu runs core.surface.menu at the window point of a right click in the view", async () => {
  frames.set("probe-surface", { x: 100, y: 40, w: 400, h: 300 });
  const h = await mountView("surface-menu");
  await h.mount("probe-bare-surface", "probe-bare");
  frames.set("probe-bare-surface", { x: 100, y: 40, w: 400, h: 300 });
  const before = ran.core.length;
  try {
    // surface.menu {x: 12, y: 8.5} of the view of the plugin probe, which declares surface.menu
    assert.equal((await h.call()).result, true);
    assert.deepEqual(ran.core.slice(before), [{ name: "core.surface.menu", params: { surface: "probe-surface", x: 112, y: 48.5 }, cids: undefined }]);
    // surface.menu of the view of the plugin probe-bare, which declares none
    assert.equal((await h.call()).result, false, "a surface whose plugin declares no menu opens none");
    assert.equal(ran.core.length, before + 1);
    // surface.menu of the view probe-surface after its frame ended, and with x as text and y as infinity
    frames.delete("probe-surface");
    assert.equal((await h.call()).error.message, "view call surface.menu surface probe-surface has no applied frame");
    frames.set("probe-surface", { x: 0, y: 0, w: 400, h: 300 });
    assert.equal((await h.call()).error.message, "view call surface.menu requires x and y as finite numbers");
    assert.equal(ran.core.length, before + 1);
  } finally {
    frames.clear();
    await h.close();
  }
});
