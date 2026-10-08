import assert from "node:assert/strict";
import test from "node:test";
import { createSurfaceContext, mountSurfaceModule, releaseSurfaceReady } from "../surface.js";

const TAB = { title() {}, footer() {}, directory() {}, notify() {} };
const ICON = (name) => `<svg data-icon="${name}"></svg>`;

test("surface modules mount into the supplied root and dispose exactly once", async () => {
  const root = { children: [], appendChild(node) { this.children.push(node); } };
  const phases = [];
  const context = createSurfaceContext({ root, surfaceId: "tab-1", pluginId: "fixture", tab: TAB, icon: ICON, runtime: {
    exposure: { command() {} },
    sidecar() {}, emit() {}, native: {},
  } });
  context.status.subscribe(({ phase }) => phases.push(phase));
  let disposed = 0;
  const mounted = await mountSurfaceModule({
    mount(target, received) {
      assert.equal(target, root);
      assert.equal(received.surfaceId, "tab-1");
      received.status.report("ready");
      return { dispose() { disposed++; } };
    },
  }, root, context);
  assert.deepEqual(phases, []);
  releaseSurfaceReady(context);
  mounted.dispose();
  assert.deepEqual(phases, ["ready"]);
  assert.equal(disposed, 1);
});

test("surface context exposes only scoped runtime capabilities", () => {
  const root = { appendChild() {} };
  const context = createSurfaceContext({ root, surfaceId: "tab-1", pluginId: "fixture", tab: TAB, icon: ICON, runtime: {
    sidecar: () => "port", native: { composition: {} }, exposure: { command() {} }, emit() {},
    settings: { read: () => ({ "cursor.shape": "block" }), on: () => () => {} },
  } });
  assert.equal(context.runtime.sidecar(), "port");
  assert.deepEqual(context.runtime.native, { composition: {} });
  assert.equal(context.runtime.settings.read()["cursor.shape"], "block");
  assert.equal("call" in context.runtime, false);
});

test("surface context carries the tab reports and the origin directory", () => {
  const root = { appendChild() {} };
  const reported = [];
  const runtime = { exposure: { command() {} }, sidecar() {}, emit() {}, native: {} };
  const context = createSurfaceContext({ root, surfaceId: "tab-1", pluginId: "fixture", runtime, icon: ICON,
    tab: { title: (text) => reported.push(["title", text]), footer: (text) => reported.push(["footer", text]),
      directory: (path) => reported.push(["directory", path]), notify: (text) => reported.push(["notify", text]) },
    origin: { directory: "/tmp/origin" } });
  context.tab.title("vim");
  context.tab.footer("/tmp");
  context.tab.directory("/tmp");
  context.tab.notify("done");
  assert.deepEqual(reported, [["title", "vim"], ["footer", "/tmp"], ["directory", "/tmp"], ["notify", "done"]]);
  assert.equal(context.origin.directory, "/tmp/origin");
  assert.equal(Object.isFrozen(context.origin), true);
  assert.equal(createSurfaceContext({ root, surfaceId: "tab-2", runtime, tab: TAB, icon: ICON }).origin.directory, null);
  assert.throws(() => createSurfaceContext({ root, surfaceId: "tab-3", runtime, icon: ICON }),
    /surface context requires tab.title, tab.footer, tab.directory, and tab.notify/);
});

test("surface context offers the core icons and requires them", () => {
  const root = { appendChild() {} };
  const runtime = { exposure: { command() {} }, sidecar() {}, emit() {}, native: {} };
  const context = createSurfaceContext({ root, surfaceId: "tab-1", runtime, tab: TAB, icon: ICON });
  assert.equal(context.icon("rotate-cw"), '<svg data-icon="rotate-cw"></svg>');
  assert.throws(() => createSurfaceContext({ root, surfaceId: "tab-2", runtime, tab: TAB }),
    /surface context requires icon\(name\)/);
});

test("surface context carries the window's project root or null", () => {
  const root = { appendChild() {} };
  const runtime = { exposure: { command() {} }, sidecar() {}, emit() {}, native: {} };
  const context = createSurfaceContext({ root, surfaceId: "tab-1", runtime, tab: TAB, icon: ICON, project: { root: "/work/app" } });
  assert.deepEqual(context.project, { root: "/work/app" });
  assert.equal(Object.isFrozen(context.project), true);
  assert.equal(createSurfaceContext({ root, surfaceId: "tab-2", runtime, tab: TAB, icon: ICON }).project, null);
});

test("releasing the ready state of an unknown context is an error", () => {
  assert.throws(() => releaseSurfaceReady({}), /createSurfaceContext/);
});

test("surface context gives the contributions of the plugin's declared extension points", () => {
  const root = { appendChild() {} };
  const runtime = { sidecar: () => "port", exposure: { command() {} }, emit() {} };
  const plain = createSurfaceContext({ root, surfaceId: "tab-1", pluginId: "fixture", tab: TAB, icon: ICON, runtime });
  assert.throws(() => plain.contributions("language"), /extension point language is not declared by fixture/);
  const items = [{ plugin: "tidy", item: { name: "tidy" }, module: "/modules/tidy/ui/tidy.js" }];
  const provider = createSurfaceContext({ root, surfaceId: "tab-2", pluginId: "fixture", tab: TAB, icon: ICON, runtime,
    contributions: (point) => (point === "language" ? items : []) });
  assert.equal(provider.contributions("language"), items);
  assert.throws(() => provider.contributions(""), /contributions requires an extension point name/);
});

test("surface context gives a copy of the tab parameters, or null for a tab without them", () => {
  const root = { appendChild() {} };
  const runtime = { sidecar: () => "port", exposure: { command() {} }, emit() {} };
  const params = { path: "notes/todo.md" };
  const context = createSurfaceContext({ root, surfaceId: "tab-1", pluginId: "fixture", icon: ICON, runtime, tab: { ...TAB, params } });
  assert.deepEqual(context.tab.params, params);
  assert.notEqual(context.tab.params, params);
  assert.equal(Object.isFrozen(context.tab.params), true);
  const plain = createSurfaceContext({ root, surfaceId: "tab-2", pluginId: "fixture", icon: ICON, runtime, tab: TAB });
  assert.equal(plain.tab.params, null);
});
