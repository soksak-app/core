// Endpoint server for tests: answers in the frame and JSON-RPC form of the host and writes endpoint.json.
import { EventEmitter, once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeFrame, FrameReader } from "../frame.js";
import { createAddress, transport } from "../platform/platform.js";

/**
 * handlers[method](params, connection) returns a result or a promise of it.
 * An error response throws an object that has { code, message }.
 * A method that is not declared closes the connection without a response, like the host.
 */
export async function startFakeEndpoint(handlers, { pid = process.pid } = {}) {
  const { address, remove } = createAddress("soksak-test");
  const configDir = mkdtempSync(join(tmpdir(), "soksak-config-"));
  const connections = new Set();
  const requests = [];
  // "connection" is emitted for each new connection, "request" for each declared request.
  const events = new EventEmitter();
  const server = createServer((socket) => {
    const connection = {
      socket,
      notify(method, params) {
        if (!socket.destroyed) socket.write(encodeFrame({ jsonrpc: "2.0", method, params }));
      },
      reply(message) {
        if (!socket.destroyed) socket.write(encodeFrame({ jsonrpc: "2.0", ...message }));
      },
    };
    connections.add(connection);
    socket.on("close", () => connections.delete(connection));
    events.emit("connection", connection);
    socket.on("error", () => {});
    const reader = new FrameReader();
    socket.on("data", (chunk) => {
      let messages;
      try {
        messages = [...reader.push(chunk)];
      } catch {
        socket.destroy();
        return;
      }
      for (const message of messages) {
        const handler = handlers[message.method];
        if (!handler) {
          socket.destroy();
          return;
        }
        requests.push(message);
        events.emit("request", message);
        Promise.resolve()
          .then(() => handler(message.params, connection, message))
          .then(
            (result) => {
              if (result !== NO_REPLY) connection.reply({ id: message.id, result: result ?? null });
            },
            (error) => connection.reply({ id: message.id, error: { code: error.code, message: error.message } }),
          );
      }
    });
  });
  await new Promise((resolve) => server.listen(address, resolve));
  const endpoint = { transport, address, pid, application: "wailsv3", version: "0.0.2", started: new Date().toISOString() };
  writeFileSync(join(configDir, "endpoint.json"), JSON.stringify(endpoint));
  return {
    configDir,
    requests,
    connections,
    events,
    /** Resolves with the message when the next request of the method arrives. Call it before sending the request. */
    nextRequest(method) {
      return new Promise((resolve) => {
        const listener = (message) => {
          if (message.method !== method) return;
          events.off("request", listener);
          resolve(message);
        };
        events.on("request", listener);
      });
    },
    /** Resolves when the next connection is accepted. */
    nextConnection() {
      return once(events, "connection");
    },
    // Sends a notification to every connection.
    notify(method, params) {
      for (const connection of connections) connection.notify(method, params);
    },
    async close() {
      for (const connection of connections) connection.socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      remove();
      rmSync(configDir, { recursive: true, force: true });
    },
  };
}

/** The value that a handler returns so that no response is sent. */
export const NO_REPLY = Symbol("no reply");

/** Creates the object for an error response. */
export function rpcError(code, message) {
  return Object.assign(new Error(message), { code });
}

/** The default responder with one window and a few declarations. The status values are kept in values and changed with set. */
export function sampleHandlers() {
  const values = new Map([["core.screen", "home"]]);
  // Whether the window main is the key window. If not, move without activate fails with 1006.
  const state = { key: true };
  const watchers = new Map();
  const entries = {
    status: [
      { name: "core.screen", description: "Current screen.", schema: { type: "string" }, registered: true },
      { name: "host.window", description: "Window state.", schema: { type: "object" }, registered: true },
    ],
    commands: [
      {
        name: "core.project.open",
        description: "Opens a project.",
        params: { type: "object", properties: { root: { type: "string" } } },
        result: { type: "null" },
        registered: true,
      },
      { name: "host.window.reload", description: "Reloads the main page.", params: { type: "object" }, result: { type: "null" }, registered: true },
    ],
    dom: [{ name: "core.tab", description: "A tab.", many: true, registered: true }],
  };
  const window = (params) => {
    if (params?.window !== "main") throw rpcError(1003, `window ${params?.window} does not exist`);
  };
  const handlers = {
    "windows.list": () => [{ window: "main", title: "soksak", project: null, key: true, ready: true }],
    "exposure.list": (params) => (window(params), entries),
    "status.get": (params) => {
      window(params);
      if (!values.has(params.name)) throw rpcError(1001, `unknown name ${params.name}`);
      return values.get(params.name);
    },
    "status.watch": (params, connection) => {
      window(params);
      if (!values.has(params.name)) throw rpcError(1001, `unknown name ${params.name}`);
      const set = watchers.get(params.name) ?? new Set();
      set.add(connection);
      watchers.set(params.name, set);
      connection.socket.on("close", () => set.delete(connection));
      return null;
    },
    "status.unwatch": (params, connection) => {
      watchers.get(params.name)?.delete(connection);
      return null;
    },
    "diagnostics.capture.still": (params) => (window(params), { path: "/config/captures/still-main-1.png" }),
    "command.run": (params) => {
      window(params);
      if (params.name === "core.project.open") return { opened: params.params?.root ?? null };
      if (params.name === "host.window.reload") return null;
      throw rpcError(1001, `unknown name ${params.name}`);
    },
    "dom.rect": (params) => (window(params), { x: 10, y: 20, width: 30, height: 40, index: params.index ?? 0, document: { x: 0, y: 0 } }),
    "dom.act": (params) => (window(params), null),
    "input.pointer": (params) => {
      window(params);
      if (params.phase === "move" && !state.key && params.activate !== true) {
        throw rpcError(1006, "window main is not the key window; pass activate to make it key");
      }
      if (params.activate === true) state.key = true;
      return null;
    },
    "input.key": (params) => (window(params), null),
  };
  return {
    handlers,
    values,
    watchers,
    state,
    // Changes a value and sends status.changed to the connections that watch it.
    set(name, value) {
      values.set(name, value);
      for (const connection of watchers.get(name) ?? []) connection.notify("status.changed", { window: "main", name, value });
    },
  };
}
