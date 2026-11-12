// The raise and the lower of a window through a session (host.window.raise, host.window.lower), the lower of the windows of the
// other applications of the run before a check, and the rule that no window check orders a window of its own application: a check
// runs behind the windows of a person and measures a covered window (docs/spec/exposure.md#order-of-a-window).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The lower is read from the module at the call, so a module without it fails each test of the lower and no other test.
import * as harness from "../app.mjs";
import { APP_NAMES, Session } from "../app.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));

test("a session raises and lowers its window through the host commands", () => {
  const sent = [];
  const session = { run: (name, params) => { sent.push([name, params]); return null; } };
  Session.prototype.raise.call(session);
  Session.prototype.lower.call(session);
  assert.deepEqual(sent, [["host.window.raise", {}], ["host.window.lower", {}]]);
});

/** A run root with an endpoint of each application of names, each naming this process, which runs. */
function runRoot(names) {
  const root = mkdtempSync(join(tmpdir(), "soksak-session-order-"));
  for (const name of names) {
    mkdirSync(join(root, `soksak-check-${name}`));
    writeFileSync(join(root, `soksak-check-${name}`, "endpoint.json"), JSON.stringify({ pid: process.pid }));
  }
  return root;
}

/** A connection that answers windows.list with two windows and records each request of the application of configDir. */
function recordingConnect(requests) {
  return async ({ configDir }) => {
    const app = configDir.slice(configDir.lastIndexOf("soksak-check-") + "soksak-check-".length);
    return {
      request: async (method, params) => {
        if (method === "windows.list") return [{ window: "main" }, { window: "second" }];
        requests.push(`${app} ${method} ${params.window} ${params.name}`);
        return null;
      },
      close: () => requests.push(`${app} close`),
    };
  };
}

test("a check lowers every window of the other applications of the run and no window of its own application", async () => {
  const root = runRoot(APP_NAMES);
  try {
    const requests = [];
    const lowered = await harness.lowerOtherRunWindows("mygo", { env: { SOKSAK_CONFIG_ROOT: root }, connectTo: recordingConnect(requests), inUse: () => false });
    assert.deepEqual(lowered, ["wailsv3 main", "wailsv3 second", "tauriv2 main", "tauriv2 second"]);
    assert.deepEqual(requests, [
      "wailsv3 command.run main host.window.lower", "wailsv3 command.run second host.window.lower", "wailsv3 close",
      "tauriv2 command.run main host.window.lower", "tauriv2 command.run second host.window.lower", "tauriv2 close",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a check does not lower an application that a session of the run uses or that has no endpoint", async () => {
  const root = runRoot(["wailsv3", "mygo"]);
  try {
    const requests = [];
    const lowered = await harness.lowerOtherRunWindows("mygo", { env: { SOKSAK_CONFIG_ROOT: root }, connectTo: recordingConnect(requests), inUse: (name) => name === "wailsv3" });
    assert.deepEqual(lowered, []);
    assert.deepEqual(requests, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a lower that an application refuses fails the check and names that application", async () => {
  const root = runRoot(["tauriv2"]);
  try {
    let closed = false;
    const connectTo = async () => ({
      request: async (method) => {
        if (method === "windows.list") return [{ window: "main" }];
        throw new Error("the window is not ordered in");
      },
      close: () => { closed = true; },
    });
    await assert.rejects(harness.lowerOtherRunWindows("wailsv3", { env: { SOKSAK_CONFIG_ROOT: root }, connectTo, inUse: () => false }),
      /tauriv2: the lower of its windows before the check of wailsv3 failed: the window is not ordered in/);
    assert.equal(closed, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** The JavaScript files under directory, without node_modules. */
function scripts(directory) {
  return readdirSync(directory).flatMap((name) => {
    if (name === "node_modules") return [];
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return scripts(path);
    return /\.(m?js)$/.test(name) ? [path] : [];
  });
}

test("no window check orders a window of its own application", () => {
  const orders = /host\.window\.(raise|lower)|\.(raise|lower)\(/;
  const found = [];
  // The paths are joined from their parts: the source audit of the window checks refuses a path literal of a package.
  const harness = join("packages", "window-check");
  for (const path of [...scripts(join(root, "e2e")), ...scripts(join(root, harness))]) {
    const name = relative(root, path);
    if (name === join(harness, "test", "session-order.test.mjs")) continue;
    readFileSync(path, "utf8").split("\n").forEach((line, index) => {
      // The two methods of the session are the entries for host use; the check package itself calls neither. The lower of the
      // windows of the other applications of the run is the one order that the package makes.
      if (name === join(harness, "app.mjs") && /^\s+return this\.run\("host\.window\.(raise|lower)", \{\}\);$/.test(line)) return;
      if (name === join(harness, "app.mjs")
        && line.trim() === 'await client.request("command.run", { window: window.window, name: "host.window.lower", params: {} });') return;
      // A comment calls nothing.
      if (/^\s*(\/\/|\/?\*)/.test(line)) return;
      if (orders.test(line)) found.push(`${name}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(found, []);
});
