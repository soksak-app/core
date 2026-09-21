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
