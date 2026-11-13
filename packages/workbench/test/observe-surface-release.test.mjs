// The page ends the reply hold of a surface at the host event diagnostics-surface-released, which the host sends when the
// endpoint connection that asked for the hold closes, and at the end of the page (docs/spec/endpoint.md, diagnostics.surface.hold).
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { JSDOM } from "jsdom";

const { window } = new JSDOM("<!doctype html><main></main>");
globalThis.document = window.document;

const hostEvents = new Map();
// The modules below stay replaced: surface-modules, plane and resize-loop need native presentation or a WebKit ResizeObserver, and the host
// replacement exports only log, native and watchCalls, so a module that imports other host exports cannot be loaded beside it.
mock.module("../host.js", { exports: { log: () => {}, native: false, watchCalls: () => {} } });
// A view is mounted by the native host (surface-modules.js: without a host a view is not mounted), so the mounted state of the two surfaces that
// the holds name is the native presentation answer that this test keeps.
mock.module("../surface-modules.js", { exports: { mountedSurface: (surface) => (surface === "tab-1" || surface === "tab-2" ? {} : null) } });
mock.module("../resize-loop.js", { exports: { watchResizeLoop: () => {} } });
mock.module("../page-layout.js", { exports: { armLayoutFault: () => {} } });
mock.module("../plane.js", { exports: { currentGrid: () => ({ boundaryPos: () => 0 }), surfaceInput: () => {} } });
mock.module("@soksak/runtime", { exports: { host: { on: (name, handler) => hostEvents.set(name, handler), call: async () => null } } });
await import("../observe.js");
const { gatedExposureReply, registry, whenRepliesSent } = await import("../exposure.js");

test("the host event diagnostics-surface-released ends the hold of its surface", async () => {
  const handler = hostEvents.get("diagnostics-surface-released");
  assert.equal(typeof handler, "function", "the page does not listen to diagnostics-surface-released");
  assert.deepEqual(await registry.handle({ id: 1, method: "diagnostics.surface.hold", params: { surface: "tab-1" } }), { result: null });
  const held = registry.handle({ id: 2, method: "diagnostics.surface.held", params: { surface: "tab-1" } });
  await handler({ surface: "tab-1" });
  const answer = await held;
  assert.equal(answer.error?.message, `the hold of surface "tab-1" ended before it held an exposure reply`);
});

test("the reply gate carries the end of every hold, which the reload of the page calls", async () => {
  assert.deepEqual(await registry.handle({ id: 3, method: "diagnostics.surface.hold", params: { surface: "tab-2" } }), { result: null });
  let sent = false;
  const reply = gatedExposureReply("tab-2", () => Promise.resolve("sent")).then((value) => { sent = true; return value; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent, false, "the reply of a held surface was sent before the hold ended");
  await whenRepliesSent();
  assert.equal(await reply, "sent");
});
