// Replays the endpoint contract cases of docs/spec/cases/endpoint (docs/spec/endpoint.md#checks) against each running application. A case
// with replay true is sent through the endpoint of the application named by <config-dir>/endpoint.json: its frames of the client are
// sent in order, and each frame of the host must equal the frame of the case, with each variable bound to the value that the
// application chose and checked against its declared type. A case with replay false is reported as skipped with its reason.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { encodeFrame, FrameReader } from "@soksak/client/frame.js";
import { listCases, readCase } from "@soksak/client/testing";

// The longest wait for one frame of the host. A frame that does not arrive in it fails the case.
const FRAME_LIMIT_MS = 10000;
const VARIABLE = /^\$[a-z][a-z0-9-]*$/;
// The methods whose params.name names an entry of the exposure of the application.
const NAMED_METHODS = new Set(["status.get", "status.watch", "status.unwatch", "command.run", "element.rect", "element.act"]);

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
async function declaredNames(address) {
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

// The names that a case sends to a named method, with whether the case expects an error for that request.
function namedRequests(kase) {
  const replies = new Map();
  for (const step of kase.steps) if (step.reply) replies.set(step.reply.id, step.reply);
  const named = [];
  for (const step of kase.steps) {
    const frame = step.send;
    if (!frame || "raw_hex" in frame || !NAMED_METHODS.has(frame.method)) continue;
    const reply = replies.get(frame.id);
    named.push({ name: frame.params?.name, failed: reply === undefined || "error" in reply });
  }
  return named;
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

// Sends the frames of the case on one connection and matches each frame of the host with the case. Returns the problems found.
async function replay(kase, address) {
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
  return problems;
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: the application answers every replayable endpoint contract case`, { timeout: 600000 }, async (t) => {
    await open(t, app);
    const { address } = JSON.parse(readFileSync(join(app.configDir, "endpoint.json"), "utf8"));
    const declared = await declaredNames(address);
    for (const name of listCases()) {
      const kase = await readCase(name);
      await t.test(name, { timeout: 30000, skip: kase.replay ? false : kase.reason }, async () => {
        const undeclared = namedRequests(kase)
          .filter((request) => !request.failed && !declared.has(request.name))
          .map((request) => request.name);
        assert.deepEqual(undeclared, [], "the case names entries that the application does not declare");
        const problems = await replay(kase, address);
        assert.deepEqual(problems, [], problems.join("\n"));
      });
    }
  });
}
