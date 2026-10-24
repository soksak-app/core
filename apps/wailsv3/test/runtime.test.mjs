import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

// A document of a surface asks the host for the log policy at its load (action policy-read); the fake host answers it with the
// default policy and does not record it.
const policyRead = { classes: { lifecycle: "error", input: "error", call: "error", io: "error", frame: "error" } };

test("surface readiness invokes the registered native presentation method", async () => {
  const calls = [];
  globalThis.window = {
    __soksakNative: {
      call: async (method, args) => {
        calls.push([method, args]);
        return 42;
      },
      on: async () => () => {},
    },
  };
  globalThis.location = { search: "" };
  try {
    const { host } = await import("../runtime/index.js");
    assert.equal(await host.call("waitPresented"), 42);
    assert.deepEqual(calls, [["WaitPresented", []]]);
  } finally {
    delete globalThis.window;
    delete globalThis.location;
  }
});

test("the performance trace command carries the page request to the host", async () => {
  const calls = [];
  globalThis.window = { __soksakNative: { call: async (method, args) => { if (method === "Log" && args[0].action === "policy-read") return Promise.resolve(policyRead); calls.push([method, args]); return null; }, on: () => () => {} } };
  globalThis.location = { search: "?id=tab" };
  try {
    // Only this check uses a separate copy of the module, because the runtime captures window on its first load.
    const { host } = await import("../runtime/index.js?test=performance-command");
    await host.call("performance", { action: "line", line: { event: "action" } });
    assert.deepEqual(calls, [["Performance", [{ action: "line", line: { event: "action" } }]]]);
  } finally {
    delete globalThis.window;
    delete globalThis.location;
  }
});

test("a page sidecar failure reaches only the listener of that sidecar and surface", async () => {
  const listeners = [];
  globalThis.window = { __soksakNative: {
    call: async (method, args) => { if (method === "Log" && args[0].action === "policy-read") return Promise.resolve(policyRead); return null; },
    on: (event, fn) => { listeners.push([event, fn]); return () => {}; },
  } };
  globalThis.location = { search: "?id=s1" };
  try {
    // Only this check uses a separate copy of the module, because the runtime captures window on its first load.
    const { page } = await import("../runtime/index.js?test=sidecar-failure");
    const reasons = [];
    const off = await page.sidecar("@x/side").onFailure("s1", (reason) => reasons.push(reason));
    assert.equal(typeof off, "function");
    const [event, deliver] = listeners.at(-1);
    assert.equal(event, "sidecar-failure");
    deliver({ sidecar: "@x/side", surface: "s2", reason: "another surface" });
    deliver({ sidecar: "@x/other", surface: "s1", reason: "another sidecar" });
    deliver({ sidecar: "@x/side", surface: "s1", reason: "output closed: exit status 3" });
    assert.deepEqual(reasons, ["output closed: exit status 3"]);
  } finally {
    delete globalThis.window;
    delete globalThis.location;
  }
});

test("the log command carries the page batch to the host", async () => {
  const calls = [];
  globalThis.window = { __soksakNative: { call: async (method, args) => { if (method === "Log" && args[0].action === "policy-read") return Promise.resolve(policyRead); calls.push([method, args]); return null; }, on: () => () => {} } };
  globalThis.location = { search: "?id=tab" };
  try {
    const { host } = await import("../runtime/index.js?test=log-command");
    await host.call("log", { action: "batch", events: [] });
    assert.deepEqual(calls, [["Log", [{ action: "batch", events: [] }]]]);
  } finally {
    delete globalThis.window;
    delete globalThis.location;
  }
});

test("a call of the main page that carries out an operation sends its identifiers beside its arguments", async () => {
  const calls = [];
  register("./support/wails-runtime-loader.mjs", import.meta.url);
  globalThis.__wailsRuntime = {
    Call: { ByName: async (name, method, args, cids) => { calls.push([name, method, args, cids]); return null; } },
    Window: { Name: async () => "main" },
    Events: { On: () => () => {} },
  };
  globalThis.window = {};
  globalThis.location = { search: "" };
  try {
    const { host } = await import("../runtime/index.js?test=main-cids");
    await host.call("windowNew", undefined, { cids: ["p1.1"] });
    await host.call("pluginsRun", { action: "install", plugin: "term" }, { cids: ["p1.2"] });
    await host.call("pluginsStarter", { state: "pending", pack: "starter", registry: "file:///registry/index.json", plugins: ["term"] });
    await host.call("windowReady");
    const service = "github.com/soksak-app/core/packages/host/wailsv3/src.Bindings.Call";
    assert.deepEqual(calls, [
      [service, "WindowNew", [], ["p1.1"]],
      [service, "PluginsRun", [{ action: "install", plugin: "term" }], ["p1.2"]],
      [service, "PluginsStarter", [{ state: "pending", pack: "starter", registry: "file:///registry/index.json", plugins: ["term"] }], []],
      [service, "WindowReady", [], []],
    ]);
  } finally {
    delete globalThis.__wailsRuntime;
    delete globalThis.window;
    delete globalThis.location;
  }
});
