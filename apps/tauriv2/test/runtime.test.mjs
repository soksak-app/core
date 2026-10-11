import assert from "node:assert/strict";
import test from "node:test";

test("surface readiness invokes the registered native presentation command", async () => {
  const calls = [];
  globalThis.window = { __TAURI__: {
    core: { invoke: async (command, args) => { calls.push([command, args]); return 42; } },
    event: { listen: async () => () => {} },
    webview: { getCurrentWebview: () => ({ label: "main" }) },
  } };
  globalThis.location = { search: "" };
  try {
    const { host } = await import("../runtime/index.js");
    assert.equal(await host.call("waitPresented"), 42);
    assert.deepEqual(calls, [["wait_presented", {}]]);
  } finally {
    delete globalThis.window;
    delete globalThis.location;
  }
});

test("every host command has an argument mapping, so a call never throws before it is sent", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../runtime/index.js", import.meta.url), "utf8");
  const block = (name) => source.slice(source.indexOf(`const ${name} = {`), source.indexOf("\n};", source.indexOf(`const ${name} = {`)));
  const commands = [...block("COMMAND").matchAll(/(\w+):\s*"/g)].map((match) => match[1]).sort();
  const mapped = [...block("ARG").matchAll(/(\w+):\s*\(/g)].map((match) => match[1]).sort();
  assert.ok(commands.includes("notificationState"), `the command list was not read: ${commands.join(", ")}`);
  assert.deepEqual(commands.filter((name) => !mapped.includes(name)), [], "commands without an argument mapping");
  assert.deepEqual(mapped.filter((name) => !commands.includes(name)), [], "argument mappings without a command");
});

test("the performance trace command carries the page request to the host", async () => {
  const calls = [];
  globalThis.window = { __TAURI__: {
    core: { invoke: async (command, args) => { calls.push([command, args]); return null; } },
    event: { listen: async () => () => {} },
    webview: { getCurrentWebview: () => ({ label: "main" }) },
  } };
  globalThis.location = { search: "" };
  try {
    // Only this check uses a separate copy of the module, because the runtime captures window on its first load.
    const { host } = await import("../runtime/index.js?test=performance-command");
    await host.call("performance", { action: "on" });
    assert.deepEqual(calls, [["performance", { request: { action: "on" } }]]);
  } finally {
    delete globalThis.window;
    delete globalThis.location;
  }
});

test("a failed host call rejects with an Error that carries the host's message", async () => {
  globalThis.window = { __TAURI__: {
    core: { invoke: async () => { throw "lstat /missing: no such file or directory"; } },
    event: { listen: async () => () => {} },
    webview: { getCurrentWebview: () => ({ label: "main" }) },
  } };
  globalThis.location = { search: "" };
  try {
    const { host } = await import("../runtime/index.js?string-error");
    await assert.rejects(host.call("projectFolder", "/missing"),
      (error) => error instanceof Error && error.message === "lstat /missing: no such file or directory");
  } finally {
    delete globalThis.window;
    delete globalThis.location;
  }
});

test("a page sidecar failure reaches only the listener of that sidecar and surface", async () => {
  const listeners = [];
  globalThis.window = { __TAURI__: {
    core: { invoke: async () => null },
    event: { listen: async (event, fn) => { listeners.push([event, fn]); return () => {}; } },
    webview: { getCurrentWebview: () => ({ label: "main" }) },
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
    deliver({ payload: { sidecar: "@x/side", surface: "s2", reason: "another surface" } });
    deliver({ payload: { sidecar: "@x/other", surface: "s1", reason: "another sidecar" } });
    deliver({ payload: { sidecar: "@x/side", surface: "s1", reason: "output closed: exit status 3" } });
    assert.deepEqual(reasons, ["output closed: exit status 3"]);
  } finally {
    delete globalThis.window;
    delete globalThis.location;
  }
});

test("the log command carries the page batch to the host", async () => {
  const calls = [];
  globalThis.window = { __TAURI__: {
    core: { invoke: async (command, args) => { calls.push([command, args]); return null; } },
    event: { listen: async () => () => {} },
    webview: { getCurrentWebview: () => ({ label: "main" }) },
  } };
  globalThis.location = { search: "" };
  try {
    const { host } = await import("../runtime/index.js?test=log-command");
    await host.call("log", { action: "batch", events: [] });
    assert.deepEqual(calls, [["log", { request: { action: "batch", events: [] } }]]);
  } finally {
    delete globalThis.window;
    delete globalThis.location;
  }
});

test("a call of the main page that carries out an operation sends its identifiers beside the arguments of the command", async () => {
  const calls = [];
  globalThis.window = { __TAURI__: {
    core: { invoke: async (command, args) => { calls.push([command, args]); return null; } },
    event: { listen: async () => () => {} },
    webview: { getCurrentWebview: () => ({ label: "main" }) },
  } };
  globalThis.location = { search: "" };
  try {
    const { host } = await import("../runtime/index.js?test=main-cids");
    await host.call("windowNew", undefined, { cids: ["p1.1"] });
    await host.call("pluginsRun", { action: "install", plugin: "term" }, { cids: ["p1.2"] });
    await host.call("windowReady");
    assert.deepEqual(calls, [
      ["window_new", { cids: ["p1.1"] }],
      ["plugins_run", { request: { action: "install", plugin: "term" }, cids: ["p1.2"] }],
      ["window_ready", {}],
    ]);
  } finally {
    delete globalThis.window;
    delete globalThis.location;
  }
});
