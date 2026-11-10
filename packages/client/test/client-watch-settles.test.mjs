// A client that waits for a value of a watch settles its caller in the turn of the event that decides it and ends the watch with
// status.unwatch after that, so no caller waits for the answer of the unwatch (status.watch in docs/spec/exposure.md). The wait has
// no time limit: the satisfying value, a failed answer of status.watch or status.get, an error of the predicate or the close of the
// connection ends it. Each test awaits the caller directly; a caller that stays held is reported by the limit of the test runner.
import { test } from "node:test";
import assert from "node:assert/strict";
import { connect, EndpointError } from "../client.js";
import { NO_REPLY, rpcError, startFakeEndpoint } from "@soksak/client/testing";

test("a watch whose status.watch is never answered waits until the connection closes, and the close rejects it", async (t) => {
  const server = await startFakeEndpoint({ "status.watch": () => NO_REPLY, "status.get": () => "home", "status.unwatch": () => null });
  t.after(() => server.close());
  const client = await connect({ configDir: server.configDir });
  t.after(() => client.close());
  const received = server.nextRequest("status.watch");
  let settled = false;
  const watching = client.watch("main", "core.screen", () => true).finally(() => { settled = true; });
  await received;
  assert.equal(settled, false, "the watch ended before an event that decides it");
  for (const connection of server.connections) connection.socket.destroy();
  await assert.rejects(watching, { message: "endpoint connection closed" });
  assert.equal(client.closed, true);
});

test("a watch refuses a timeout option and sends nothing", async (t) => {
  const server = await startFakeEndpoint({
    "status.watch": () => null, "status.get": () => "home", "status.unwatch": () => null, ping: () => null,
  });
  t.after(() => server.close());
  const client = await connect({ configDir: server.configDir });
  t.after(() => client.close());
  for (const timeout of [50, 10000, Infinity]) {
    await assert.rejects(Promise.resolve().then(() => client.watch("main", "core.screen", () => true, { timeout })),
      (error) => (error instanceof TypeError || error instanceof RangeError) && /\btimeout\b/.test(error.message),
      `a watch accepted the timeout ${timeout}`);
  }
  // The answer of a later request comes after any request that a refused watch could have sent.
  assert.equal(await client.request("ping"), null);
  assert.deepEqual(server.requests.map((m) => m.method), ["ping"]);
});

test("a watch whose status.get fails rejects with that error and unwatches", async (t) => {
  const server = await startFakeEndpoint({
    "status.watch": () => null,
    "status.get": () => Promise.reject(rpcError(1003, "the main page is not ready")),
    "status.unwatch": () => null,
  });
  t.after(() => server.close());
  const client = await connect({ configDir: server.configDir });
  t.after(() => client.close());
  const unwatched = server.nextRequest("status.unwatch");
  await assert.rejects(client.watch("main", "core.screen", () => true), { code: 1003, message: "the main page is not ready" });
  await unwatched;
});

test("a satisfied watch resolves without waiting for the answer of its unwatch", async (t) => {
  const server = await startFakeEndpoint({ "status.watch": () => null, "status.get": () => "home", "status.unwatch": () => NO_REPLY });
  t.after(() => server.close());
  const client = await connect({ configDir: server.configDir });
  t.after(() => client.close());
  assert.equal(await client.watch("main", "core.screen", (value) => value === "home"), "home");
});

test("a refused unwatch does not change the result of the satisfied caller", async (t) => {
  const server = await startFakeEndpoint({
    "status.watch": () => null, "status.get": () => "home",
    "status.unwatch": () => Promise.reject(rpcError(1001, "unknown status core.screen")),
  });
  t.after(() => server.close());
  const client = await connect({ configDir: server.configDir });
  t.after(() => client.close());
  const unwatched = server.nextRequest("status.unwatch");
  let outcome;
  try {
    outcome = { value: await client.watch("main", "core.screen", (value) => value === "home") };
  } catch (error) {
    outcome = { error };
  }
  assert.ok(!(outcome.error instanceof EndpointError) && !outcome.error, `the unwatch refusal reached the caller: ${outcome.error?.message}`);
  assert.equal(outcome.value, "home");
  // The refusal ended the watch on the host, so the connection stays open and answers the next request.
  await unwatched;
  assert.equal(await client.request("status.get", { window: "main", name: "core.screen" }), "home");
  assert.equal(client.closed, false, "a refused unwatch closed the connection");
});
