import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
// pnpm install 전에도 실행되도록 가짜 엔드포인트는 상대 경로로 가져온다.
import { sampleHandlers, startFakeEndpoint } from "@soksak/client/testing";

const server = fileURLToPath(new URL("../mcp.js", import.meta.url));
const modernMeta = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "test", version: "0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

// MCP 서버를 실행하고 요청 함수를 반환한다.
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
    // stderr 에 pattern 과 일치하는 내용이 나오면 이행한다.
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
    // 모던 방식 요청.
    modern(method, params = {}) {
      return this.request(method, { ...params, _meta: modernMeta });
    },
  };
}

async function fixture(t, args = []) {
  const sample = sampleHandlers();
  const endpoint = await startFakeEndpoint(sample.handlers);
  t.after(() => endpoint.close());
  const mcp = startMcp(t, ["--config-dir", endpoint.configDir, ...args]);
  return { sample, endpoint, mcp };
}

function parseText(result) {
  assert.equal(result.content[0].type, "text");
  return JSON.parse(result.content[0].text);
}

test("legacy initialize handshake then tools/list", async (t) => {
  const { mcp } = await fixture(t);
  const init = await mcp.request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  });
  assert.equal(init.result.protocolVersion, "2025-11-25");
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
  assert.equal(init.result.serverInfo.name, "soksak-mcp");
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
    "dom_rect",
    "dom_act",
    "input_pointer",
    "input_key",
  ]);
  for (const name of names) assert.match(name, /^[A-Za-z0-9_.-]{1,128}$/);
  // 알림에는 응답하지 않는다.
  assert.equal(mcp.outputs.length, 2);
});

test("server/discover lists the supported versions", async (t) => {
  const { mcp } = await fixture(t);
  const reply = await mcp.modern("server/discover");
  assert.equal(reply.result.resultType, "complete");
  assert.deepEqual(reply.result.supportedVersions, ["2026-07-28", "2025-11-25"]);
  assert.deepEqual(reply.result.capabilities, { tools: {} });
  assert.equal(reply.result._meta["io.modelcontextprotocol/serverInfo"].name, "soksak-mcp");
});

test("modern tools/list generates schemas from exposure.list of the key window", async (t) => {
  const { endpoint, mcp } = await fixture(t);
  const reply = await mcp.modern("tools/list");
  assert.equal(reply.result.resultType, "complete");
  const tools = Object.fromEntries(reply.result.tools.map((tool) => [tool.name, tool]));
  assert.deepEqual(tools.status_get.inputSchema.properties.name.enum, ["core.screen", "host.window"]);
  assert.deepEqual(tools.dom_rect.inputSchema.properties.name.enum, ["core.tab"]);
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
  const { endpoint, mcp } = await fixture(t, ["--window", "main"]);
  await mcp.modern("tools/list");
  assert.deepEqual(endpoint.requests.map((m) => m.method), ["exposure.list"]);
});

test("tools/call maps tools to endpoint methods", async (t) => {
  const { endpoint, mcp } = await fixture(t, ["--window", "main"]);
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
  assert.equal((await call("dom_rect", { name: "core.tab", index: 1 })).index, 1);
  assert.equal(await call("dom_act", { name: "core.tab", action: "input", value: "v" }), null);
  assert.equal(await call("input_pointer", { x: 1, y: 2, phase: "move" }), null);
  assert.equal(await call("input_pointer", { x: 1, y: 2, phase: "down", button: "right" }), null);
  assert.equal(await call("input_pointer", { x: 1, y: 2, phase: "move", activate: true }), null);
  assert.equal(await call("input_key", { key: "Enter", phase: "down", modifiers: ["shift"] }), null);
  assert.deepEqual(
    endpoint.requests.map((m) => [m.method, m.params]),
    [
      ["windows.list", undefined],
      ["status.get", { window: "main", name: "core.screen" }],
      ["status.get", { window: "main", name: "core.screen", surface: "tab-a" }],
      ["command.run", { window: "main", name: "core.project.open", params: { root: "/p" } }],
      ["dom.rect", { window: "main", name: "core.tab", index: 1 }],
      ["dom.act", { window: "main", name: "core.tab", action: "input", value: "v" }],
      ["input.pointer", { window: "main", x: 1, y: 2, phase: "move" }],
      ["input.pointer", { window: "main", x: 1, y: 2, phase: "down", button: "right" }],
      ["input.pointer", { window: "main", x: 1, y: 2, phase: "move", activate: true }],
      ["input.key", { window: "main", key: "Enter", phase: "down", modifiers: ["shift"] }],
    ],
  );
});

test("status_watch_once with equals returns the current value", async (t) => {
  const { mcp } = await fixture(t);
  const reply = await mcp.modern("tools/call", { name: "status_watch_once", arguments: { name: "core.screen", equals: "home" } });
  assert.equal(parseText(reply.result), "home");
});

test("status_watch_once without equals returns the next change", async (t) => {
  const { sample, endpoint, mcp } = await fixture(t, ["--window", "main"]);
  const got = endpoint.nextRequest("status.get");
  const waiting = mcp.modern("tools/call", { name: "status_watch_once", arguments: { name: "core.screen" } });
  await got;
  sample.set("core.screen", "project");
  const reply = await waiting;
  assert.equal(parseText(reply.result), "project");
});

test("status_watch_once reports a timeout as a tool error", async (t) => {
  const { mcp } = await fixture(t);
  const reply = await mcp.modern("tools/call", { name: "status_watch_once", arguments: { name: "core.screen", equals: "never", timeout: 50 } });
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /within 50 ms/);
});

test("endpoint errors become tool errors with the code", async (t) => {
  const { mcp } = await fixture(t);
  const reply = await mcp.modern("tools/call", { name: "status_get", arguments: { window: "gone", name: "core.screen" } });
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /\(1003\)$/);
});

test("an inactive window error is returned with its message as-is", async (t) => {
  const { sample, mcp } = await fixture(t, ["--window", "main"]);
  sample.state.key = false;
  const reply = await mcp.modern("tools/call", { name: "input_pointer", arguments: { x: 1, y: 1, phase: "move" } });
  assert.equal(reply.result.isError, true);
  assert.equal(reply.result.content[0].text, "window main is not the key window; pass activate to make it key (1006)");
});

test("an unknown tool is an invalid params error", async (t) => {
  const { mcp } = await fixture(t);
  const reply = await mcp.modern("tools/call", { name: "eval", arguments: {} });
  assert.equal(reply.error.code, -32602);
});

test("protocol version checks", async (t) => {
  const { mcp } = await fixture(t);
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
  const { mcp } = await fixture(t);
  mcp.send("{not json");
  mcp.send("[1]");
  const reply = await mcp.modern("server/discover");
  assert.equal(reply.result.resultType, "complete");
  assert.deepEqual(mcp.outputs.slice(0, 2).map((m) => m.error.code), [-32700, -32600]);
});

test("a stopped application is reported and the next call reconnects", async (t) => {
  const { endpoint, mcp } = await fixture(t);
  assert.equal(parseText((await mcp.modern("tools/call", { name: "windows_list", arguments: {} })).result)[0].window, "main");
  const logged = mcp.stderrLine(/connection closed/);
  for (const connection of endpoint.connections) connection.socket.destroy();
  // MCP 서버가 연결 종료를 받은 뒤에 다음 요청을 보낸다.
  await logged;
  const reconnected = endpoint.nextConnection();
  const again = await mcp.modern("tools/call", { name: "windows_list", arguments: {} });
  await reconnected;
  assert.equal(parseText(again.result)[0].window, "main");
});

test("a missing endpoint.json is reported as a tools/list error", async (t) => {
  const mcp = startMcp(t, ["--config-dir", "/nonexistent/soksak"]);
  const reply = await mcp.modern("tools/list");
  assert.equal(reply.error.code, -32603);
  assert.match(reply.error.message, /endpoint\.json/);
});

test("the server exits when stdin closes", async (t) => {
  const { mcp } = await fixture(t);
  await mcp.modern("server/discover");
  mcp.child.stdin.end();
  assert.equal(await mcp.exited, 0);
});

test("tools/list reports an exposure.list without a list or a command params schema instead of filling them in", async (t) => {
  for (const [label, change, message] of [
    ["no dom list", (entries) => { delete entries.dom; }, /exposure.list has no dom list/],
    ["no params schema", (entries) => { delete entries.commands[0].params; }, /declares no params schema/],
  ]) {
    const sample = sampleHandlers();
    const list = sample.handlers["exposure.list"];
    sample.handlers["exposure.list"] = (params) => {
      const entries = structuredClone(list(params));
      change(entries);
      return entries;
    };
    const endpoint = await startFakeEndpoint(sample.handlers);
    t.after(() => endpoint.close());
    const mcp = startMcp(t, ["--config-dir", endpoint.configDir, "--window", "main"]);
    const reply = await mcp.modern("tools/list");
    assert.match(JSON.stringify(reply), message, `${label}: ${JSON.stringify(reply)}`);
  }
});
