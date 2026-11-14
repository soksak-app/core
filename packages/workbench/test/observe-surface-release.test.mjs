// The page ends the reply hold of a surface at the host event diagnostics-surface-released, which the host sends when the
// endpoint connection that asked for the hold closes, and at the end of the page (docs/spec/endpoint.md, diagnostics.surface.hold).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mock, test } from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";

// The plane module binds the elements of the workbench document when it is imported, so the document is the one of index.html.
const { window } = new JSDOM(readFileSync(new URL("../index.html", import.meta.url), "utf8"), { url: "http://localhost/" });
globalThis.window = window;
globalThis.document = window.document;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.CSS = window.CSS;

// The host calls and events of the page are answered by the page-wire case of each test (docs/spec/cases/page-wire/README.md). The case
// is selected before observe.js is imported, because the page reads the host when its modules are imported.
const released = selectPageWire("observe-surface-release-released");
// The mounted state of a view stays replaced: a view is mounted by the native host, and this document has no native host that mounts it.
// The real exports of surface-modules.js are kept, so the modules that import other exports of it load beside the replacement.
const actualSurfaces = await import("../surface-modules.js");
mock.module("../surface-modules.js", { exports: { ...actualSurfaces, mountedSurface: (surface) => (surface === "tab-1" || surface === "tab-2" ? {} : null) } });
// The ResizeObserver of the WebKit view is not in this document, and watchResizeLoop extends that observer class when observe.js is imported.
mock.module("../resize-loop.js", { exports: { watchResizeLoop: () => {} } });
const { logGate } = await import("../log-gate.js");
// The observation line of the hold is an info record of the class lifecycle, so the gate stores it.
logGate.set({ lifecycle: "info", input: "error", call: "error", io: "error", frame: "error" });
const { flushEvents } = await import("../page-log.js");
await import("../observe.js");
const { gatedExposureReply, registry, whenRepliesSent } = await import("../exposure.js");

test("the host event diagnostics-surface-released ends the hold of its surface", async () => {
  assert.deepEqual(await registry.handle({ id: 1, method: "diagnostics.surface.hold", params: { surface: "tab-1" } }), { result: null });
  const held = registry.handle({ id: 2, method: "diagnostics.surface.held", params: { surface: "tab-1" } });
  // The notice reaches the listener that the page registered for diagnostics-surface-released; the case fails when there is none.
  released.deliverNotice();
  const answer = await held;
  assert.equal(answer.error?.message, `the hold of surface "tab-1" ended before it held an exposure reply`);
  await flushEvents();
  released.finish();
});

test("the reply gate carries the end of every hold, which the reload of the page calls", async () => {
  const gate = selectPageWire("observe-surface-release-reply-gate");
  assert.deepEqual(await registry.handle({ id: 3, method: "diagnostics.surface.hold", params: { surface: "tab-2" } }), { result: null });
  let sent = false;
  const reply = gatedExposureReply("tab-2", () => Promise.resolve("sent")).then((value) => { sent = true; return value; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent, false, "the reply of a held surface was sent before the hold ended");
  await whenRepliesSent();
  assert.equal(await reply, "sent");
  // The observation line of the end is written in the turns after the replies settled.
  await new Promise((resolve) => setImmediate(resolve));
  await flushEvents();
  gate.finish();
});
