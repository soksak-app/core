// The page ends the reply hold of a surface at the host event diagnostics-surface-released, which the host sends when the
// endpoint connection that asked for the hold closes, and at the end of the page (docs/spec/endpoint.md, diagnostics.surface.hold).
import assert from "node:assert/strict";
import { mock, test } from "node:test";

const hostEvents = new Map();
const released = [];
const gates = [];
const replyHold = {
  gate: () => {}, closed: () => {}, hold: () => {}, held: async () => {},
  released: (surface) => { released.push(surface); return Promise.resolve(); },
  endAll: () => Promise.resolve(),
};
mock.module("../exposure.js", { exports: {
  registry: { method: () => {} },
  gateSurfaceReplies: (...args) => gates.push(args),
} });
mock.module("../host.js", { exports: { log: () => {}, native: false, watchCalls: () => {} } });
mock.module("../page-log.js", { exports: { emitEvent: () => {} } });
mock.module("../page-identity.js", { exports: { pageIdentity: "page-fixture" } });
mock.module("../transcript.js", { exports: {
  createTranscript: () => ({ set: () => {}, record: () => {} }), transcriptSender: () => () => {},
} });
mock.module("../surface-reply-hold.js", { exports: { createSurfaceReplyHold: () => replyHold } });
mock.module("../surface-modules.js", { exports: { mountedSurface: () => null } });
mock.module("../resize-loop.js", { exports: { watchResizeLoop: () => {} } });
mock.module("../page-layout.js", { exports: { armLayoutFault: () => {} } });
mock.module("../plane.js", { exports: { currentGrid: () => ({ boundaryPos: () => 0 }), surfaceInput: () => {} } });
mock.module("@soksak/runtime", { exports: { host: { on: (name, handler) => hostEvents.set(name, handler), call: async () => null } } });
globalThis.document = { querySelector: () => null };
await import("../observe.js");

test("the host event diagnostics-surface-released ends the hold of its surface", async () => {
  const handler = hostEvents.get("diagnostics-surface-released");
  assert.equal(typeof handler, "function", "the page does not listen to diagnostics-surface-released");
  await handler({ surface: "tab-1" });
  assert.deepEqual(released, ["tab-1"]);
});

test("the reply gate carries the end of every hold, which the reload of the page calls", () => {
  assert.deepEqual(gates, [[replyHold.gate, replyHold.endAll]]);
});
