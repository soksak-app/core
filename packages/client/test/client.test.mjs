import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { connect, EndpointError } from "../client.js";
import { startCasePlayer } from "@soksak/client/testing";

// Obtains the pid of an exited process.
function exitedPid() {
  return spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout * 1;
}

// Starts the player of a case and closes it after the test. Closing throws when the case was not played to its end.
async function play(t, name, options) {
  const server = await startCasePlayer(name, options);
  t.after(() => server.close());
  return server;
}

/** Resolves when the player receives a request that satisfies the predicate. Call it before the request is sent. */
const requested = (server, predicate) => new Promise((resolve) => {
  const listener = (message) => {
    if (!predicate(message)) return;
    server.events.off("request", listener);
    resolve(message);
  };
  server.events.on("request", listener);
});

// The predicate of a watch of the core screen status, whose value is an object with the field screen.
const screenIs = (screen) => (value) => value.screen === screen;

test("replies are matched to requests by id when answered out of order", async (t) => {
  const server = await play(t, "replies-out-of-order");
  const client = await connect({ configDir: server.configDir });
  t.after(() => client.close());
  const [screen, windows] = await Promise.all([
    client.request("status.get", { window: "main", name: "core.screen" }),
    client.request("windows.list"),
  ]);
  assert.equal(screen.screen, "workspace");
  assert.equal(windows[0].window, "main");
  assert.deepEqual(server.requests.map((m) => m.id), [1, 2]);
});

test("notifications are delivered to listeners until they unsubscribe", async (t) => {
  const server = await play(t, "notifications-until-unsubscribe");
  const client = await connect({ configDir: server.configDir });
  t.after(() => client.close());
  const names = [];
  const off = client.on("status.changed", (params) => {
    names.push(params.name);
    off();
  });
  await client.request("status.watch", { window: "main", name: "core.screen" });
  await client.request("windows.list");
  assert.deepEqual(names, ["core.screen"]);
});

test("error replies become EndpointError with the code", async (t) => {
  const server = await play(t, "error-window-missing");
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
  const server = await play(t, "watch-current-value");
  const client = await connect({ configDir: server.configDir });
  t.after(() => client.close());
  const unwatched = requested(server, (m) => m.method === "status.unwatch");
  assert.equal((await client.watch("main", "core.screen", screenIs("workspace"))).screen, "workspace");
  await unwatched;
  assert.deepEqual(server.requests.map((m) => m.method), ["status.watch", "status.get", "status.unwatch"]);
});

test("a predicate that answers anything but true or false ends the watch with an error and unwatches", async (t) => {
  const server = await play(t, "watch-predicate-not-boolean");
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
  const server = await play(t, "watch-current-value");
  const client = await connect({ configDir: server.configDir });
  t.after(() => client.close());
  const unwatched = requested(server, (m) => m.method === "status.unwatch");
  const failure = new Error("the predicate failed");
  await assert.rejects(client.watch("main", "core.screen", () => { throw failure; }), (error) => error === failure);
  await unwatched;
});

test("watch resolves before its status.unwatch is answered, and sends the unwatch after it", async (t) => {
  const server = await play(t, "watch-unwatch-unanswered");
  const client = await connect({ configDir: server.configDir });
  t.after(() => client.close());
  const unwatched = requested(server, (m) => m.method === "status.unwatch");
  assert.equal((await client.watch("main", "core.screen", screenIs("workspace"))).screen, "workspace");
  await unwatched;
  // The answer of a later request comes before the answer of the unwatch, which changed nothing of the connection.
  assert.equal((await client.request("windows.list")).length, 1);
  assert.equal(client.closed, false);
});

test("watch resolves from a status.changed notification without further requests", async (t) => {
  const server = await play(t, "watch-from-status-changed");
  const client = await connect({ configDir: server.configDir });
  t.after(() => client.close());
  const unwatched = requested(server, (m) => m.method === "status.unwatch");
  assert.equal((await client.watch("main", "core.screen", screenIs("workspace"))).screen, "workspace");
  await unwatched;
  assert.deepEqual(server.requests.map((m) => m.method), ["status.watch", "status.get", "status.unwatch"]);
});

// A watch has no time limit (status.watch in docs/spec/exposure.md): a value that does not satisfy it keeps it open,
// and the close of the connection ends it with the close error.
test("a watch that no value satisfies waits until the connection closes, and the close rejects it", async (t) => {
  const server = await play(t, "watch-until-close");
  const client = await connect({ configDir: server.configDir });
  const got = server.nextRequest("status.get");
  let settled = false;
  const watching = client.watch("main", "core.screen", () => false).finally(() => { settled = true; });
  await got;
  await client.request("windows.list");
  assert.equal(settled, false, "the watch ended before an event that decides it");
  client.close();
  await assert.rejects(watching, { message: "endpoint connection closed" });
  assert.equal(server.requests.some((m) => m.method === "status.unwatch"), false, "a closed connection sent status.unwatch");
});

test("concurrent watches of one name unwatch only after the last one ends", async (t) => {
  const server = await play(t, "watch-shared-subscription");
  const client = await connect({ configDir: server.configDir });
  t.after(() => client.close());
  const unwatched = requested(server, (m) => m.method === "status.unwatch");
  const home = client.watch("main", "core.screen", screenIs("workspace"));
  const later = client.watch("main", "core.screen", screenIs("library"));
  assert.equal((await home).screen, "workspace");
  await client.request("windows.list");
  assert.ok(!server.requests.some((m) => m.method === "status.unwatch"));
  assert.equal((await later).screen, "library");
  await unwatched;
  assert.equal(server.requests.filter((m) => m.method === "status.watch").length, 1);
});

test("a watch that ends before its subscription is confirmed is unsubscribed before the next watch", async (t) => {
  const server = await play(t, "watch-ended-before-confirm");
  const client = await connect({ configDir: server.configDir });
  t.after(() => client.close());
  const received = server.nextRequest("status.watch");
  const unwatch = requested(server, (message) => message.method === "status.unwatch");
  const failure = new Error("the predicate failed");
  const ended = client.watch("main", "core.screen", () => { throw failure; });
  const failed = assert.rejects(ended, (error) => error === failure);
  await received;
  await client.request("windows.list");
  await unwatch;
  await failed;
  const unwatchedAgain = requested(server, (message) => message.method === "status.unwatch");
  const next = client.watch("main", "core.screen", screenIs("workspace"));
  assert.equal((await next).screen, "workspace");
  await unwatchedAgain;
  const subscriptions = () => server.requests.map((m) => m.method).filter((m) => m === "status.watch" || m === "status.unwatch");
  assert.deepEqual(subscriptions(), ["status.watch", "status.unwatch", "status.watch", "status.unwatch"]);
});

test("watch rejects with the endpoint error for an unknown name", async (t) => {
  const server = await play(t, "status-unknown-name");
  const client = await connect({ configDir: server.configDir });
  t.after(() => client.close());
  await assert.rejects(client.watch("main", "core.missing", () => true), { code: 1001 });
});

test("a closed connection rejects pending requests and watches", async (t) => {
  const server = await play(t, "closed-by-host-pending");
  const client = await connect({ configDir: server.configDir });
  const got = server.nextRequest("status.get");
  const pending = client.request("windows.list");
  const watching = client.watch("main", "core.screen", () => false);
  await got;
  await assert.rejects(pending, /connection closed/);
  await assert.rejects(watching, /connection closed/);
  await assert.rejects(client.request("windows.list"), /connection closed/);
});

test("close rejects pending requests", async (t) => {
  const server = await play(t, "closed-by-client-pending");
  const client = await connect({ configDir: server.configDir });
  // The request reaches the player before the close, so the case sees the request that the close leaves unanswered.
  const received = server.nextRequest("windows.list");
  const pending = client.request("windows.list");
  await received;
  client.close();
  await assert.rejects(pending, /connection closed/);
  assert.match((await client.ended).message, /connection closed/);
});

test("an undeclared method closes the connection and rejects the request", async (t) => {
  const server = await play(t, "undeclared-method");
  const client = await connect({ configDir: server.configDir });
  await assert.rejects(client.request("nothing"), /connection closed/);
  assert.equal(client.closed, true);
});

test("a stale pid is an error naming endpoint.json", async (t) => {
  const pid = exitedPid();
  const server = await play(t, "no-request", { pid });
  const file = join(server.configDir, "endpoint.json");
  await assert.rejects(connect({ configDir: server.configDir }), (error) => {
    assert.ok(error.message.includes(file), error.message);
    assert.ok(error.message.includes(String(pid)), error.message);
    return true;
  });
  assert.equal(server.connections.size, 0);
});

test("a missing endpoint.json is an error naming the file", async (t) => {
  const server = await play(t, "no-request");
  const file = join(server.configDir, "endpoint.json");
  rmSync(file);
  await assert.rejects(connect({ configDir: server.configDir }), new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("a watch with a surface requests that surface and ignores changes of other watches", async (t) => {
  const server = await play(t, "watch-surface-changes");
  const client = await connect({ configDir: server.configDir });
  t.after(() => client.close());
  const unwatched = requested(server, (m) => m.method === "status.unwatch");
  const waiting = client.watch("main", "probe.lines", (lines) => lines.includes("x"), { surface: "tab-a" });
  assert.deepEqual(await waiting, ["x", "y"]);
  await unwatched;
  assert.deepEqual(server.requests.filter((m) => m.method !== "status.unwatch").map((m) => m.params),
    Array(2).fill({ window: "main", name: "probe.lines", surface: "tab-a" }));
});

// The host ends a watch whose producer ended with status.ended and removes it without an unwatch (docs/spec/exposure.md), so the
// watch rejects with ENDED, sends no status.unwatch, and a later watch of the same key subscribes anew.
test("status.ended rejects the watch with ENDED and a later watch subscribes again", async (t) => {
  const server = await play(t, "watch-surface-ended");
  const client = await connect({ configDir: server.configDir });
  t.after(() => client.close());
  const first = client.watch("main", "probe.lines", () => false, { surface: "tab-a" });
  const second = client.watch("main", "probe.lines", () => false, { surface: "tab-a" });
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

// The host ends the subscription of the connection before it asks the page, so an unwatch that the host refuses ends the watch whatever
// its code (status.watch in docs/spec/exposure.md): the caller keeps its value and the connection stays open.
for (const name of ["unwatch-refused-not-ready", "unwatch-refused-internal"]) {
  test(`an unwatch refused by the host leaves the result of the watch and keeps the connection (${name})`, async (t) => {
    const server = await play(t, name);
    const client = await connect({ configDir: server.configDir });
    t.after(() => client.close());
    const unwatched = requested(server, (m) => m.method === "status.unwatch");
    assert.equal((await client.watch("main", "core.screen", screenIs("workspace"))).screen, "workspace");
    await unwatched;
    assert.equal((await client.request("status.get", { window: "main", name: "core.screen" })).screen, "workspace");
    assert.equal(client.closed, false, `${name} closed the connection`);
  });
}

// The exposure of the window lists the element entries that element.rect and element.act address by name (docs/spec/exposure.md).
test("exposure.list lists the element entries and element.rect and element.act answer the entry by name and index", async (t) => {
  const listing = await play(t, "exposure-list");
  const listed = await connect({ configDir: listing.configDir });
  t.after(() => listed.close());
  const exposure = await listed.request("exposure.list", { window: "main" });
  assert.deepEqual(Object.keys(exposure), ["status", "commands", "element"]);
  assert.deepEqual(exposure.element.map((entry) => entry.name), ["core.tab"]);

  const element = await play(t, "element-rect-and-act");
  const client = await connect({ configDir: element.configDir });
  t.after(() => client.close());
  assert.deepEqual(await client.request("element.rect", { window: "main", name: "core.tab", index: 1 }),
    { x: 10, y: 20, width: 30, height: 40, zoom: 1, role: null, document: { x: 0, y: 0 } });
  assert.equal(await client.request("element.act", { window: "main", name: "core.tab", action: "click" }), null);
});
