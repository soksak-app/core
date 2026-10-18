// A relaunch of the host ends when the page of the new process is ready, so the requests of the check and of its cleanups
// that the page answers do not fail with `the main page is not ready` (F192.3-3-1).
import assert from "node:assert/strict";
import { mock } from "node:test";
import test from "node:test";

const watched = [];
const newClient = {
  endpoint: { pid: 200, application: "probe" },
  close() {},
  request: async () => null,
  // The page of the new process becomes ready after the first value of host.windows.
  async watch(window, name, predicate) {
    watched.push({ window, name, before: predicate([{ window: "main", ready: false }]), after: predicate([{ window: "main", ready: true }]) });
    return [{ window: "main", ready: true }];
  },
};
class EndpointError extends Error {}
mock.module("@soksak/client", { namedExports: { connect: async () => newClient, EndpointError } });
mock.module("../endpoint-wait.mjs", { namedExports: { untilEndpoint: async () => ({ pid: 200 }) } });
const { Session } = await import("../app.mjs");

test("a relaunch waits until every window of the new process reports a ready page", async () => {
  const old = { endpoint: { pid: 100 }, close() {}, request: async () => null };
  const session = new Session({ name: "probe", configDir: "/nonexistent" }, old);
  await session.relaunch();
  assert.equal(session.client, newClient);
  assert.deepEqual(watched, [{ window: "main", name: "host.windows", before: false, after: true }]);
});
