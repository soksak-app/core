// A client that waits for a value of a watch settles its caller in the turn of the event that decides it and ends the watch with
// status.unwatch after that, so no caller waits for the answer of the unwatch (status.watch in docs/spec/exposure.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { connect, EndpointError } from "../client.js";
import { NO_REPLY, rpcError, startFakeEndpoint } from "@soksak/client/testing";

// Settles with "pending" when promise does not settle within ms, so a held caller fails the test instead of holding it.
const within = (promise, ms) => Promise.race([
  promise.then((value) => ({ value }), (error) => ({ error })),
  new Promise((resolve) => setTimeout(() => resolve("pending"), ms)),
]);

test("the timeout of a watch whose status.watch is never answered rejects the caller at its time", async (t) => {
  const server = await startFakeEndpoint({ "status.watch": () => NO_REPLY, "status.get": () => "home", "status.unwatch": () => null });
  t.after(() => server.close());
  const client = await connect({ configDir: server.configDir });
  t.after(() => client.close());
  const outcome = await within(client.watch("main", "core.screen", () => true, { timeout: 50 }), 500);
  assert.notEqual(outcome, "pending", "the caller waited for the unanswered status.watch after its timeout");
  assert.equal(outcome.error?.code, "ETIMEDOUT");
});

test("a satisfied watch resolves without waiting for the answer of its unwatch", async (t) => {
  const server = await startFakeEndpoint({ "status.watch": () => null, "status.get": () => "home", "status.unwatch": () => NO_REPLY });
  t.after(() => server.close());
  const client = await connect({ configDir: server.configDir });
  t.after(() => client.close());
  const outcome = await within(client.watch("main", "core.screen", (value) => value === "home"), 500);
  assert.notEqual(outcome, "pending", "the satisfied caller waited for the answer of status.unwatch");
  assert.equal(outcome.value, "home");
});

test("a refused unwatch does not change the result of the satisfied caller", async (t) => {
  const server = await startFakeEndpoint({
    "status.watch": () => null, "status.get": () => "home",
    "status.unwatch": () => Promise.reject(rpcError(1001, "unknown status core.screen")),
  });
  t.after(() => server.close());
  const client = await connect({ configDir: server.configDir });
  t.after(() => client.close());
  const outcome = await within(client.watch("main", "core.screen", (value) => value === "home"), 500);
  assert.ok(!(outcome.error instanceof EndpointError) && !outcome.error, `the unwatch refusal reached the caller: ${outcome.error?.message}`);
  assert.equal(outcome.value, "home");
});
