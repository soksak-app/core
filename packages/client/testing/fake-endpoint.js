// 테스트용 엔드포인트 서버: 호스트와 같은 프레임과 JSON-RPC 형식으로 응답하고 endpoint.json 을 쓴다.
import { EventEmitter, once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeFrame, FrameReader } from "../frame.js";
import { createAddress, transport } from "../platform/platform.js";

/**
 * handlers[method](params, connection) 는 결과 또는 그 promise 를 반환한다.
 * 오류 응답은 { code, message } 를 가진 객체를 throw 한다.
 * 선언되지 않은 method 는 호스트와 같이 응답 없이 연결을 닫는다.
 */
export async function startFakeEndpoint(handlers, { pid = process.pid } = {}) {
  const { address, remove } = createAddress("soksak-test");
  const configDir = mkdtempSync(join(tmpdir(), "soksak-config-"));
  const connections = new Set();
  const requests = [];
  // "connection" 은 새 연결마다, "request" 는 선언된 요청마다 발생한다.
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
  const endpoint = { transport, address, pid, application: "wailsv3", version: "0.0.1", started: new Date().toISOString() };
  writeFileSync(join(configDir, "endpoint.json"), JSON.stringify(endpoint));
  return {
    configDir,
    requests,
    connections,
    events,
    /** 다음 method 요청을 받으면 그 메시지로 이행한다. 요청을 보내기 전에 호출한다. */
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
    /** 다음 연결을 받으면 이행한다. */
    nextConnection() {
      return once(events, "connection");
    },
    // 모든 연결에 알림을 보낸다.
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

/** 응답을 보내지 않도록 handler 가 반환하는 값. */
export const NO_REPLY = Symbol("no reply");

/** 오류 응답용 객체를 만든다. */
export function rpcError(code, message) {
  return Object.assign(new Error(message), { code });
}

/** 창 하나와 선언 몇 개를 가진 기본 응답기. status 값은 values 에 두고 set 으로 바꾼다. */
export function sampleHandlers() {
  const values = new Map([["core.screen", "home"]]);
  // 창 main 이 key 창인지. 아니면 activate 없는 move 가 1006 으로 실패한다.
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
    "windows.list": () => [{ window: "main", title: "soksak", project: null, key: true }],
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
    // 값을 바꾸고 감시 중인 연결에 status.changed 를 보낸다.
    set(name, value) {
      values.set(name, value);
      for (const connection of watchers.get(name) ?? []) connection.notify("status.changed", { window: "main", name, value });
    },
  };
}
