// 로컬 엔드포인트 클라이언트: endpoint.json 을 읽고 연결해 JSON-RPC 요청과 알림을 처리한다.
import { readFile } from "node:fs/promises";
import { connect as connectSocket } from "node:net";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { encodeFrame, FrameReader } from "./frame.js";
import { transport as platformTransport } from "./platform/platform.js";

/** 엔드포인트 오류 응답을 code 를 가진 Error 로 만든다. */
export class EndpointError extends Error {
  constructor({ code, message, data }) {
    super(message);
    this.name = "EndpointError";
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

// pid 의 프로세스가 있는지 확인한다. EPERM 은 다른 사용자의 프로세스가 있다는 뜻이다.
function running(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/** <configDir>/endpoint.json 을 읽고 검사한다. */
export async function readEndpoint(configDir) {
  const file = join(configDir, "endpoint.json");
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`${file} does not exist; the application is not running`);
    throw error;
  }
  let endpoint;
  try {
    endpoint = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${error.message}`);
  }
  if (!endpoint || typeof endpoint.address !== "string" || !Number.isInteger(endpoint.pid)) {
    throw new Error(`${file} has no address or pid`);
  }
  if (endpoint.transport !== platformTransport) {
    throw new Error(`${file} has transport ${endpoint.transport}; this platform uses ${platformTransport}`);
  }
  if (!running(endpoint.pid)) {
    throw new Error(`${file} names process ${endpoint.pid}, which is not running`);
  }
  return endpoint;
}

/** 설정 디렉터리의 엔드포인트에 연결하고 클라이언트를 반환한다. */
export async function connect({ configDir }) {
  if (!configDir) throw new Error("configDir is required");
  const endpoint = await readEndpoint(configDir);
  const socket = await new Promise((resolve, reject) => {
    // net.connect 의 path 는 Unix 소켓 경로와 named pipe 이름을 모두 받는다.
    const s = connectSocket({ path: endpoint.address });
    s.once("connect", () => {
      s.off("error", reject);
      resolve(s);
    });
    s.once("error", (error) => reject(new Error(`cannot connect to ${endpoint.address}: ${error.message}`)));
  });
  return new Client(socket, endpoint);
}

class Client {
  #socket;
  #nextId = 1;
  #pending = new Map();
  #listeners = new Map();
  // window 와 name 별 status.watch 사용 수. 호스트는 연결당 하나의 감시만 기록하므로 마지막 사용이 끝날 때 unwatch 한다.
  #watches = new Map();
  #closed = null;
  #ended;
  #end;

  constructor(socket, endpoint) {
    this.endpoint = endpoint;
    this.#ended = new Promise((resolve) => (this.#end = resolve));
    this.#socket = socket;
    const reader = new FrameReader();
    socket.on("data", (chunk) => {
      try {
        for (const message of reader.push(chunk)) this.#receive(message);
      } catch (error) {
        this.#fail(new Error(`invalid frame from endpoint: ${error.message}`));
      }
    });
    socket.on("error", (error) => this.#fail(new Error(`endpoint connection failed: ${error.message}`)));
    socket.on("close", () => this.#fail(new Error("endpoint connection closed")));
  }

  /** 요청을 보내고 결과를 반환한다. 오류 응답은 EndpointError 로 거부된다. */
  request(method, params) {
    if (this.#closed) return Promise.reject(this.#closed);
    const id = this.#nextId++;
    const message = { jsonrpc: "2.0", id, method };
    if (params !== undefined) message.params = params;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#socket.write(encodeFrame(message));
    });
  }

  /** 알림 수신 함수를 등록하고 해제 함수를 반환한다. */
  on(method, fn) {
    let set = this.#listeners.get(method);
    if (!set) this.#listeners.set(method, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }

  /**
   * status.watch 로 값을 감시하고 predicate 를 만족하는 첫 값으로 이행한다.
   * 현재 값도 검사한다. timeout(ms) 안에 만족하지 않으면 code "ETIMEDOUT" 로 거부한다.
   */
  watch(window, name, predicate, { timeout = 10000 } = {}) {
    const key = JSON.stringify([window, name]);
    return new Promise((resolve, reject) => {
      let done = false;
      let timer;
      const finish = (error, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        off();
        offClose();
        this.#release(key, window, name);
        if (error) reject(error);
        else resolve(value);
      };
      const check = (value) => {
        let ok;
        try {
          ok = predicate(value);
        } catch (error) {
          finish(error);
          return;
        }
        if (ok) finish(null, value);
      };
      // status.watch 응답 전에 도착하는 알림도 받도록 먼저 등록한다.
      const off = this.on("status.changed", (params) => {
        if (params?.window === window && params?.name === name) check(params.value);
      });
      const offClose = this.#onClose((error) => finish(error));
      if (timeout !== Infinity) {
        timer = setTimeout(() => {
          const error = new Error(`status ${name} did not satisfy the condition within ${timeout} ms`);
          error.code = "ETIMEDOUT";
          finish(error);
        }, timeout);
      }
      this.#acquire(key, window, name)
        .then(() => (done ? undefined : this.request("status.get", { window, name })))
        .then((value) => {
          if (!done) check(value);
        })
        .catch((error) => finish(error));
    });
  }

  /** 연결을 닫는다. 대기 중인 요청은 거부된다. */
  close() {
    this.#fail(new Error("endpoint connection closed"));
  }

  get closed() {
    return this.#closed !== null;
  }

  /** 연결이 끝나면 종료 원인 Error 로 이행하는 promise. */
  get ended() {
    return this.#ended;
  }

  #closeListeners = new Set();

  #onClose(fn) {
    if (this.#closed) {
      queueMicrotask(() => fn(this.#closed));
      return () => {};
    }
    this.#closeListeners.add(fn);
    return () => this.#closeListeners.delete(fn);
  }

  #acquire(key, window, name) {
    const entry = this.#watches.get(key);
    if (entry) {
      entry.count += 1;
      return entry.ready;
    }
    const created = { count: 1, ready: this.request("status.watch", { window, name }) };
    this.#watches.set(key, created);
    created.ready.catch(() => {
      if (this.#watches.get(key) === created) this.#watches.delete(key);
    });
    return created.ready;
  }

  #release(key, window, name) {
    const entry = this.#watches.get(key);
    if (!entry) return;
    entry.count -= 1;
    if (entry.count > 0) return;
    this.#watches.delete(key);
    if (this.#closed) return;
    entry.ready.then(
      () => this.request("status.unwatch", { window, name }).catch(() => {}),
      () => {},
    );
  }

  #receive(message) {
    if (message?.id !== undefined && message.id !== null && !("method" in message)) {
      const entry = this.#pending.get(message.id);
      if (!entry) return;
      this.#pending.delete(message.id);
      if (message.error) entry.reject(new EndpointError(message.error));
      else entry.resolve(message.result);
      return;
    }
    if (typeof message?.method === "string") {
      for (const fn of [...(this.#listeners.get(message.method) ?? [])]) fn(message.params);
    }
  }

  #fail(error) {
    if (this.#closed) return;
    this.#closed = error;
    this.#socket.destroy();
    for (const { reject } of this.#pending.values()) reject(error);
    this.#pending.clear();
    for (const fn of [...this.#closeListeners]) fn(error);
    this.#closeListeners.clear();
    this.#end(error);
  }
}

/** 두 JSON 값이 같은지 비교한다. watch 의 predicate 작성에 쓴다. */
export function equals(a, b) {
  return isDeepStrictEqual(a, b);
}
