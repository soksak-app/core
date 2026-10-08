import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { JSDOM } from "jsdom";

const calls = [];
let registerEventListener;
/* 호출 하나의 완료를 검사가 정할 때 쓴다. 없으면 호출은 바로 끝난다. */
let answerCall;
/* 설치된 모든 네이티브 listener. 모듈 상태의 listener 는 앞선 검사에서 설치될 수 있다. */
const nativeListeners = [];
/* listener 설치의 완료를 검사가 정할 때 쓴다. 없으면 설치는 바로 끝난다. */
let installListener;
mock.module("@soksak/runtime", {
  namedExports: {
    host: {
      call: async (name, payload) => {
        calls.push([name, payload]);
        return answerCall ? answerCall(name, payload) : null;
      },
      on: (name, callback) => {
        nativeListeners.push([name, callback]);
        registerEventListener?.(name, callback);
        return installListener ? installListener(name) : Promise.resolve(() => {});
      },
    },
  },
});

/* 창에 보낸 error 이벤트의 message 를 기록한다. */
function windowErrors() {
  const dom = new JSDOM("<body></body>", { url: "http://localhost/" });
  const messages = [];
  globalThis.dispatchEvent = (event) => {
    messages.push(event.message);
    return true;
  };
  globalThis.ErrorEvent = dom.window.ErrorEvent;
  return { messages, close: () => { delete globalThis.dispatchEvent; delete globalThis.ErrorEvent; dom.window.close(); } };
}

/* 설치된 sidecar-failure listener 로 실패 하나를 보낸다. */
function deliverFailure(failure) {
  const installed = nativeListeners.filter(([name]) => name === "sidecar-failure");
  assert.equal(installed.length, 1, "one sidecar-failure listener is installed");
  installed[0][1](failure);
}

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

test("surface sidecar access is resolved from the declared surface and takes no argument", async () => {
  const { surfaceContextRuntime } = await import("../host.js");
  calls.length = 0;
  const runtime = surfaceContextRuntime({ surfaceId: "declared-sidecar-surface", sidecars: ["@fixture/sidecar"] });
  const port = runtime.sidecar();
  await port.send("declared-sidecar-surface", { operation: "open" });
  assert.deepEqual(calls.at(-1), ["sidecarSend", {
    sidecar: "@fixture/sidecar", surface: "declared-sidecar-surface", body: { operation: "open" },
  }]);
  assert.throws(() => runtime.sidecar("@fixture/sidecar"), /takes no argument; it uses the declared sidecar/);
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

test("an installed reply gate decides when a surface exposure reply is sent", async () => {
  const dom = new JSDOM("<body></body>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  const { gateSurfaceReplies, surfaceContextRuntime } = await import("../host.js");
  const { dispatchSurfaceRequest, registry } = await import("../exposure.js");
  const surface = "gated-reply-surface";
  const plugin = "gated-reply-plugin";
  const declarations = {
    status: [],
    commands: [{ name: `${plugin}.ping`, description: "Replies.", params: { type: "object" }, result: { type: "string" } }],
    dom: [],
  };
  registry.declare(plugin, declarations);
  registry.configure({ surfacePlugin: (id) => id === surface ? plugin : null });
  const gated = [];
  gateSurfaceReplies((id, send) => new Promise((resolve) => gated.push({ id, send: () => resolve(send()) })));
  try {
    const runtime = surfaceContextRuntime({ surfaceId: surface }, declarations);
    await runtime.exposure.command(`${plugin}.ping`, () => "ok");
    calls.length = 0;
    await dispatchSurfaceRequest({ surface, id: 18, method: "command.run", params: { name: `${plugin}.ping`, params: {} } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, [], "the gate did not hold the reply");
    assert.deepEqual(gated.map((entry) => entry.id), [surface]);
    gated[0].send();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, [["exposureReply", { id: 18, result: "ok", surface }]]);
    await runtime.exposure.dispose();
  } finally {
    gateSurfaceReplies(null);
    dom.window.close();
  }
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

test("a surface sidecar failure reaches the surface's failure handler and no page error is raised", async () => {
  const errors = windowErrors();
  try {
    const { surfaceContextRuntime } = await import("../host.js");
    const port = surfaceContextRuntime({ surfaceId: "failing-surface", sidecars: ["@fixture/failing"] }).sidecar();
    const reasons = [];
    const off = await port.onFailure("failing-surface", (reason) => reasons.push(reason));
    assert.equal(typeof off, "function");
    await assert.rejects(port.onFailure("other-surface", () => {}), /failing-surface cannot observe sidecar surface other-surface/);
    deliverFailure({ sidecar: "@fixture/failing", surface: "failing-surface", reason: "message exceeds 67108864 bytes" });
    assert.deepEqual(reasons, ["message exceeds 67108864 bytes"]);
    assert.deepEqual(errors.messages, []);
    off();
    deliverFailure({ sidecar: "@fixture/failing", surface: "failing-surface", reason: "output closed: exit status 3" });
    assert.deepEqual(reasons, ["message exceeds 67108864 bytes"], "a removed handler is not called");
    assert.deepEqual(errors.messages, ["sidecar @fixture/failing failed for surface failing-surface: output closed: exit status 3"]);
  } finally {
    errors.close();
  }
});

test("a sidecar failure without a handler becomes a page error", async () => {
  const errors = windowErrors();
  try {
    const { windowSidecar } = await import("../host.js");
    await windowSidecar("@fixture/background").send("background-tab", { operation: "open" });
    deliverFailure({ sidecar: "@fixture/background", surface: "background-tab", reason: "invalid message: body is missing" });
    assert.deepEqual(errors.messages, ["sidecar @fixture/background failed for surface background-tab: invalid message: body is missing"]);
  } finally {
    errors.close();
  }
});

test("the first sidecar request waits until the failure listener is installed", async () => {
  let install;
  installListener = (name) => name === "sidecar-failure"
    ? new Promise((resolve) => { install = () => resolve(() => {}); })
    : Promise.resolve(() => {});
  try {
    // 이 검사만 별도의 모듈 사본을 쓴다 — 실패 listener 는 모듈마다 한 번 설치된다.
    const { windowSidecar } = await import("../host.js?test=failure-listener-order");
    calls.length = 0;
    const sent = windowSidecar("@fixture/ordered-failure").send("first-tab", { operation: "open" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls.filter(([name]) => name === "sidecarSend"), [], "no request before the failure listener is installed");
    assert.equal(typeof install, "function", "the failure listener installation started");
    install();
    await sent;
    assert.deepEqual(calls.filter(([name]) => name === "sidecarSend").map(([, payload]) => payload.surface), ["first-tab"]);
  } finally {
    installListener = undefined;
  }
});
