#!/usr/bin/env node
// soksak-mcp: a stdio server that provides the exposure of the local endpoint as MCP tools.
// It opens no network port. It writes only MCP messages to stdout and diagnostics to stderr.
import { createInterface } from "node:readline";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { connect } from "@soksak/client";

// The MCP revisions that this server implements. 2026-07-28 uses the per-request _meta form, 2025-11-25 the initialize form.
const MODERN_VERSION = "2026-07-28";
const LEGACY_VERSION = "2025-11-25";
const SUPPORTED_VERSIONS = [MODERN_VERSION, LEGACY_VERSION];
const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
const META_SERVER = "io.modelcontextprotocol/serverInfo";
const SERVER_INFO = { name: "soksak-mcp", version: "0.0.1" };
const INSTRUCTIONS =
  "Tools read status values, run declared commands, and act on declared DOM elements of a running soksak application. " +
  "The window argument defaults to the selected window.";
const COMMAND_PREFIX = "command_run_";

class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

const { values } = parseArgs({
  options: {
    "config-dir": { type: "string" },
    window: { type: "string" },
  },
  strict: true,
});
const configDir = values["config-dir"];
if (configDir === undefined) {
  process.stderr.write("soksak-mcp: --config-dir is required\n");
  process.exit(2);
}

// The endpoint connection is created at the first tool request and created again at the next request after it breaks.
let connection = null;
function client() {
  if (!connection) {
    connection = connect({ configDir }).then(
      (c) => {
        // Records the connection end to stderr. The next request creates a new connection.
        c.ended.then((error) => process.stderr.write(`soksak-mcp: ${error.message}\n`));
        return c;
      },
      (error) => {
        connection = null;
        throw error;
      },
    );
  }
  return connection.then((c) => {
    if (!c.closed) return c;
    connection = null;
    return client();
  });
}

// The window is chosen by the window argument, the --window start option, then the key window order of windows.list.
async function selectWindow(c, requested) {
  if (requested !== undefined) return requested;
  if (values.window !== undefined) return values.window;
  const windows = await c.request("windows.list");
  // default: without a key window (the application is inactive), the first window of windows.list (the selection order is above).
  const selected = windows.find((w) => w.key) ?? windows[0];
  if (!selected) throw new Error("the application has no window");
  return selected.window;
}

const windowProperty = { type: "string", description: "Window identifier from windows_list. Defaults to the selected window." };
const surfaceProperty = {
  type: "string",
  description: "Surface identifier from status core.surfaces, for names that surface pages register. Defaults to the page's choice.",
};

function nameProperty(entries, description) {
  const names = entries.map((entry) => entry.name);
  return names.length > 0 ? { type: "string", enum: names, description } : { type: "string", description };
}

function describe(entries) {
  return entries.map((entry) => `${entry.name}${entry.registered ? "" : " (not registered)"}: ${entry.description}`).join("\n");
}

// A command declaration always holds the params schema (docs/spec/exposure.md).
function paramsOf(command) {
  if (!command.params) throw new Error(`command ${command.name} declares no params schema`);
  return command.params;
}

// Builds the tool list from the result of exposure.list.
function buildTools(window, exposure) {
  // exposure.list always holds all three lists (docs/spec/endpoint.md). A missing list is a response error.
  for (const key of ["status", "commands", "dom"]) {
    if (!Array.isArray(exposure[key])) throw new Error(`exposure.list has no ${key} list`);
  }
  const { status, commands, dom } = exposure;
  const object = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
  const tools = [
    {
      name: "windows_list",
      description: "Lists the application windows as {window, title, project, key}.",
      inputSchema: object({}),
      annotations: { readOnlyHint: true },
    },
    {
      name: "status_get",
      description: `Returns the current value of a status in window ${window}.\n${describe(status)}`,
      inputSchema: object({ window: windowProperty, name: nameProperty(status, "Status name."), surface: surfaceProperty }, ["name"]),
      annotations: { readOnlyHint: true },
    },
    {
      name: "status_watch_once",
      description:
        "Waits for a status value. With equals, returns when the value equals it, including the current value. " +
        "Without equals, returns the next changed value. Fails after timeout milliseconds (default 10000).",
      inputSchema: object(
        {
          window: windowProperty,
          name: nameProperty(status, "Status name."),
          surface: surfaceProperty,
          equals: { description: "Value to wait for." },
          timeout: { type: "number", description: "Timeout in milliseconds." },
        },
        ["name"],
      ),
      annotations: { readOnlyHint: true },
    },
  ];
  for (const command of commands) {
    tools.push({
      name: COMMAND_PREFIX + command.name.replaceAll(".", "_"),
      description: `Runs command ${command.name}${command.registered ? "" : " (not registered)"}: ${command.description}`,
      inputSchema: object({ window: windowProperty, surface: surfaceProperty, params: paramsOf(command) }),
    });
  }
  tools.push(
    {
      name: "dom_rect",
      description: `Returns the rectangle of a declared DOM element in CSS pixels and its document origin in window coordinates.\n${describe(dom)}`,
      inputSchema: object(
        { window: windowProperty, name: nameProperty(dom, "DOM entry name."), surface: surfaceProperty, index: { type: "integer", description: "Element index for entries with many elements." } },
        ["name"],
      ),
      annotations: { readOnlyHint: true },
    },
    {
      name: "dom_act",
      description: "Sends synthetic DOM events (isTrusted false) to a declared DOM element. Use input_pointer and input_key to test real input.",
      inputSchema: object(
        {
          window: windowProperty,
          name: nameProperty(dom, "DOM entry name."),
          surface: surfaceProperty,
          index: { type: "integer" },
          action: { type: "string", enum: ["click", "input", "dispatch"] },
          value: { type: "string", description: "Value for the input action." },
          event: { type: "object", description: "Event for the dispatch action." },
        },
        ["name", "action"],
      ),
    },
    {
      name: "input_pointer",
      description:
        "Sends a native pointer event at window coordinates. A move to a window that is not the key window fails with 1006; " +
        "activate: true on a move activates the application and makes the window key, which takes the keyboard focus from the user's application.",
      inputSchema: object(
        {
          window: windowProperty,
          x: { type: "number" },
          y: { type: "number" },
          phase: { type: "string", enum: ["move", "down", "drag", "up", "scroll"] },
          button: { type: "string", enum: ["left", "right"], description: "Defaults to left." },
          deltaX: { type: "number", description: "Scroll distance in points." },
          deltaY: { type: "number", description: "Scroll distance in points." },
          activate: { type: "boolean", description: "Only for move: activate the application and make the window key first." },
        },
        ["x", "y", "phase"],
      ),
    },
    {
      name: "input_key",
      description: "Sends a native key event.",
      inputSchema: object(
        {
          window: windowProperty,
          key: { type: "string", description: "Enter, Tab, Escape, Backspace, Delete, Space, Arrow*, Home, End, PageUp, PageDown, or one character." },
          text: { type: "string" },
          modifiers: { type: "array", items: { type: "string", enum: ["shift", "control", "option", "command"] } },
          phase: { type: "string", enum: ["down", "up"] },
        },
        ["key", "phase"],
      ),
    },
  );
  return tools;
}

async function listTools() {
  const c = await client();
  const window = await selectWindow(c);
  return { tools: buildTools(window, await c.request("exposure.list", { window })) };
}

// Moves the arguments except window to the endpoint params.
function withWindow(window, args, keys) {
  const params = { window };
  for (const key of keys) if (args[key] !== undefined) params[key] = args[key];
  return params;
}

async function callTool(params) {
  const name = params?.name;
  // default: arguments of MCP tools/call is an optional field; without it the call has no arguments.
  const args = params?.arguments ?? {};
  if (typeof name !== "string") throw new RpcError(-32602, "tools/call requires name");
  if (typeof args !== "object" || Array.isArray(args)) throw new RpcError(-32602, "arguments must be an object");
  const known = ["windows_list", "status_get", "status_watch_once", "dom_rect", "dom_act", "input_pointer", "input_key"];
  if (!known.includes(name) && !(name.startsWith(COMMAND_PREFIX) && /^[a-z0-9_-]+$/.test(name.slice(COMMAND_PREFIX.length)))) {
    throw new RpcError(-32602, `unknown tool: ${name}`);
  }
  let value;
  try {
    const c = await client();
    if (name === "windows_list") {
      value = await c.request("windows.list");
    } else {
      const window = await selectWindow(c, args.window);
      switch (name) {
        case "status_get":
          value = await c.request("status.get", withWindow(window, args, ["name", "surface"]));
          break;
        case "status_watch_once":
          value = await watchOnce(c, window, args);
          break;
        case "dom_rect":
          value = await c.request("dom.rect", withWindow(window, args, ["name", "surface", "index"]));
          break;
        case "dom_act":
          value = await c.request("dom.act", withWindow(window, args, ["name", "surface", "index", "action", "value", "event"]));
          break;
        case "input_pointer":
          value = await c.request("input.pointer", withWindow(window, args, ["x", "y", "phase", "button", "deltaX", "deltaY", "activate"]));
          break;
        case "input_key":
          value = await c.request("input.key", withWindow(window, args, ["key", "text", "modifiers", "phase"]));
          break;
        default:
          value = await c.request("command.run", {
            ...withWindow(window, args, ["surface"]),
            name: name.slice(COMMAND_PREFIX.length).replaceAll("_", "."),
            // default: params of a command tool is an optional argument; without it the command runs with empty parameters.
            params: args.params ?? {},
          });
      }
    }
  } catch (error) {
    const code = error.code !== undefined ? ` (${error.code})` : "";
    return { content: [{ type: "text", text: `${error.message}${code}` }], isError: true };
  }
  // default: a request without a result gives undefined, and JSON has no undefined, so it is written as null.
  return { content: [{ type: "text", text: JSON.stringify(value ?? null) }] };
}

async function watchOnce(c, window, args) {
  if (typeof args.name !== "string") throw new Error("name is required");
  // default: the default wait time of 10000 ms that the watch tool description states.
  const timeout = args.timeout ?? 10000;
  const surface = args.surface;
  if ("equals" in args) {
    return c.watch(window, args.name, (value) => isDeepStrictEqual(value, args.equals), { timeout, surface });
  }
  // Skips the current value and returns the value of the next change notification.
  let changed;
  const off = c.on("status.changed", (params) => {
    if (changed === undefined && params?.window === window && params?.name === args.name && params?.surface === surface) {
      changed = { value: params.value };
    }
  });
  try {
    // This listener was registered before the listener of watch, so changed already exists when the predicate is called with a notification value.
    // When it is called with the current value of status.get, it is not satisfied unless a notification arrived.
    await c.watch(window, args.name, () => changed !== undefined, { timeout, surface });
    return changed.value;
  } finally {
    off();
  }
}

// Determines the revision of the request. The return value is the _meta form to attach to the result.
let legacySession = false;
function era(params) {
  const meta = params?._meta;
  const version = meta?.[META_VERSION];
  if (version === undefined) {
    if (legacySession) return "legacy";
    throw new RpcError(-32602, `missing _meta ${META_VERSION}; supported versions: ${SUPPORTED_VERSIONS.join(", ")}`);
  }
  if (version !== MODERN_VERSION) {
    throw new RpcError(-32022, "Unsupported protocol version", { supported: SUPPORTED_VERSIONS, requested: version });
  }
  if (meta[META_CAPABILITIES] === undefined) throw new RpcError(-32602, `missing _meta ${META_CAPABILITIES}`);
  return "modern";
}

function complete(result) {
  // default: _meta is an optional field of an MCP result. Without it the result holds only the server information.
  return { resultType: "complete", ...result, _meta: { ...(result._meta ?? {}), [META_SERVER]: SERVER_INFO } };
}

async function handle(method, params) {
  switch (method) {
    case "initialize":
      legacySession = true;
      return {
        protocolVersion: LEGACY_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      };
    case "server/discover":
      if (params?._meta?.[META_VERSION] !== undefined) era(params);
      return complete({
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        instructions: INSTRUCTIONS,
      });
    case "ping":
      return era(params) === "modern" ? complete({}) : {};
    case "tools/list": {
      const mode = era(params);
      const result = await listTools();
      return mode === "modern" ? complete(result) : result;
    }
    case "tools/call": {
      const mode = era(params);
      const result = await callTool(params);
      return mode === "modern" ? complete(result) : result;
    }
    default:
      throw new RpcError(-32601, `method not found: ${method}`);
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  if (line.trim() === "") return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    send({ id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0") {
    // default: JSON-RPC 2.0 sets the id of an error response to null when the request id cannot be known.
    send({ id: message?.id ?? null, error: { code: -32600, message: "Invalid Request" } });
    return;
  }
  // Responses and notifications are not handled. This server sends no request to the client.
  if (typeof message.method !== "string" || message.id === undefined || message.id === null) return;
  handle(message.method, message.params).then(
    (result) => send({ id: message.id, result }),
    (error) => {
      const rpc = error instanceof RpcError ? error : new RpcError(-32603, error.message);
      const payload = { code: rpc.code, message: rpc.message };
      if (rpc.data !== undefined) payload.data = rpc.data;
      send({ id: message.id, error: payload });
    },
  );
});
lines.on("close", async () => {
  if (connection) {
    try {
      (await connection).close();
    } catch {
      // silent: when the connection could not be created, there is nothing to close.
    }
  }
  process.exit(0);
});
