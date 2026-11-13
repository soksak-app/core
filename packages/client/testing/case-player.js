// Endpoint case player for tests: plays one endpoint contract case (docs/spec/endpoint.md#checks) on a local address. It sends the host
// frames of the case in their order and answers no frame that the case does not contain at its place.
import { EventEmitter } from "node:events";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { encodeFrame, FrameReader } from "../frame.js";
import { createAddress, transport } from "../platform/platform.js";

/** The directory of the endpoint contract cases. This module lives in packages/client/testing, three levels below the repository root. */
export const CASE_DIRECTORY = fileURLToPath(new URL("../../../docs/spec/cases/endpoint/", import.meta.url));

const VARIABLE = /^\$[a-z][a-z0-9-]*$/;

/** Lists the names of the cases. */
export function listCases() {
  return readdirSync(CASE_DIRECTORY)
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -".json".length))
    .sort();
}

// Collects the variable names that a value uses.
function variablesIn(value, names) {
  if (typeof value === "string" && VARIABLE.test(value)) names.add(value.slice(1));
  else if (Array.isArray(value)) for (const item of value) variablesIn(item, names);
  else if (value && typeof value === "object") for (const item of Object.values(value)) variablesIn(item, names);
  return names;
}

// Checks the form of a case; a case that does not have it is an error that names the file.
function checkCase(kase, file) {
  const fail = (reason) => {
    throw new Error(`${file}: ${reason}`);
  };
  if (!kase || typeof kase !== "object" || Array.isArray(kase)) fail("the case is not an object");
  if (kase.name !== file.slice(file.lastIndexOf("/") + 1, -".json".length)) fail("name does not match the file name");
  if (typeof kase.description !== "string" || kase.description === "") fail("description must be a non-empty string");
  if (typeof kase.replay !== "boolean") fail("replay must be true or false");
  if (kase.replay === false && (typeof kase.reason !== "string" || kase.reason === "")) fail("a case with replay false must give its reason");
  const variables = kase.variables ?? {};
  if (!variables || typeof variables !== "object" || Array.isArray(variables)) fail("variables must be an object");
  for (const [name, spec] of Object.entries(variables)) {
    if (!VARIABLE.test(`$${name}`)) fail(`variable ${name} must have the form a-z, digits and hyphens`);
    if (!spec || typeof spec !== "object" || !("example" in spec)) fail(`variable ${name} must have an example`);
    if (!("type" in spec)) fail(`variable ${name} must have a type`);
  }
  if (!Array.isArray(kase.steps)) fail("steps must be an array");
  const used = new Set();
  kase.steps.forEach((step, index) => {
    const where = `step ${index}`;
    const kinds = step && typeof step === "object" ? ["send", "reply", "notify", "close"].filter((kind) => kind in step) : [];
    if (kinds.length !== 1) fail(`${where} must have exactly one of send, reply, notify and close`);
    if (kinds[0] === "send") {
      const raw = "raw_hex" in step.send;
      if (!raw && typeof step.send.method !== "string") fail(`${where} send must name a method`);
    } else if (kinds[0] === "reply") {
      if (step.reply.jsonrpc !== "2.0" || !("id" in step.reply)) fail(`${where} reply must have jsonrpc 2.0 and an id`);
      variablesIn(step.reply, used);
    } else if (kinds[0] === "notify") {
      if (step.notify.jsonrpc !== "2.0" || typeof step.notify.method !== "string" || "id" in step.notify) {
        fail(`${where} notify must be a JSON-RPC 2.0 notification without an id`);
      }
      variablesIn(step.notify, used);
    } else if (step.close !== "host" && step.close !== "client") {
      fail(`${where} close must be host or client`);
    }
  });
  for (const name of used) if (!Object.hasOwn(variables, name)) fail(`variable $${name} is not declared`);
}

/** Reads and checks one case by its name. */
export async function readCase(name) {
  const file = join(CASE_DIRECTORY, `${name}.json`);
  let kase;
  try {
    kase = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`${file} is not a readable case: ${error.message}`);
  }
  checkCase(kase, file);
  return kase;
}

/**
 * Starts a player for the case of the name. The player writes endpoint.json of a new configuration directory and listens on the address
 * that the file names. close throws when a frame of the client differs from the case, and when a step of the case was not played.
 */
export async function startCasePlayer(name, { pid = process.pid, values = {} } = {}) {
  const kase = await readCase(name);
  const { steps } = kase;
  const variables = kase.variables ?? {};
  // A test gives a variable the value that the host would choose when the value depends on the test, as the Go and Rust players do.
  for (const variable of Object.keys(values)) {
    if (!Object.hasOwn(variables, variable)) throw new Error(`${name}: variable $${variable} is not declared`);
  }
  const { address, remove } = createAddress("soksak-case");
  const configDir = mkdtempSync(join(tmpdir(), "soksak-config-"));
  const connections = new Set();
  // The connections that a close step of the host ended; their close is the step itself, and a later step may be a frame
  // of the client on a new connection.
  const closedByHost = new WeakSet();
  const requests = [];
  const failures = [];
  // The index of the next step of the case.
  let cursor = 0;
  // "request" is emitted for each frame of the client that the case contains, after the host frames that follow it are sent.
  const events = new EventEmitter();
  // Resolves when the last step of the case has been played.
  let resolvePlayed;
  const played = new Promise((resolve) => {
    resolvePlayed = resolve;
  });
  // Moves to the next step of the case.
  const advance = () => {
    cursor += 1;
    if (cursor === steps.length) resolvePlayed();
  };

  // "failure" is emitted with each failure of the case, so that a process that plays the case can end at its first failure.
  const fail = (message) => {
    failures.push(`${name}: ${message}`);
    events.emit("failure", failures.at(-1));
  };

  // Replaces each variable with its example value. A variable names a value that the host chooses in the application.
  const substitute = (value) => {
    if (typeof value === "string" && VARIABLE.test(value)) {
      const variable = value.slice(1);
      return structuredClone(Object.hasOwn(values, variable) ? values[variable] : variables[variable].example);
    }
    if (Array.isArray(value)) return value.map(substitute);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item)]));
    return value;
  };

  // Sends the host frames that follow the position of the case, in order, up to the next frame of the client.
  const sendHostFrames = (socket) => {
    while (cursor < steps.length && !("send" in steps[cursor])) {
      const step = steps[cursor];
      if ("reply" in step) socket.write(encodeFrame(substitute(step.reply)));
      else if ("notify" in step) socket.write(encodeFrame(substitute(step.notify)));
      else if (step.close === "host") {
        advance();
        closedByHost.add(socket);
        socket.destroy();
        return;
      } else return;
      advance();
    }
  };

  // Checks a frame of the client against the next step, which must be a send step with the same frame.
  const receive = (socket, message) => {
    requests.push(message);
    const step = steps[cursor];
    if (!step || !("send" in step)) {
      fail(`the client sent ${JSON.stringify(message)} where the case has ${step ? JSON.stringify(step) : "no further step"}`);
      socket.destroy();
      return;
    }
    if (!isDeepStrictEqual(message, step.send)) {
      fail(`step ${cursor}: the client sent ${JSON.stringify(message)}, the case expects ${JSON.stringify(step.send)}`);
      socket.destroy();
      return;
    }
    advance();
    sendHostFrames(socket);
    events.emit("request", message);
  };

  const server = createServer((socket) => {
    connections.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => {
      connections.delete(socket);
      if (closedByHost.has(socket)) return;
      if (steps[cursor]?.close === "client") advance();
      else if (cursor < steps.length) fail(`the client closed the connection before step ${cursor}: ${JSON.stringify(steps[cursor])}`);
    });
    const reader = new FrameReader();
    socket.on("data", (chunk) => {
      let messages;
      try {
        messages = [...reader.push(chunk)];
      } catch (error) {
        fail(`the client sent an invalid frame: ${error.message}`);
        socket.destroy();
        return;
      }
      for (const message of messages) receive(socket, message);
    });
    sendHostFrames(socket);
  });
  await new Promise((resolve) => server.listen(address, resolve));
  const endpoint = {
    transport,
    address,
    pid,
    application: "wailsv3",
    version: "0.0.40",
    executable: process.execPath,
    started: new Date().toISOString(),
  };
  writeFileSync(join(configDir, "endpoint.json"), JSON.stringify(endpoint));

  return {
    configDir,
    /** The frames that the client sent, in order. */
    requests,
    /** The sockets that are open. */
    connections,
    events,
    /** Resolves when the last step of the case has been played. */
    played,
    /** Resolves with the frame when the next request of the method is received. Call it before the request is sent. */
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
    async close() {
      // The close of the client reaches the player after the client has settled its own requests, so a case that ends
      // with the close of the client waits for that close instead of closing the connection itself.
      if (steps[cursor]?.close === "client") {
        await Promise.all([...connections].map((socket) => new Promise((resolve) => socket.once("close", resolve))));
      }
      for (const socket of connections) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      remove();
      rmSync(configDir, { recursive: true, force: true });
      if (cursor < steps.length) fail(`${steps.length - cursor} steps were not played; the next step is ${JSON.stringify(steps[cursor])}`);
      if (failures.length) throw new Error(failures.join("\n"));
    },
  };
}
