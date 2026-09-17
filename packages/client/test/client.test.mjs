import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { connect, EndpointError } from "../client.js";
import { NO_REPLY, rpcError, sampleHandlers, startFakeEndpoint } from "@soksak/client/testing";

// 종료된 프로세스의 pid 를 얻는다.
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

test("watch resolves with the current value when it already satisfies the predicate", async (t) => {
  const sample = sampleHandlers();
  const server = await startFakeEndpoint(sample.handlers);
  t.after(() => server.close());
  const client = await connect({ configDir: server.configDir });
  t.after(() => client.close());
  assert.equal(await client.watch("main", "core.screen", (value) => value === "home"), "home");
  const methods = server.requests.map((m) => m.method);
  await client.request("windows.list");
  assert.deepEqual(server.requests.map((m) => m.method), [...methods.slice(0, 2), "status.unwatch", "windows.list"]);
  assert.deepEqual(methods.slice(0, 2), ["status.watch", "status.get"]);
});

test("watch resolves from a status.changed notification without further requests", async (t) => {
  const sample = sampleHandlers();
  const server = await startFakeEndpoint(sample.handlers);
  t.after(() => server.close());
  const client = await connect({ configDir: server.configDir });
  t.after(() => client.close());
  const got = server.nextRequest("status.get");
  const waiting = client.watch("main", "core.screen", (value) => value === "project", { timeout: 5000 });
  await got;
  sample.set("core.screen", "settings");
  sample.set("core.screen", "project");
  assert.equal(await waiting, "project");
  assert.deepEqual(server.requests.map((m) => m.method).slice(0, 2), ["status.watch", "status.get"]);
  assert.equal(server.requests.filter((m) => m.method === "status.get").length, 1);
});

test("watch rejects after the timeout and unwatches", async (t) => {
  const sample = sampleHandlers();
  const server = await startFakeEndpoint(sample.handlers);
  t.after(() => server.close());
  const client = await connect({ configDir: server.configDir });
  t.after(() => client.close());
  await assert.rejects(client.watch("main", "core.screen", () => false, { timeout: 50 }), { code: "ETIMEDOUT" });
  await client.request("windows.list");
  assert.ok(server.requests.some((m) => m.method === "status.unwatch"));
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
  const watching = client.watch("main", "core.screen", () => false, { timeout: Infinity });
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
  const waiting = client.watch("main", "probe.lines", (lines) => lines.includes("x"), { surface: "tab-a", timeout: 5000 });
  await ready;
  watcher.notify("status.changed", { window: "main", name: "probe.lines", value: ["x"] });
  watcher.notify("status.changed", { window: "main", name: "probe.lines", surface: "tab-b", value: ["x"] });
  watcher.notify("status.changed", { window: "main", name: "probe.lines", surface: "tab-a", value: ["x", "y"] });
  assert.deepEqual(await waiting, ["x", "y"]);
  assert.deepEqual(server.requests.filter((m) => m.method !== "status.unwatch").map((m) => m.params),
    Array(2).fill({ window: "main", name: "probe.lines", surface: "tab-a" }));
});
