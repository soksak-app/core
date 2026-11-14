import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";
import { drained } from "./support/drained.mjs";

// The host calls of each test are answered by its page-wire case (docs/spec/cases/page-wire/README.md). A test selects its case before it
// imports the host module, because the module reads the host when it is imported. The module keeps the sidecar failure listener and the
// exposure registry, so a test that observes a failure listener imports its own copy of the module.
const settled = () => new Promise((resolve) => setImmediate(resolve));

/* Records the message of each error event that the window of the page receives. The events go to a window of its own. */
function windowErrors() {
  const dom = new JSDOM("<body></body>", { url: "http://localhost/" });
  const messages = [];
  dom.window.addEventListener("error", (event) => messages.push(event.message));
  globalThis.dispatchEvent = (event) => dom.window.dispatchEvent(event);
  globalThis.ErrorEvent = dom.window.ErrorEvent;
  return { messages, close: () => { delete globalThis.dispatchEvent; delete globalThis.ErrorEvent; dom.window.close(); } };
}

let wire = selectPageWire("surface-runtime-event-subscription");

test("surface event subscription resolves only after the native listener is installed", async () => {
  const dom = new JSDOM("<body></body>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  const { surfaceContextRuntime } = await import("../host.js");
  const surface = "event-ready-surface";
  const received = [];
  const runtime = surfaceContextRuntime({ surfaceId: surface });

  const off = await runtime.native.on("shell-status", (event) => received.push(event.state));
  // The host delivers the event to the listener that the subscription installed before it resolved.
  wire.deliverNotice();
  assert.deepEqual(received, ["ready"]);
  assert.equal(typeof off, "function");
  off();
  wire.finish();
  dom.window.close();
});

test("surface sidecar access is resolved from the declared surface and takes no argument", async () => {
  wire = selectPageWire("surface-runtime-sidecar-declared");
  const { surfaceContextRuntime } = await import("../host.js");
  const runtime = surfaceContextRuntime({ surfaceId: "declared-sidecar-surface", sidecars: ["@fixture/sidecar"] });
  const port = runtime.sidecar();
  await port.send("declared-sidecar-surface", { operation: "open" });
  assert.deepEqual(wire.calls.at(-1), { name: "sidecarSend", payload: {
    sidecar: "@fixture/sidecar", surface: "declared-sidecar-surface", body: { operation: "open" }, cids: [],
  } });
  assert.throws(() => runtime.sidecar("@fixture/sidecar"), /takes no argument; it uses the declared sidecar/);
  wire.finish();
});

test("a surface sidecar send passes the correlation identifiers of the input it continues to the host call", async () => {
  wire = selectPageWire("surface-runtime-sidecar-cids");
  const { surfaceContextRuntime } = await import("../host.js");
  const port = surfaceContextRuntime({ surfaceId: "chained-surface", sidecars: ["@fixture/sidecar"] }).sidecar();
  await port.send("chained-surface", { operation: "input" }, ["b1.7"]);
  assert.deepEqual(wire.calls.at(-1), { name: "sidecarSend", payload: {
    sidecar: "@fixture/sidecar", surface: "chained-surface", body: { operation: "input" }, cids: ["b1.7"],
  } });
  wire.finish();
});

test("surface sidecar access rejects an ambiguous declaration instead of selecting a fallback", async () => {
  wire = selectPageWire("surface-runtime-sidecar-ambiguous");
  const { surfaceContextRuntime } = await import("../host.js");
  const runtime = surfaceContextRuntime({ surfaceId: "ambiguous-sidecar-surface", sidecars: [] });
  assert.throws(() => runtime.sidecar(), /exactly one declared sidecar/);
  wire.finish();
});

test("surface clipboard preserves typed payloads instead of adding surface fields", async () => {
  wire = selectPageWire("surface-runtime-clipboard");
  const { surfaceContextRuntime } = await import("../host.js");
  const runtime = surfaceContextRuntime({ surfaceId: "clipboard-surface" });
  await runtime.clipboard.writeText("copied");
  assert.deepEqual(wire.calls, [{ name: "clipboardWriteText", payload: "copied" }]);
  wire.finish();
});

test("the PNG calls of a view name the surface of the view, whose binary store holds the PNG", async () => {
  wire = selectPageWire("surface-runtime-view-png");
  const { surfaceContextRuntime } = await import("../host.js");
  const runtime = surfaceContextRuntime({ surfaceId: "view-surface" });
  await runtime.viewClipboard.readPNG();
  await runtime.viewClipboard.persistPNG("0123456789abcdef0123456789abcdef");
  assert.deepEqual(wire.calls, [
    { name: "clipboardReadViewPNG", payload: { userInitiated: true, surface: "view-surface" } },
    { name: "clipboardPersistViewPNG", payload: { binary: "0123456789abcdef0123456789abcdef", surface: "view-surface" } },
  ]);
  wire.finish();
});

test("surface exposure replies retain the logical surface scope", async () => {
  wire = selectPageWire("surface-runtime-exposure-reply");
  const dom = new JSDOM("<body></body>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  const { surfaceContextRuntime } = await import("../host.js");
  const { dispatchSurfaceRequest, registry } = await import("../exposure.js");
  const surface = "reply-scope-surface";
  const plugin = "reply-scope-plugin";
  const declarations = {
    status: [],
    commands: [{ name: `${plugin}.ping`, description: "Replies.", params: { type: "object" }, result: { type: "string" } }],
    element: [],
  };
  registry.declare(plugin, declarations);
  registry.configure({ surfacePlugin: (id) => id === surface ? plugin : null });
  const runtime = surfaceContextRuntime({ surfaceId: surface }, declarations);
  await runtime.exposure.command(`${plugin}.ping`, () => "ok");

  assert.equal(await dispatchSurfaceRequest({
    surface, id: 17, method: "command.run", params: { name: `${plugin}.ping`, params: {} },
  }), true);
  await settled();
  assert.deepEqual(wire.calls, [{ name: "exposureReply", payload: { id: 17, result: "ok", surface } }]);
  await runtime.exposure.dispose();
  dom.window.close();
  wire.finish();
});

test("an installed reply gate decides when a surface exposure reply is sent", async () => {
  wire = selectPageWire("surface-runtime-exposure-reply-gate");
  const dom = new JSDOM("<body></body>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  const { surfaceContextRuntime } = await import("../host.js");
  const { gateSurfaceReplies } = await import("../exposure.js");
  const { dispatchSurfaceRequest, registry } = await import("../exposure.js");
  const surface = "gated-reply-surface";
  const plugin = "gated-reply-plugin";
  const declarations = {
    status: [],
    commands: [{ name: `${plugin}.ping`, description: "Replies.", params: { type: "object" }, result: { type: "string" } }],
    element: [],
  };
  registry.declare(plugin, declarations);
  registry.configure({ surfacePlugin: (id) => id === surface ? plugin : null });
  const gated = [];
  let gateArrived;
  const holding = new Promise((resolve) => { gateArrived = resolve; });
  gateSurfaceReplies((id, send) => new Promise((resolve) => {
    gated.push({ id, send: () => resolve(send()) });
    gateArrived();
  }));
  try {
    const runtime = surfaceContextRuntime({ surfaceId: surface }, declarations);
    await runtime.exposure.command(`${plugin}.ping`, () => "ok");
    await dispatchSurfaceRequest({ surface, id: 18, method: "command.run", params: { name: `${plugin}.ping`, params: {} } });
    // The gate receives the reply before it can be sent, so the check runs once the gate holds it.
    await holding;
    assert.deepEqual(wire.calls, [], "the gate did not hold the reply");
    assert.deepEqual(gated.map((entry) => entry.id), [surface]);
    gated[0].send();
    await settled();
    assert.deepEqual(wire.calls, [{ name: "exposureReply", payload: { id: 18, result: "ok", surface } }]);
    await runtime.exposure.dispose();
    wire.finish();
  } finally {
    gateSurfaceReplies(null);
    dom.window.close();
  }
});

test("an installed reply gate decides when the exposure reply of a view is sent", async () => {
  // A view answers a forwarded exposure request through the native call exposureReply of its surface
  // (docs/spec/native-surfaces.md#view-surfaces), so that reply passes the same gate as a reply of a mounted surface.
  wire = selectPageWire("surface-runtime-view-reply-gate");
  const { surfaceContextRuntime } = await import("../host.js");
  const { gateSurfaceReplies } = await import("../exposure.js");
  const surface = "gated-view-surface";
  const gated = [];
  let gateArrived;
  const holding = new Promise((resolve) => { gateArrived = resolve; });
  gateSurfaceReplies((id, send) => new Promise((resolve) => {
    gated.push({ id, send: () => resolve(send()) });
    gateArrived();
  }));
  try {
    const runtime = surfaceContextRuntime({ surfaceId: surface });
    const sent = runtime.native.call("exposureReply", { id: 19, result: "ok" });
    await holding;
    assert.deepEqual(wire.calls, [], "the gate did not hold the reply of the view");
    assert.deepEqual(gated.map((entry) => entry.id), [surface]);
    gated[0].send();
    await sent;
    assert.deepEqual(wire.calls, [{ name: "exposureReply", payload: { id: 19, result: "ok", surface } }]);
    wire.finish();
  } finally {
    gateSurfaceReplies(null);
  }
});

test("surface sidecar sends reach the host one at a time in send order", async () => {
  wire = selectPageWire("surface-runtime-sidecar-order");
  const { surfaceContextRuntime } = await import("../host.js");
  const first = surfaceContextRuntime({ surfaceId: "ordered-a", sidecars: ["@fixture/ordered"] }).sidecar();
  const second = surfaceContextRuntime({ surfaceId: "ordered-b", sidecars: ["@fixture/ordered"] }).sidecar();
  const sent = [
    first.send("ordered-a", { operation: "selection.start" }),
    first.send("ordered-a", { operation: "selection.update" }),
    second.send("ordered-b", { operation: "open" }),
  ];
  const operations = () => wire.calls.filter(({ name }) => name === "sidecarSend").map(({ payload }) => payload.body.operation);
  for (const expected of [["selection.start"], ["selection.start", "selection.update"], ["selection.start", "selection.update", "open"]]) {
    await settled();
    assert.deepEqual(operations(), expected, "a send reached the host before the previous send finished");
    wire.release();
  }
  await Promise.all(sent);
  wire.finish();
});

test("disposing surface exposure removes its request callback", async () => {
  wire = selectPageWire("surface-runtime-no-host-calls");
  const { surfaceContextRuntime } = await import("../host.js");
  const { dispatchSurfaceRequest, registry } = await import("../exposure.js");
  const surface = "disposed-port-surface", plugin = "disposed-port-plugin";
  const declarations = { commands: [{ name: `${plugin}.ping`, description: "Replies.", params: { type: "object" }, result: { type: "string" } }] };
  registry.declare(plugin, declarations);
  registry.configure({ surfacePlugin: (id) => id === surface ? plugin : null });
  const runtime = surfaceContextRuntime({ surfaceId: surface }, declarations);
  await runtime.exposure.command(`${plugin}.ping`, () => "old");
  await runtime.exposure.dispose();
  assert.equal(await dispatchSurfaceRequest({ surface, id: 71, method: "command.run", params: { name: `${plugin}.ping`, params: {} } }), false,
    "disposed surface retained its request callback");
  wire.finish();
});

test("a disposed surface ID can be reused and previous disposal cannot remove its new owner", async () => {
  wire = selectPageWire("surface-runtime-no-host-calls");
  const { surfaceContextRuntime } = await import("../host.js");
  const { registry } = await import("../exposure.js");
  const surface = "reused-port-surface", plugin = "reused-port-plugin";
  const declarations = { commands: [{ name: `${plugin}.ping`, description: "Replies.", params: { type: "object" }, result: { type: "string" } }] };
  registry.declare(plugin, declarations);
  registry.configure({ surfacePlugin: (id) => id === surface ? plugin : null });
  const first = surfaceContextRuntime({ surfaceId: surface }, declarations);
  await first.exposure.command(`${plugin}.ping`, () => "old");
  await first.exposure.dispose();
  const next = surfaceContextRuntime({ surfaceId: surface }, declarations);
  try {
    await assert.doesNotReject(next.exposure.command(`${plugin}.ping`, () => "new"), "disposed callback blocked its replacement");
    await first.exposure.dispose();
    assert.deepEqual(registry.registrants("command", `${plugin}.ping`), [surface], "previous disposal removed new registrations");
  } finally {
    await next.exposure.dispose();
  }
  wire.finish();
});

// A view relays its status and element registrations to the registry without a request callback of the surface port, so the
// disposal of the exposure removes them although the view registered no command.
test("disposing the exposure of a view removes the registrations it relayed, and a second disposal keeps its new owner", async () => {
  wire = selectPageWire("surface-runtime-no-host-calls");
  const { surfaceContextRuntime } = await import("../host.js");
  const { registry } = await import("../exposure.js");
  const surface = "relayed-port-surface", plugin = "relayed-port-plugin";
  const status = `${plugin}.lines`;
  const declarations = { status: [{ name: status, description: "Lines.", schema: { type: "array" } }] };
  registry.declare(plugin, declarations);
  registry.configure({ surfacePlugin: (id) => id === surface ? plugin : null });
  const first = surfaceContextRuntime({ surfaceId: surface }, declarations);
  registry.registered({ surface, kind: "status", name: status });
  await first.exposure.dispose();
  assert.deepEqual(registry.registrants("status", status), [], "the disposed view kept its relayed registration");
  const next = surfaceContextRuntime({ surfaceId: surface }, declarations);
  try {
    registry.registered({ surface, kind: "status", name: status });
    await first.exposure.dispose();
    assert.deepEqual(registry.registrants("status", status), [surface], "a repeated disposal removed the registration of the new owner");
  } finally {
    await next.exposure.dispose();
  }
  wire.finish();
});

test("a surface sidecar send to another surface is rejected instead of being redirected", async () => {
  wire = selectPageWire("surface-runtime-no-host-calls");
  const { surfaceContextRuntime } = await import("../host.js");
  const port = surfaceContextRuntime({ surfaceId: "own-surface", sidecars: ["@fixture/sidecar"] }).sidecar();
  await assert.rejects(port.send("other-surface", { operation: "open" }), /own-surface cannot send to sidecar surface other-surface/);
  assert.equal(wire.calls.some(({ name }) => name === "sidecarSend"), false);
  wire.finish();
});

test("a surface runtime without a surface id is rejected instead of using another field", async () => {
  wire = selectPageWire("surface-runtime-no-host-calls");
  const dom = new JSDOM("<body></body>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  const { surfaceContextRuntime } = await import("../host.js");
  assert.throws(() => surfaceContextRuntime({ id: "old-shape" }), /surface\.surfaceId/);
  dom.window.close();
  wire.finish();
});

test("a surface sidecar failure reaches the surface's failure handler and no page error is raised", async () => {
  wire = selectPageWire("surface-runtime-sidecar-failure");
  const errors = windowErrors();
  try {
    // The failure listener is installed once per module, so this test has the copy of the module that installs it in its own case.
    const { surfaceContextRuntime } = await import("../host.js?failure-handler");
    const port = surfaceContextRuntime({ surfaceId: "failing-surface", sidecars: ["@fixture/failing"] }).sidecar();
    const reasons = [];
    const off = await port.onFailure("failing-surface", (reason) => reasons.push(reason));
    assert.equal(typeof off, "function");
    await assert.rejects(port.onFailure("other-surface", () => {}), /failing-surface cannot observe sidecar surface other-surface/);
    wire.deliverNotice();
    assert.deepEqual(reasons, ["message exceeds 67108864 bytes"]);
    assert.deepEqual(errors.messages, []);
    off();
    wire.deliverNotice();
    assert.deepEqual(reasons, ["message exceeds 67108864 bytes"], "a removed handler is not called");
    assert.deepEqual(errors.messages, ["sidecar @fixture/failing failed for surface failing-surface: output closed: exit status 3"]);
    wire.finish();
  } finally {
    errors.close();
  }
});

test("a sidecar failure without a handler becomes a page error", async () => {
  wire = selectPageWire("surface-runtime-sidecar-failure-unhandled");
  const errors = windowErrors();
  try {
    const { windowSidecar } = await import("../host.js?failure-unhandled");
    await windowSidecar("@fixture/background").send("background-tab", { operation: "open" });
    wire.deliverNotice();
    assert.deepEqual(errors.messages, ["sidecar @fixture/background failed for surface background-tab: invalid message: body is missing"]);
    wire.finish();
  } finally {
    errors.close();
  }
});

test("the first sidecar request waits until the failure listener is installed", async () => {
  // The case holds the registration of the listener of sidecar-failure until the test releases it.
  wire = selectPageWire("surface-runtime-sidecar-failure-listener-order");
  const { windowSidecar } = await import("../host.js?test=failure-listener-order");
  const sent = windowSidecar("@fixture/ordered-failure").send("first-tab", { operation: "open" });
  // The installation has started and is not finished. The send runs in microtasks until it waits for the installation, so after
  // the end of the microtask queue a send that did not wait for it has called the host.
  await drained();
  assert.deepEqual(wire.calls.filter(({ name }) => name === "sidecarSend"), [], "no request before the failure listener is installed");
  wire.release();
  await sent;
  assert.deepEqual(wire.calls.filter(({ name }) => name === "sidecarSend").map(({ payload }) => payload.surface), ["first-tab"]);
  wire.finish();
});

test("private view sidecar authority survives the shared ordered IPC queue unchanged", async () => {
  wire = selectPageWire("surface-runtime-view-sidecar-queue");
  const hostModule = await import("../host.js");
  assert.equal(typeof hostModule.sendViewSidecar, "function", "the private view-sidecar bridge must preserve original source authority");
  const sidecar = "@fixture/typed-shared-queue";
  const first = hostModule.surfaceContextRuntime({ surfaceId: "background", sidecars: [sidecar] }).sidecar().send("background", { operation: "blocking" });
  await settled();
  const original = { source: "same-source", surface: "same-source", generation: 41, sidecar, body: { operation: "old-A" }, cids: ["a"] };
  const old = hostModule.sendViewSidecar(original);
  original.generation = 42;
  const current = hostModule.sendViewSidecar({ ...original, body: { operation: "new-B" }, cids: ["b"] });
  await settled();
  assert.equal(wire.calls.filter(({ name }) => name === "viewSidecarSend").length, 0, "view IPC overtook the blocked window send");
  wire.release();
  await Promise.all([first, old, current]);
  assert.deepEqual(wire.calls.filter(({ name }) => name === "sidecarSend" || name === "viewSidecarSend"), [
    { name: "sidecarSend", payload: { sidecar, surface: "background", body: { operation: "blocking" }, cids: [] } },
    { name: "viewSidecarSend", payload: { source: "same-source", surface: "same-source", generation: 41, sidecar, body: { operation: "old-A" }, cids: ["a"] } },
    { name: "viewSidecarSend", payload: { source: "same-source", surface: "same-source", generation: 42, sidecar, body: { operation: "new-B" }, cids: ["b"] } },
  ]);
  wire.finish();
});

test("the private view sidecar bridge rejects missing or redirected source authority", async () => {
  wire = selectPageWire("surface-runtime-view-sidecar-authority");
  const hostModule = await import("../host.js");
  assert.equal(typeof hostModule.sendViewSidecar, "function", "private view-sidecar entry must be implemented");
  for (const change of [request => { delete request.generation; }, request => { request.generation = 0; }, request => { request.surface = "other"; }]) {
    const request = { source: "owned", surface: "owned", generation: 1, sidecar: "@fixture/typed-authority", body: {}, cids: [] };
    change(request);
    await assert.rejects(Promise.resolve().then(() => hostModule.sendViewSidecar(request)), /authority|generation|source/);
  }
  assert.deepEqual(wire.calls, []);
  wire.finish();
});
