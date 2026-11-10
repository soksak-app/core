import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { connect, EndpointError } from "../client.js";
import { NO_REPLY, rpcError, sampleHandlers, startFakeEndpoint } from "@soksak/client/testing";

// Obtains the pid of an exited process.
function exitedPid() {
  return spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout * 1;
}

test("replies are matched to requests by id when answered out of order", async (t) => {
  const release = [];
  let bothReceived;
  const received = new Promise((resolve) => (bothReceived = resolve));
  const server = await startFakeEndpoint({
    echo: (params) =>
      new Promise((resolve) => {
        release.push(() => resolve(params.value));
        if (release.length === 2) bothReceived();
      }),
  });
  t.after(() => server.close());
  const client = await connect({ configDir: server.configDir });
  t.after(() => client.close());
  const first = client.request("echo", { value: "first" });
  const second = client.request("echo", { value: "second" });
  await received;
  release[1]();
  release[0]();
  assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
  assert.deepEqual(server.requests.map((m) => m.id), [1, 2]);
});

test("notifications are delivered to listeners until they unsubscribe", async (t) => {
  const server = await startFakeEndpoint({ ping: () => null });
  t.after(() => server.close());
  const client = await connect({ configDir: server.configDir });
  t.after(() => client.close());
  await client.request("ping");
  const lines = [];
  const received = new Promise((resolve) => {
    const off = client.on("diagnostics.log", (params) => {
      lines.push(params.line);
      off();
      resolve();
    });
  });
  server.notify("diagnostics.log", { window: "main", line: "one" });
  await received;
  server.notify("diagnostics.log", { window: "main", line: "two" });
  await client.request("ping");
  assert.deepEqual(lines, ["one"]);
});

test("error replies become EndpointError with the code", async (t) => {
  const sample = sampleHandlers();
  const server = await startFakeEndpoint(sample.handlers);
  t.after(() => server.close());
  const client = await connect({ configDir: server.configDir });
  t.after(() => client.close());
  await assert.rejects(client.request("status.get", { window: "gone", name: "core.screen" }), (error) => {
    assert.ok(error instanceof EndpointError);
    assert.equal(error.code, 1003);
    assert.match(error.message, /gone/);
    return true;
  });
});

/** Resolves when the fake endpoint receives a request that satisfies the predicate. */
const requested = (server, predicate) => new Promise((resolve) => {
  const listener = (message) => {
    if (!predicate(message)) return;
    server.events.off("request", listener);
    resolve(message);
  };
  server.events.on("request", listener);
});

test("watch resolves with the current value when it already satisfies the predicate", async (t) => {
  const sample = sampleHandlers();
  const server = await startFakeEndpoint(sample.handlers);
  t.after(() => server.close());
  const client = await connect({ configDir: server.configDir });
  t.after(() => client.close());
  const unwatched = requested(server, (m) => m.method === "status.unwatch");
  assert.equal(await client.watch("main", "core.screen", (value) => value === "home"), "home");
  await unwatched;
  assert.deepEqual(server.requests.map((m) => m.method), ["status.watch", "status.get", "status.unwatch"]);
});

test("a predicate that answers anything but true or false ends the watch with an error and unwatches", async (t) => {
  const sample = sampleHandlers();
  const server = await startFakeEndpoint(sample.handlers);
  t.after(() => server.close());
  const client = await connect({ configDir: server.configDir });
  t.after(() => client.close());
  for (const [answer, type] of [["home", "string"], [null, "null"], [undefined, "undefined"], [{ text: 1 }, "object"], [1, "number"]]) {
    const unwatched = requested(server, (m) => m.method === "status.unwatch");
    await assert.rejects(client.watch("main", "core.screen", () => answer),
      new RegExp(`^Error: the predicate of core\\.screen returned ${type}, not a boolean$`));
    await unwatched;
  }
});

test("a predicate that throws ends the watch with its error and unwatches", async (t) => {
  const sample = sampleHandlers();
  const server = await startFakeEndpoint(sample.handlers);
  t.after(() => server.close());
  const client = await connect({ configDir: server.configDir });
  t.after(() => client.close());
  const unwatched = requested(server, (m) => m.method === "status.unwatch");
  const failure = new Error("the predicate failed");
  await assert.rejects(client.watch("main", "core.screen", () => { throw failure; }), (error) => error === failure);
  await unwatched;
});

test("watch resolves before its status.unwatch is answered, and sends the unwatch after it", async (t) => {
  let finishUnwatch;
  let entered;
  // Resolves when the endpoint runs the handler of status.unwatch, which holds its answer until the test sends it.
  const held = new Promise((resolve) => { entered = resolve; });
  const server = await startFakeEndpoint({
    "status.watch": () => null,
    "status.get": () => "home",
    "status.unwatch": () => new Promise((resolve) => { finishUnwatch = () => resolve(null); entered(); }),
    ping: () => null,
  });
  t.after(() => server.close());
  const client = await connect({ configDir: server.configDir });
  t.after(() => client.close());
  assert.equal(await client.watch("main", "core.screen", (value) => value === "home"), "home");
  await held;
  finishUnwatch();
  // The answer of a later request comes after the answer of the unwatch, which changed nothing of the connection.
  assert.equal(await client.request("ping"), null);
  assert.equal(client.closed, false);
});

test("watch resolves from a status.changed notification without further requests", async (t) => {
  const sample = sampleHandlers();
  const server = await startFakeEndpoint(sample.handlers);
  t.after(() => server.close());
  const client = await connect({ configDir: server.configDir });
  t.after(() => client.close());
  const got = server.nextRequest("status.get");
  const waiting = client.watch("main", "core.screen", (value) => value === "project");
  await got;
  sample.set("core.screen", "settings");
  sample.set("core.screen", "project");
  assert.equal(await waiting, "project");
  assert.deepEqual(server.requests.map((m) => m.method).slice(0, 2), ["status.watch", "status.get"]);
  assert.equal(server.requests.filter((m) => m.method === "status.get").length, 1);
});

// A watch has no time limit (status.watch in docs/spec/exposure.md): a value that does not satisfy the predicate keeps it open,
// and the close of the connection ends it with the close error.
test("a watch that no value satisfies waits until the connection closes, and the close rejects it", async (t) => {
  const sample = sampleHandlers();
  const server = await startFakeEndpoint(sample.handlers);
  t.after(() => server.close());
  const client = await connect({ configDir: server.configDir });
  const got = server.nextRequest("status.get");
  let settled = false;
  const watching = client.watch("main", "core.screen", () => false).finally(() => { settled = true; });
  await got;
  sample.set("core.screen", "settings");
  // The answer of a later request comes after the value of status.get and the change, which the predicate refused.
  await client.request("windows.list");
  assert.equal(settled, false, "the watch ended before an event that decides it");
  client.close();
  await assert.rejects(watching, { message: "endpoint connection closed" });
  assert.equal(server.requests.some((m) => m.method === "status.unwatch"), false, "a closed connection sent status.unwatch");
});

test("concurrent watches of one name unwatch only after the last one ends", async (t) => {
  const sample = sampleHandlers();
  const server = await startFakeEndpoint(sample.handlers);
  t.after(() => server.close());
  const client = await connect({ configDir: server.configDir });
  t.after(() => client.close());
  const home = client.watch("main", "core.screen", (value) => value === "home");
  const later = client.watch("main", "core.screen", (value) => value === "later");
  assert.equal(await home, "home");
  await client.request("windows.list");
  assert.ok(!server.requests.some((m) => m.method === "status.unwatch"));
  sample.set("core.screen", "later");
  assert.equal(await later, "later");
  assert.equal(server.requests.filter((m) => m.method === "status.watch").length, 1);
});

test("a watch that ends before its subscription is confirmed is unsubscribed before the next watch", async (t) => {
  const sample = sampleHandlers();
  // Holds the response of the first status.watch until the test sends it.
  let confirm;
  let first = true;
  const handlers = {
    ...sample.handlers,
    "status.watch": (params, connection) => {
      if (!first) return sample.handlers["status.watch"](params, connection);
      first = false;
      // A change that arrives before the answer of status.watch reaches the predicate, which ends the watch before its
      // subscription is confirmed.
      connection.notify("status.changed", { window: "main", name: "core.screen", value: "early" });
      return new Promise((resolve) => {
        confirm = () => resolve(sample.handlers["status.watch"](params, connection));
      });
    },
  };
  const server = await startFakeEndpoint(handlers);
  t.after(() => server.close());
  const client = await connect({ configDir: server.configDir });
  t.after(() => client.close());
  const unwatch = requested(server, (message) => message.method === "status.unwatch");
  const failure = new Error("the predicate failed");
  const ended = client.watch("main", "core.screen", () => { throw failure; });
  const failed = assert.rejects(ended, (error) => error === failure);
  await client.request("windows.list");
  confirm();
  await unwatch;
  await failed;
  const nextStatusWatch = requested(server, (message) => message.method === "status.watch");
  const next = client.watch("main", "core.screen", (value) => value === "later");
  await nextStatusWatch;
  const subscriptions = () => server.requests.map((m) => m.method).filter((m) => m === "status.watch" || m === "status.unwatch");
  assert.deepEqual(subscriptions(), ["status.watch", "status.unwatch", "status.watch"]);
  sample.set("core.screen", "later");
  assert.equal(await next, "later");
});

test("watch rejects with the endpoint error for an unknown name", async (t) => {
  const sample = sampleHandlers();
  const server = await startFakeEndpoint(sample.handlers);
  t.after(() => server.close());
  const client = await connect({ configDir: server.configDir });
  t.after(() => client.close());
  await assert.rejects(client.watch("main", "core.missing", () => true), { code: 1001 });
});

test("a closed connection rejects pending requests and watches", async (t) => {
  const server = await startFakeEndpoint({
    hang: () => NO_REPLY,
    "status.watch": () => null,
    "status.get": () => "x",
  });
  t.after(() => server.close());
  const client = await connect({ configDir: server.configDir });
  const got = server.nextRequest("status.get");
  const pending = client.request("hang");
  const watching = client.watch("main", "core.screen", () => false);
  await got;
  for (const connection of server.connections) connection.socket.destroy();
  await assert.rejects(pending, /connection closed/);
  await assert.rejects(watching, /connection closed/);
  await assert.rejects(client.request("hang"), /connection closed/);
});

test("close rejects pending requests", async (t) => {
  const server = await startFakeEndpoint({ hang: () => NO_REPLY });
  t.after(() => server.close());
  const client = await connect({ configDir: server.configDir });
  const pending = client.request("hang");
  client.close();
  await assert.rejects(pending, /connection closed/);
  assert.match((await client.ended).message, /connection closed/);
});

test("an undeclared method closes the connection and rejects the request", async (t) => {
  const server = await startFakeEndpoint({});
  t.after(() => server.close());
  const client = await connect({ configDir: server.configDir });
  await assert.rejects(client.request("nothing"), /connection closed/);
  assert.equal(client.closed, true);
});

test("a stale pid is an error naming endpoint.json", async (t) => {
  const pid = exitedPid();
  const server = await startFakeEndpoint({}, { pid });
  t.after(() => server.close());
  const file = join(server.configDir, "endpoint.json");
  await assert.rejects(connect({ configDir: server.configDir }), (error) => {
    assert.ok(error.message.includes(file), error.message);
    assert.ok(error.message.includes(String(pid)), error.message);
    return true;
  });
  assert.equal(server.connections.size, 0);
});

test("a missing endpoint.json is an error naming the file", async (t) => {
  const server = await startFakeEndpoint({});
  t.after(() => server.close());
  const file = join(server.configDir, "endpoint.json");
  rmSync(file);
  await assert.rejects(connect({ configDir: server.configDir }), new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("rpcError helper keeps the code", () => {
  assert.equal(rpcError(1002, "x").code, 1002);
});

test("a watch with a surface requests that surface and ignores changes of other watches", async (t) => {
  let watcher = null;
  let watched;
  const ready = new Promise((resolve) => (watched = resolve));
  const server = await startFakeEndpoint({
    "status.watch": (params, connection) => { watcher = connection; return null; },
    "status.get": () => { watched(); return []; },
    "status.unwatch": () => null,
  });
  t.after(() => server.close());
  const client = await connect({ configDir: server.configDir });
  t.after(() => client.close());
  const waiting = client.watch("main", "probe.lines", (lines) => lines.includes("x"), { surface: "tab-a" });
  await ready;
  watcher.notify("status.changed", { window: "main", name: "probe.lines", value: ["x"] });
  watcher.notify("status.changed", { window: "main", name: "probe.lines", surface: "tab-b", value: ["x"] });
  watcher.notify("status.changed", { window: "main", name: "probe.lines", surface: "tab-a", value: ["x", "y"] });
  assert.deepEqual(await waiting, ["x", "y"]);
  assert.deepEqual(server.requests.filter((m) => m.method !== "status.unwatch").map((m) => m.params),
    Array(2).fill({ window: "main", name: "probe.lines", surface: "tab-a" }));
});

// The host ends a watch whose producer ended with status.ended and removes it without an unwatch (docs/spec/exposure.md), so the
// watch rejects with ENDED, sends no status.unwatch, and a later watch of the same key subscribes anew.
test("status.ended rejects the watch with ENDED and a later watch subscribes again", async (t) => {
  let watcher = null;
  let read;
  const reads = new Promise((resolve) => (read = resolve));
  const server = await startFakeEndpoint({
    "status.watch": (params, connection) => { watcher = connection; return null; },
    "status.get": () => { read(); return []; },
    "status.unwatch": () => null,
  });
  t.after(() => server.close());
  const client = await connect({ configDir: server.configDir });
  t.after(() => client.close());
  const first = client.watch("main", "probe.lines", () => false, { surface: "tab-a" });
  const second = client.watch("main", "probe.lines", () => false, { surface: "tab-a" });
  await reads;
  watcher.notify("status.ended", { window: "main", name: "probe.lines", surface: "tab-b", reason: "surface-closed" });
  watcher.notify("status.ended", { window: "main", name: "probe.lines", surface: "tab-a", reason: "surface-closed" });
  for (const watch of [first, second]) {
    await assert.rejects(watch, (error) => error.code === "ENDED" && error.message === "status probe.lines ended: surface-closed");
  }
  // The watch resolves before its unwatch reaches the endpoint, so the check waits for that request.
  const unwatched = requested(server, (m) => m.method === "status.unwatch");
  const again = client.watch("main", "probe.lines", (lines) => lines.length === 0, { surface: "tab-a" });
  assert.deepEqual(await again, []);
  await unwatched;
  assert.deepEqual(server.requests.map((m) => m.method).filter((m) => m !== "status.get"),
    ["status.watch", "status.watch", "status.unwatch"]);
});

// The host ends the subscription of the connection before it asks the page, so an unwatch that the host refuses ends the watch
// whatever its code (status.watch in docs/spec/exposure.md): the caller keeps its value and the connection stays open.
for (const [code, message] of [[1003, "the main page is not ready"], [-32603, "internal error"]]) {
  test(`an unwatch refused with ${code} leaves the result of the watch and keeps the connection`, async (t) => {
    const sample = sampleHandlers();
    const server = await startFakeEndpoint({ ...sample.handlers,
      "status.unwatch": () => { throw rpcError(code, message); } });
    t.after(() => server.close());
    const client = await connect({ configDir: server.configDir });
    t.after(() => client.close());
    const unwatched = requested(server, (m) => m.method === "status.unwatch");
    assert.equal(await client.watch("main", "core.screen", (value) => value === "home"), "home");
    await unwatched;
    assert.equal(await client.request("status.get", { window: "main", name: "core.screen" }), "home");
    assert.equal(client.closed, false, `an unwatch refused with ${code} closed the connection`);
  });
}

// The sample endpoint answers the element methods of the host: exposure.list lists the element entries in `element`, and
// element.rect and element.act address an element entry by name (docs/spec/exposure.md).
test("the sample endpoint lists element entries and answers element.rect and element.act", async (t) => {
  const sample = sampleHandlers();
  const server = await startFakeEndpoint(sample.handlers);
  t.after(() => server.close());
  const client = await connect({ configDir: server.configDir });
  t.after(() => client.close());
  const listed = await client.request("exposure.list", { window: "main" });
  assert.deepEqual(Object.keys(listed), ["status", "commands", "element"]);
  assert.deepEqual(listed.element.map((entry) => entry.name), ["core.tab"]);
  assert.deepEqual(await client.request("element.rect", { window: "main", name: "core.tab", index: 1 }),
    { x: 10, y: 20, width: 30, height: 40, index: 1, role: null, document: { x: 0, y: 0 } });
  assert.equal(await client.request("element.act", { window: "main", name: "core.tab", action: "click" }), null);
});
