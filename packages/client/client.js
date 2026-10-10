// Local endpoint client: reads endpoint.json, connects, and handles JSON-RPC requests and notifications.
import { readFile } from "node:fs/promises";
import { connect as connectSocket } from "node:net";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { encodeFrame, FrameReader } from "./frame.js";
import { transport as platformTransport } from "./platform/platform.js";

/** Turns an endpoint error response into an Error that has a code. */
export class EndpointError extends Error {
  constructor({ code, message, data }) {
    super(message);
    this.name = "EndpointError";
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

// Checks whether a process with the pid exists. EPERM means that a process of another user exists.
function running(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/** Reads and validates <configDir>/endpoint.json. */
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

/** Connects to the endpoint of the configuration directory and returns the client. */
export async function connect({ configDir }) {
  if (!configDir) throw new Error("configDir is required");
  const endpoint = await readEndpoint(configDir);
  const socket = await new Promise((resolve, reject) => {
    // The path of net.connect accepts both a Unix socket path and a named pipe name.
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
  // The number of status.watch uses per window, name and surface. The host records one watch per connection, so the last use calls unwatch when it ends.
  #watches = new Map();
  #subscriptions = new Map();
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

  /** Sends a request and returns the result. An error response rejects with an EndpointError. */
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

  /** Registers a notification listener and returns the function that removes it. */
  on(method, fn) {
    let set = this.#listeners.get(method);
    if (!set) this.#listeners.set(method, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }

  /**
   * Watches a value with status.watch and resolves with the first value that satisfies the predicate.
   * It also checks the current value. If the predicate is not satisfied within timeout (ms), it rejects with code "ETIMEDOUT".
   * surface names the surface that a surface page registered under that name.
   */
  watch(window, name, predicate, { timeout = 10000, surface } = {}) {
    // default: surface is an optional option; without it the page status is watched, so the surface part of the key is null.
    const key = JSON.stringify([window, name, surface ?? null]);
    const target = surface === undefined ? { window, name } : { window, name, surface };
    return new Promise((resolve, reject) => {
      let done = false;
      let timer;
      let seen = false;
      let last;
      const finish = (error, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        off();
        offClose();
        this.#release(key, target).then(() => {
          if (error) reject(error);
          else resolve(value);
        }, (releaseError) => {
          reject(error ? new AggregateError([error, releaseError], `status ${name} and its unwatch both failed`) : releaseError);
        });
      };
      const check = (value) => {
        seen = true;
        last = value;
        let ok;
        try {
          ok = predicate(value);
        } catch (error) {
          finish(error);
          return;
        }
        if (ok) finish(null, value);
      };
      // Registers first so that a notification that arrives before the status.watch response is also received.
      const off = this.on("status.changed", (params) => {
        if (params?.window === window && params?.name === name && params?.surface === surface) check(params.value);
      });
      const offClose = this.#onClose((error) => finish(error));
      if (timeout !== Infinity) {
        timer = setTimeout(() => {
          const error = new Error(`status ${name} did not satisfy the condition within ${timeout} ms; ` +
            (seen ? `last value ${JSON.stringify(last)}` : "no value was received"));
          error.code = "ETIMEDOUT";
          finish(error);
        }, timeout);
      }
      this.#acquire(key, target)
        .then(() => (done ? undefined : this.request("status.get", target)))
        .then((value) => {
          if (!done) check(value);
        })
        .catch((error) => finish(error));
    });
  }

  /** Closes the connection. Pending requests are rejected. */
  close() {
    this.#fail(new Error("endpoint connection closed"));
  }

  get closed() {
    return this.#closed !== null;
  }

  /** A promise that resolves with the Error of the closing cause when the connection ends. */
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

  /**
   * Chains the subscription requests of one target in the order they were sent. The unsubscription and the next subscription
   * must be sent and applied in this order (docs/spec/endpoint.md).
   */
  #subscribe(key, send) {
    // default: without an earlier subscription request of the same key, there is nothing to wait for.
    const previous = this.#subscriptions.get(key) ?? Promise.resolve();
    const sent = previous.then(send);
    const settled = sent.then(() => {}, () => {});
    this.#subscriptions.set(key, settled);
    settled.then(() => {
      if (this.#subscriptions.get(key) === settled) this.#subscriptions.delete(key);
    });
    return sent;
  }

  #acquire(key, target) {
    const entry = this.#watches.get(key);
    if (entry) {
      entry.count += 1;
      return entry.ready;
    }
    const created = { count: 1, ready: this.#subscribe(key, () => this.request("status.watch", target)) };
    this.#watches.set(key, created);
    created.ready.catch(() => {
      if (this.#watches.get(key) === created) this.#watches.delete(key);
    });
    return created.ready;
  }

  #release(key, target) {
    const entry = this.#watches.get(key);
    if (!entry) return Promise.resolve();
    entry.count -= 1;
    if (entry.count > 0) return Promise.resolve();
    this.#watches.delete(key);
    if (this.#closed) return Promise.resolve();
    // The subscription precedes this turn, so its result is already decided here. A failed subscription is not unsubscribed.
    const released = this.#subscribe(key, () => entry.ready.then(() => this.request("status.unwatch", target), (error) => {
      throw new Error(`status.unwatch skipped because status.watch failed: ${error.message}`);
    }));
    released.then(undefined, (error) => {
      this.#fail(new Error(`status.unwatch failed: ${error.message}`));
    });
    return released;
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
      // default: a notification without a registered listener has nowhere to be delivered.
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

/** Compares whether two JSON values are equal. Used to write the predicate of watch. */
export function equals(a, b) {
  return isDeepStrictEqual(a, b);
}
