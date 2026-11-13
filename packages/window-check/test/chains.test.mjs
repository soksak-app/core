import assert from "node:assert/strict";
import test from "node:test";

import { connect } from "@soksak/client";
import { startCasePlayer } from "@soksak/client/testing";

import { Session } from "../app.mjs";
import { chainOf } from "../chains.mjs";

const CHAINS = { plugin: ["workbench.plugin.operation", "workbench.call", "host.binding.call"] };

// Starts the case player of the case and returns the session of a check on a client connected to it. Closing the player throws when
// the case was not played to its end.
async function session(t, name) {
  const server = await startCasePlayer(name);
  t.after(() => server.close());
  const client = await connect({ configDir: server.configDir });
  t.after(() => client.close());
  return { server, s: new Session({ name: "fixture", configDir: "/config/a" }, client) };
}

// The parameters of the log.query requests that the client sent, in order.
const logQueries = (server) => server.requests.filter((request) => request.method === "log.query").map((request) => request.params);

// Resolves when the player receives a request that satisfies the predicate. Call it before the request is sent.
const requested = (server, predicate) => new Promise((resolve) => {
  const listener = (message) => {
    if (!predicate(message)) return;
    server.events.off("request", listener);
    resolve(message);
  };
  server.events.on("request", listener);
});

test("a chain whose events are all in the log is returned with its identifier at once", async (t) => {
  const { server, s } = await session(t, "window-check-chain-complete");
  const { cid, events } = await chainOf(s, CHAINS, "plugin", { "host-b": 0 }, { action: "install", plugin: "x" });
  assert.equal(cid, "p1.1");
  assert.deepEqual(events.map((event) => event.event), ["workbench.plugin.operation", "workbench.call", "host.binding.call"]);
  assert.deepEqual(logQueries(server)[0], { channel: "all", event: "workbench.plugin.operation", since: { "host-b": 0 } });
  assert.deepEqual(logQueries(server)[1], { channel: "all", cid: "p1.1" });
});

test("a chain that lacks an event waits for the next notice of the host and completes with it", async (t) => {
  // The case sends the notice of host.log after the first value of its watch, so the chain reads the log again only after the notice.
  const { server, s } = await session(t, "window-check-chain-notice");
  const { cid } = await chainOf(s, CHAINS, "plugin", {}, { action: "remove", plugin: "x" });
  assert.equal(cid, "p1.2");
  assert.equal(logQueries(server).length, 4);
});

test("of two first events that match the fields the first in the log is the operation, and an event of another operation is not matched", async (t) => {
  // A second page can start its own operation with the same fields, as the page of a project window that opens does.
  const { s } = await session(t, "window-check-chain-first-operation");
  const { cid } = await chainOf(s, CHAINS, "plugin", {}, { action: "install", plugin: "x" });
  assert.equal(cid, "p1.3");
});

test("a first event without cids is refused", async (t) => {
  const { s } = await session(t, "window-check-chain-no-cids");
  await assert.rejects(chainOf(s, CHAINS, "plugin", {}, { action: "install", plugin: "x" }), /workbench\.plugin\.operation has no cids/);
});

test("a chain that never completes fails with the events it lacks", async (t) => {
  const { server, s } = await session(t, "window-check-chain-incomplete");
  const failed = assert.rejects(chainOf(s, CHAINS, "plugin", {}, { action: "install", plugin: "x" }),
    /the log announced no further change; plugin of p1\.6 lacks host\.binding\.call; it holds workbench\.plugin\.operation, workbench\.call.*\(endpoint connection closed\); plugin of p1\.6 lacks host\.binding\.call/);
  // The fifth request of the chain is the status.get that starts the wait on host.log. The close of the connection ends that wait, and
  // the error of the wait names the close.
  await requested(server, (message) => message.id === 5);
  s.client.close();
  await failed;
});
