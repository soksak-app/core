import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { JSDOM } from "jsdom";

const calls = [];
let registerEventListener;
mock.module("@soksak/runtime", {
  namedExports: {
    host: {
      call: async (name, payload) => { calls.push([name, payload]); return null; },
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
