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
    // 이 검사만 별도의 모듈 사본을 쓴다 — 런타임은 첫 불러오기에 window 를 붙잡는다.
    const { host } = await import("../runtime/index.js?test=performance-command");
    await host.call("performance", { action: "on" });
    assert.deepEqual(calls, [["performance", { request: { action: "on" } }]]);
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
    // 이 검사만 별도의 모듈 사본을 쓴다 — 런타임은 첫 불러오기에 window 를 붙잡는다.
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
