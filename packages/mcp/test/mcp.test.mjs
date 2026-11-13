import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
// The case player replays the endpoint contract cases of docs/spec/cases/endpoint, which the host answers.
import { startCasePlayer } from "@soksak/client/testing";

const server = fileURLToPath(new URL("../mcp.js", import.meta.url));
const modernMeta = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "test", version: "0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

// Starts the MCP server and returns the request function.
function startMcp(t, args) {
  const child = spawn(process.execPath, [server, ...args], { stdio: ["pipe", "pipe", "pipe"] });
  const waiting = new Map();
  const outputs = [];
  let stderr = "";
  const stderrWaiters = new Set();
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    for (const waiter of [...stderrWaiters]) waiter();
  });
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    outputs.push(message);
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
  });
  const exited = new Promise((resolve) => child.on("close", resolve));
  t.after(async () => {
    child.stdin.end();
    await exited;
  });
  let nextId = 1;
  return {
    child,
    outputs,
    stderr: () => stderr,
    // Resolves when stderr shows content that matches the pattern.
    stderrLine(pattern) {
      return new Promise((resolve) => {
        const waiter = () => {
          if (!pattern.test(stderr)) return;
          stderrWaiters.delete(waiter);
          resolve();
        };
        stderrWaiters.add(waiter);
        waiter();
      });
    },
    exited,
    send(line) {
      child.stdin.write(`${line}\n`);
    },
    request(method, params, id = nextId++) {
      return new Promise((resolve) => {
        waiting.set(id, resolve);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })}\n`);
      });
    },
    // A request of the modern form.
    modern(method, params = {}) {
      return this.request(method, { ...params, _meta: modernMeta });
    },
  };
}

// Starts the player of a case and closes it after the test. Closing throws when the case was not played to its end.
async function play(t, name) {
  const endpoint = await startCasePlayer(name);
  t.after(() => endpoint.close());
  return endpoint;
}

/** Resolves when the player receives a request that satisfies the predicate. Call it before the request is sent. */
const requested = (endpoint, predicate) => new Promise((resolve) => {
  const listener = (message) => {
    if (!predicate(message)) return;
    endpoint.events.off("request", listener);
    resolve(message);
  };
  endpoint.events.on("request", listener);
});

async function fixture(t, name, args = []) {
  const endpoint = await play(t, name);
  const mcp = startMcp(t, ["--config-dir", endpoint.configDir, ...args]);
  return { endpoint, mcp };
}

function parseText(result) {
  assert.equal(result.content[0].type, "text");
  return JSON.parse(result.content[0].text);
}

test("legacy initialize handshake then tools/list", async (t) => {
  const { mcp } = await fixture(t, "mcp-tools-list");
  const init = await mcp.request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  });
  assert.equal(init.result.protocolVersion, "2025-11-25");
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
  assert.equal(init.result.serverInfo.name, "sok-mcp");
  mcp.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
  const list = await mcp.request("tools/list", {});
  assert.equal(list.result.resultType, undefined);
  const names = list.result.tools.map((tool) => tool.name);
  assert.deepEqual(names, [
    "windows_list",
    "status_get",
    "status_watch_once",
    "command_run_core_project_open",
    "command_run_host_window_reload",
    "element_rect",
    "element_act",
    "input_pointer",
    "input_key",
    "input_text",
  ]);
  for (const name of names) assert.match(name, /^[A-Za-z0-9_.-]{1,128}$/);
  // A notification gets no response.
  assert.equal(mcp.outputs.length, 2);
});

test("server/discover lists the supported versions", async (t) => {
  const { mcp } = await fixture(t, "no-request");
  const reply = await mcp.modern("server/discover");
  assert.equal(reply.result.resultType, "complete");
  assert.deepEqual(reply.result.supportedVersions, ["2026-07-28", "2025-11-25"]);
  assert.deepEqual(reply.result.capabilities, { tools: {} });
  assert.equal(reply.result._meta["io.modelcontextprotocol/serverInfo"].name, "sok-mcp");
});

test("modern tools/list generates schemas from exposure.list of the key window", async (t) => {
  const { endpoint, mcp } = await fixture(t, "mcp-tools-list");
  const reply = await mcp.modern("tools/list");
  assert.equal(reply.result.resultType, "complete");
  const tools = Object.fromEntries(reply.result.tools.map((tool) => [tool.name, tool]));
  assert.deepEqual(tools.status_get.inputSchema.properties.name.enum, ["core.screen", "host.window"]);
  assert.deepEqual(tools.element_rect.inputSchema.properties.name.enum, ["core.tab"]);
  assert.deepEqual(tools.command_run_core_project_open.inputSchema.properties.params, {
    type: "object",
    properties: { root: { type: "string" } },
  });
  assert.deepEqual(
    endpoint.requests.map((m) => [m.method, m.params]),
    [
      ["windows.list", undefined],
      ["exposure.list", { window: "main" }],
    ],
  );
});

test("--window selects the window without windows.list", async (t) => {
  const { endpoint, mcp } = await fixture(t, "exposure-list", ["--window", "main"]);
  await mcp.modern("tools/list");
  assert.deepEqual(endpoint.requests.map((m) => m.method), ["exposure.list"]);
});

test("tools/call maps tools to endpoint methods", async (t) => {
  const { endpoint, mcp } = await fixture(t, "mcp-tools-call", ["--window", "main"]);
  const call = async (name, args) => {
    const reply = await mcp.modern("tools/call", { name, arguments: args });
    assert.equal(reply.result.resultType, "complete");
    assert.equal(reply.result.isError, undefined, JSON.stringify(reply.result));
    return parseText(reply.result);
  };
  assert.equal((await call("windows_list", {}))[0].window, "main");
  assert.equal(await call("status_get", { name: "core.screen" }), "home");
  assert.equal(await call("status_get", { name: "core.screen", surface: "tab-a" }), "home");
  assert.deepEqual(await call("command_run_core_project_open", { params: { root: "/p" } }), { opened: "/p" });
  assert.equal((await call("element_rect", { name: "core.tab", index: 1 })).index, 1);
  assert.equal(await call("element_act", { name: "core.tab", action: "input", value: "v" }), null);
  assert.equal(await call("input_pointer", { x: 1, y: 2, phase: "move" }), null);
  assert.equal(await call("input_pointer", { x: 1, y: 2, phase: "down", button: "right" }), null);
  assert.equal(await call("input_pointer", { x: 1, y: 2, phase: "move", activate: true }), null);
  assert.equal(await call("input_pointer", { x: 1, y: 2, phase: "down", clicks: 2 }), null);
  assert.equal(await call("input_key", { key: "Enter", phase: "down", modifiers: ["shift"] }), null);
  assert.equal(await call("input_text", { phase: "mark", text: "한", selection: { start: 0, length: 1 } }), null);
  assert.deepEqual(
    endpoint.requests.map((m) => [m.method, m.params]),
    [
      ["windows.list", undefined],
      ["status.get", { window: "main", name: "core.screen" }],
      ["status.get", { window: "main", name: "core.screen", surface: "tab-a" }],
      ["command.run", { window: "main", name: "core.project.open", params: { root: "/p" } }],
      ["element.rect", { window: "main", name: "core.tab", index: 1 }],
      ["element.act", { window: "main", name: "core.tab", action: "input", value: "v" }],
      ["input.pointer", { window: "main", x: 1, y: 2, phase: "move" }],
      ["input.pointer", { window: "main", x: 1, y: 2, phase: "down", button: "right" }],
      ["input.pointer", { window: "main", x: 1, y: 2, phase: "move", activate: true }],
      ["input.pointer", { window: "main", x: 1, y: 2, phase: "down", clicks: 2 }],
      ["input.key", { window: "main", key: "Enter", phase: "down", modifiers: ["shift"] }],
      ["input.text", { window: "main", phase: "mark", text: "한", selection: { start: 0, length: 1 } }],
    ],
  );
});

test("status_watch_once with equals returns the current value", async (t) => {
  const { endpoint, mcp } = await fixture(t, "mcp-watch-current-value");
  const unwatched = requested(endpoint, (m) => m.method === "status.unwatch");
  const reply = await mcp.modern("tools/call", { name: "status_watch_once", arguments: { name: "core.screen", equals: "home" } });
  await unwatched;
  assert.equal(parseText(reply.result), "home");
});

test("status_watch_once without equals returns the next change", async (t) => {
  const { endpoint, mcp } = await fixture(t, "mcp-watch-next-change", ["--window", "main"]);
  const unwatched = requested(endpoint, (m) => m.method === "status.unwatch");
  const reply = await mcp.modern("tools/call", { name: "status_watch_once", arguments: { name: "core.screen" } });
  await unwatched;
  assert.equal(parseText(reply.result), "project");
});

// The wait of status_watch_once has no time limit, as the watch of the client (status.watch in docs/spec/exposure.md): the value
// or the end of the connection ends it.
test("status_watch_once declares no timeout", async (t) => {
  const { mcp } = await fixture(t, "mcp-tools-list");
  const reply = await mcp.modern("tools/list");
  const tool = reply.result.tools.find((entry) => entry.name === "status_watch_once");
  assert.equal(Object.hasOwn(tool.inputSchema.properties, "timeout"), false, "the input schema declares timeout");
  assert.doesNotMatch(tool.description, /timeout|milliseconds/i, "the description states a time limit");
});

test("status_watch_once refuses a timeout argument and watches nothing", async (t) => {
  const { endpoint, mcp } = await fixture(t, "no-request", ["--window", "main"]);
  const reply = await mcp.modern("tools/call", { name: "status_watch_once", arguments: { name: "core.screen", equals: "home", timeout: 50 } });
  assert.equal(reply.error?.code, -32602, `a timeout argument was accepted: ${JSON.stringify(reply)}`);
  assert.match(reply.error.message, /\btimeout\b/);
  assert.equal(endpoint.requests.some((m) => m.method === "status.watch"), false, "a refused call watched the status");
});

test("status_watch_once waits until the end of the connection and reports it as a tool error", async (t) => {
  const { endpoint, mcp } = await fixture(t, "mcp-watch-connection-closed", ["--window", "main"]);
  const got = endpoint.nextRequest("status.get");
  let settled = false;
  const waiting = mcp.modern("tools/call", { name: "status_watch_once", arguments: { name: "core.screen", equals: "never" } })
    .finally(() => { settled = true; });
  await got;
  assert.equal(settled, false, "the wait ended before an event that decides it");
  // The case closes the connection from the host after the status.get reply, so the wait ends by the close.
  const reply = await waiting;
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /connection closed/);
});

test("endpoint errors become tool errors with the code", async (t) => {
  const { mcp } = await fixture(t, "error-window-missing");
  const reply = await mcp.modern("tools/call", { name: "status_get", arguments: { window: "gone", name: "core.screen" } });
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /\(1003\)$/);
});

test("an inactive window error is returned with its message as-is", async (t) => {
  const { mcp } = await fixture(t, "mcp-input-pointer-inactive", ["--window", "main"]);
  const reply = await mcp.modern("tools/call", { name: "input_pointer", arguments: { x: 1, y: 1, phase: "move" } });
  assert.equal(reply.result.isError, true);
  // Both hosts answer a move to a window that is not the key window with this text (errInactive in packages/host/go/src/exposure.go).
  assert.equal(reply.result.content[0].text, "the window is not active (1006)");
});

test("an unknown tool is an invalid params error", async (t) => {
  const { mcp } = await fixture(t, "no-request");
  const reply = await mcp.modern("tools/call", { name: "eval", arguments: {} });
  assert.equal(reply.error.code, -32602);
});

test("protocol version checks", async (t) => {
  const { mcp } = await fixture(t, "no-request");
  const missing = await mcp.request("tools/list", {});
  assert.equal(missing.error.code, -32602);
  const unsupported = await mcp.request("tools/list", { _meta: { ...modernMeta, "io.modelcontextprotocol/protocolVersion": "1900-01-01" } });
  assert.equal(unsupported.error.code, -32022);
  assert.deepEqual(unsupported.error.data, { supported: ["2026-07-28", "2025-11-25"], requested: "1900-01-01" });
  const noCapabilities = await mcp.request("tools/list", { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } });
  assert.equal(noCapabilities.error.code, -32602);
  assert.equal((await mcp.modern("resources/list")).error.code, -32601);
});

test("malformed input returns JSON-RPC errors and the server keeps running", async (t) => {
  const { mcp } = await fixture(t, "no-request");
  mcp.send("{not json");
  mcp.send("[1]");
  const reply = await mcp.modern("server/discover");
  assert.equal(reply.result.resultType, "complete");
  assert.deepEqual(mcp.outputs.slice(0, 2).map((m) => m.error.code), [-32700, -32600]);
});

test("a stopped application is reported and the next call reconnects", async (t) => {
  const { mcp } = await fixture(t, "mcp-reconnect");
  assert.equal(parseText((await mcp.modern("tools/call", { name: "windows_list", arguments: {} })).result)[0].window, "main");
  // The case closes the connection from the host after the first reply, so the server logs the end before the next request.
  await mcp.stderrLine(/connection closed/);
  const again = await mcp.modern("tools/call", { name: "windows_list", arguments: {} });
  assert.equal(parseText(again.result)[0].window, "main");
});

test("a missing endpoint.json is reported as a tools/list error", async (t) => {
  const mcp = startMcp(t, ["--config-dir", "/nonexistent/soksak"]);
  const reply = await mcp.modern("tools/list");
  assert.equal(reply.error.code, -32603);
  assert.match(reply.error.message, /endpoint\.json/);
});

test("the server exits when stdin closes", async (t) => {
  const { mcp } = await fixture(t, "no-request");
  await mcp.modern("server/discover");
  mcp.child.stdin.end();
  assert.equal(await mcp.exited, 0);
});

test("tools/list reports an exposure.list without a list or a command params schema instead of filling them in", async (t) => {
  for (const [label, name, message] of [
    ["no element list", "mcp-exposure-without-element", /exposure.list has no element list/],
    ["no params schema", "mcp-exposure-without-params", /declares no params schema/],
  ]) {
    const endpoint = await play(t, name);
    const mcp = startMcp(t, ["--config-dir", endpoint.configDir, "--window", "main"]);
    const reply = await mcp.modern("tools/list");
    assert.match(JSON.stringify(reply), message, `${label}: ${JSON.stringify(reply)}`);
  }
});
