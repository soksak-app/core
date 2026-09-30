import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { JSDOM } from "jsdom";

const calls = [];
let registerEventListener;
/* 호출 하나의 완료를 검사가 정할 때 쓴다. 없으면 호출은 바로 끝난다. */
let answerCall;
mock.module("@soksak/runtime", {
  namedExports: {
    host: {
      call: async (name, payload) => {
        calls.push([name, payload]);
        return answerCall ? answerCall(name, payload) : null;
      },
      on: (name, callback) => {
        registerEventListener?.(name, callback);
        return Promise.resolve(() => {});
      },
    },
  },
});

test("surface event subscription resolves only after the native listener is installed", async () => {
  const dom = new JSDOM("<body></body>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  const { surfaceContextRuntime } = await import("../host.js");
  const surface = "event-ready-surface";
  let installed = false;
  registerEventListener = () => { installed = true; };
  const runtime = surfaceContextRuntime({ surfaceId: surface });

  const off = await runtime.native.on("shell-status", () => {});
  assert.equal(installed, true);
  assert.equal(typeof off, "function");
  off();
  registerEventListener = undefined;
  dom.window.close();
});

test("surface sidecar access is resolved from the declared surface and rejects package names", async () => {
  const { surfaceContextRuntime } = await import("../host.js");
  calls.length = 0;
  const runtime = surfaceContextRuntime({ surfaceId: "declared-sidecar-surface", sidecars: ["@fixture/sidecar"] });
  const port = runtime.sidecar();
  await port.send("declared-sidecar-surface", { operation: "open" });
  assert.deepEqual(calls.at(-1), ["sidecarSend", {
    sidecar: "@fixture/sidecar", surface: "declared-sidecar-surface", body: { operation: "open" },
  }]);
  assert.throws(() => runtime.sidecar("@fixture/sidecar"), /does not accept a package name/);
});

test("surface sidecar access rejects an ambiguous declaration instead of selecting a fallback", async () => {
  const { surfaceContextRuntime } = await import("../host.js");
  const runtime = surfaceContextRuntime({ surfaceId: "ambiguous-sidecar-surface", sidecars: [] });
  assert.throws(() => runtime.sidecar(), /exactly one declared sidecar/);
});

test("surface clipboard preserves typed payloads instead of adding surface fields", async () => {
  const { surfaceContextRuntime } = await import("../host.js");
  calls.length = 0;
  const runtime = surfaceContextRuntime({ surfaceId: "clipboard-surface" });
  await runtime.clipboard.writeText("copied");
  assert.deepEqual(calls, [["clipboardWriteText", "copied"]]);
});

test("surface exposure replies retain the logical surface scope", async () => {
  const dom = new JSDOM("<body></body>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  const { surfaceContextRuntime } = await import("../host.js");
  const { dispatchSurfaceRequest, registry } = await import("../exposure.js");
  const surface = "reply-scope-surface";
  const plugin = "reply-scope-plugin";
  const declarations = {
    status: [],
    commands: [{ name: `${plugin}.ping`, description: "Replies.", params: { type: "object" }, result: { type: "string" } }],
    dom: [],
  };
  registry.declare(plugin, declarations);
  registry.configure({ surfacePlugin: (id) => id === surface ? plugin : null });
  const runtime = surfaceContextRuntime({ surfaceId: surface }, declarations);
  await runtime.exposure.command(`${plugin}.ping`, () => "ok");
  calls.length = 0;

  assert.equal(await dispatchSurfaceRequest({
    surface, id: 17, method: "command.run", params: { name: `${plugin}.ping`, params: {} },
  }), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [["exposureReply", { id: 17, result: "ok", surface }]]);
  await runtime.exposure.dispose();
  dom.window.close();
});

test("surface sidecar sends reach the host one at a time in send order", async () => {
  const { surfaceContextRuntime } = await import("../host.js");
  calls.length = 0;
  const pending = [];
  answerCall = () => new Promise((resolve) => pending.push(resolve));
  const first = surfaceContextRuntime({ surfaceId: "ordered-a", sidecars: ["@fixture/ordered"] }).sidecar();
  const second = surfaceContextRuntime({ surfaceId: "ordered-b", sidecars: ["@fixture/ordered"] }).sidecar();
  const sent = [
    first.send("ordered-a", { operation: "selection.start" }),
    first.send("ordered-a", { operation: "selection.update" }),
    second.send("ordered-b", { operation: "open" }),
  ];
  const operations = () => calls.filter(([name]) => name === "sidecarSend").map(([, payload]) => payload.body.operation);
  for (const expected of [["selection.start"], ["selection.start", "selection.update"], ["selection.start", "selection.update", "open"]]) {
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(operations(), expected, "a send reached the host before the previous send finished");
    pending.shift()();
  }
  await Promise.all(sent);
  answerCall = undefined;
});

test("disposing surface exposure removes its request callback", async () => {
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
});

test("a disposed surface ID can be reused and previous disposal cannot remove its new owner", async () => {
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
});

test("a surface sidecar send to another surface is rejected instead of being redirected", async () => {
  const { surfaceContextRuntime } = await import("../host.js");
  calls.length = 0;
  const port = surfaceContextRuntime({ surfaceId: "own-surface", sidecars: ["@fixture/sidecar"] }).sidecar();
  await assert.rejects(port.send("other-surface", { operation: "open" }), /own-surface cannot send to sidecar surface other-surface/);
  assert.equal(calls.some(([name]) => name === "sidecarSend"), false);
});

test("a surface runtime without a surface id is rejected instead of using another field", async () => {
  const dom = new JSDOM("<body></body>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  const { surfaceContextRuntime } = await import("../host.js");
  assert.throws(() => surfaceContextRuntime({ id: "old-shape" }), /surface\.surfaceId/);
  dom.window.close();
});
