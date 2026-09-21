import assert from "node:assert/strict";
import test from "node:test";
import { createSurfaceContext, mountSurfaceModule, releaseSurfaceReady } from "../surface.js";

test("surface modules mount into the supplied root and dispose exactly once", async () => {
  const root = { children: [], appendChild(node) { this.children.push(node); } };
  const phases = [];
  const context = createSurfaceContext({ root, surfaceId: "tab-1", pluginId: "fixture", runtime: {
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
  const context = createSurfaceContext({ root, surfaceId: "tab-1", pluginId: "fixture", runtime: {
    sidecar: () => "port", native: { composition: {} }, exposure: { command() {} }, emit() {},
  } });
  assert.equal(context.runtime.sidecar(), "port");
  assert.deepEqual(context.runtime.native, { composition: {} });
  assert.equal("call" in context.runtime, false);
});
