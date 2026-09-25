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
