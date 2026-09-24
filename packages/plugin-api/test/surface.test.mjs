import assert from "node:assert/strict";
import test from "node:test";
import { createSurfaceContext, mountSurfaceModule, releaseSurfaceReady } from "../surface.js";

const TAB = { title() {}, directory() {} };

test("surface modules mount into the supplied root and dispose exactly once", async () => {
  const root = { children: [], appendChild(node) { this.children.push(node); } };
  const phases = [];
  const context = createSurfaceContext({ root, surfaceId: "tab-1", pluginId: "fixture", tab: TAB, runtime: {
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
  const context = createSurfaceContext({ root, surfaceId: "tab-1", pluginId: "fixture", tab: TAB, runtime: {
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
  const context = createSurfaceContext({ root, surfaceId: "tab-1", pluginId: "fixture", runtime,
    tab: { title: (text) => reported.push(["title", text]), directory: (path) => reported.push(["directory", path]) },
    origin: { directory: "/tmp/origin" } });
  context.tab.title("vim");
  context.tab.directory("/tmp");
  assert.deepEqual(reported, [["title", "vim"], ["directory", "/tmp"]]);
  assert.equal(context.origin.directory, "/tmp/origin");
  assert.equal(Object.isFrozen(context.origin), true);
  assert.equal(createSurfaceContext({ root, surfaceId: "tab-2", runtime, tab: TAB }).origin.directory, null);
  assert.throws(() => createSurfaceContext({ root, surfaceId: "tab-3", runtime }),
    /surface context requires tab.title and tab.directory/);
});
