// The replay of the endpoint contract cases of docs/spec/cases/endpoint against a running application (docs/spec/endpoint.md#checks),
// which the window check e2e/endpoint-contract.test.mjs runs for each case with replay true.
import assert from "node:assert/strict";
import { connect } from "node:net";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { encodeFrame, FrameReader } from "@soksak/client/frame.js";

// The longest wait for one frame of the host. A frame that does not arrive in it fails the case.
const FRAME_LIMIT_MS = 10000;
const VARIABLE = /^\$[a-z][a-z0-9-]*$/;

// The frames of one connection in the order they arrive. A frame that is not read within the limit fails the case.
class Frames {
  #reader = new FrameReader();
  #queue = [];
  #waiting = [];

  constructor(socket) {
    socket.on("data", (chunk) => {
      try {
        for (const message of this.#reader.push(chunk)) this.#deliver({ message });
      } catch (error) {
        this.#deliver({ closed: true, error: error.message });
      }
    });
    socket.on("close", () => this.#deliver({ closed: true }));
    socket.on("error", (error) => this.#deliver({ closed: true, error: error.message }));
  }

  #deliver(item) {
    const waiter = this.#waiting.shift();
    if (waiter) waiter(item);
    else this.#queue.push(item);
  }

  next(what) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ${what} within ${FRAME_LIMIT_MS} ms`)), FRAME_LIMIT_MS);
      const take = (item) => {
        clearTimeout(timer);
        resolve(item);
      };
      if (this.#queue.length) take(this.#queue.shift());
      else this.#waiting.push(take);
    });
  }
}

function connectRaw(address) {
  return new Promise((resolve, reject) => {
    const socket = connect({ path: address });
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

// The names of the entries that the application declares in exposure.list of the main window (docs/spec/exposure.md).
export async function declaredNames(address) {
  const socket = await connectRaw(address);
  try {
    const frames = new Frames(socket);
    socket.write(encodeFrame({ jsonrpc: "2.0", id: 1, method: "exposure.list", params: { window: "main" } }));
    const item = await frames.next("exposure.list reply");
    assert.ok(item.message?.result, `exposure.list did not reply with a result: ${JSON.stringify(item)}`);
    const { status = [], commands = [], element = [] } = item.message.result;
    return new Set([...status, ...commands, ...element].map((entry) => entry.name));
  } finally {
    socket.destroy();
  }
}

// Whether the actual value has the declared type of a variable.
function typeMatches(spec, value) {
  const types = Array.isArray(spec.type) ? spec.type : [spec.type];
  return types.some((type) => {
    if (type === "any") return true;
    if (type === "null") return value === null;
    if (type === "integer") return Number.isInteger(value);
    if (type === "array") return Array.isArray(value);
    if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
    return typeof value === type;
  });
}

// Compares an expected frame part with the actual one. A variable binds the first value and must equal it wherever it appears again.
function match(expected, actual, variables, bound, path, problems) {
  if (typeof expected === "string" && VARIABLE.test(expected)) {
    const name = expected.slice(1);
    if (Object.hasOwn(bound, name)) {
      if (!isDeepStrictEqual(bound[name], actual)) {
        problems.push(`${path}: ${name} is ${JSON.stringify(actual)}, bound earlier to ${JSON.stringify(bound[name])}`);
      }
      return;
    }
    const spec = variables[name];
    if (!typeMatches(spec, actual)) problems.push(`${path}: ${JSON.stringify(actual)} is not of type ${JSON.stringify(spec.type)}`);
    else if (spec.keys && !(actual !== null && typeof actual === "object" && spec.keys.every((key) => Object.hasOwn(actual, key)))) {
      problems.push(`${path}: ${JSON.stringify(actual)} does not have the keys ${JSON.stringify(spec.keys)}`);
    }
    bound[name] = actual;
    return;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      problems.push(`${path}: expected an array of ${expected.length}, got ${JSON.stringify(actual)}`);
      return;
    }
    expected.forEach((item, index) => match(item, actual[index], variables, bound, `${path}[${index}]`, problems));
    return;
  }
  if (expected !== null && typeof expected === "object") {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) {
      problems.push(`${path}: expected an object, got ${JSON.stringify(actual)}`);
      return;
    }
    const keys = Object.keys(expected).sort();
    const actualKeys = Object.keys(actual).sort();
    if (!isDeepStrictEqual(keys, actualKeys)) {
      problems.push(`${path}: keys ${JSON.stringify(actualKeys)} are not ${JSON.stringify(keys)}`);
      return;
    }
    for (const key of keys) match(expected[key], actual[key], variables, bound, `${path}.${key}`, problems);
    return;
  }
  if (!isDeepStrictEqual(expected, actual)) problems.push(`${path}: ${JSON.stringify(actual)} is not ${JSON.stringify(expected)}`);
}

// Sends the frames of the case on one connection and matches each frame of the host with the case. Returns the problems found and
// the values that the variables of the case bound. A still that the case requests is a folder logs/captures/still-* that the host
// writes in the configuration folder of the session (docs/spec/endpoint.md, `diagnostics.capture.still`), so each still path that the
// host answers is tracked as a recording of the session, and the session removes the folder when the check ends.
export async function replay(session, kase, address) {
  const socket = await connectRaw(address);
  const frames = new Frames(socket);
  const variables = kase.variables ?? {};
  const bound = {};
  const problems = [];
  try {
    for (const [index, step] of kase.steps.entries()) {
      const where = `step ${index}`;
      if ("send" in step) {
        socket.write("raw_hex" in step.send ? Buffer.from(step.send.raw_hex, "hex") : encodeFrame(step.send));
      } else if ("reply" in step || "notify" in step) {
        const expected = step.reply ?? step.notify;
        const item = await frames.next(where);
        if (item.closed) {
          problems.push(`${where}: the connection closed${item.error ? ` (${item.error})` : ""} where the case has ${JSON.stringify(expected)}`);
          break;
        }
        match(expected, item.message, variables, bound, where, problems);
      } else if (step.close === "host") {
        const item = await frames.next(where);
        if (!item.closed) problems.push(`${where}: the host sent ${JSON.stringify(item.message)} where the case has its close`);
        break;
      } else {
        // close: "client" ends the case on the client side.
        break;
      }
    }
  } finally {
    socket.destroy();
  }
  // A replay with problems fails its check, and a failed check keeps every folder for diagnosis, so only a matched replay tracks.
  if (problems.length === 0) for (const path of stillPaths(kase, bound)) session.trackRecording(dirname(path));
  return { problems, bound };
}

// The paths of the stills that the host answered to the diagnostics.capture.still requests of the case, as the variables bound them.
function stillPaths(kase, bound) {
  const stills = new Set();
  for (const step of kase.steps) if (step.send?.method === "diagnostics.capture.still") stills.add(step.send.id);
  const paths = [];
  for (const step of kase.steps) {
    const path = step.reply?.result?.path;
    if (!stills.has(step.reply?.id) || typeof path !== "string" || !VARIABLE.test(path)) continue;
    const name = path.slice(1);
    if (typeof bound[name] === "string") paths.push(bound[name]);
  }
  return paths;
}
