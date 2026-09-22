import assert from "node:assert/strict";
import test from "node:test";
import { acquireWindowCheckSlot, assertEndpointUsesCurrentBuild } from "./app.mjs";

const endpoint = {
  pid: 123,
  executable: "/build/soksak-tauriv2",
  started: "2026-09-22T00:00:00.000Z",
};
const started = Date.parse(endpoint.started);

test("window checks reject a process started before the current binary", () => {
  assert.throws(
    () => assertEndpointUsesCurrentBuild(endpoint, endpoint.executable, started + 2001),
    /before the current build/,
  );
});

test("window checks accept the binary used to start the endpoint", () => {
  assert.doesNotThrow(() =>
    assertEndpointUsesCurrentBuild(endpoint, endpoint.executable, started - 1));
});

test("window checks reject an endpoint without an ISO start time", () => {
  assert.throws(
    () => assertEndpointUsesCurrentBuild({ ...endpoint, started: "not-a-time" }, endpoint.executable, started),
    /invalid endpoint start time/,
  );
});

test("window checks reject overlapping sessions that target the same application", async () => {
  const releaseFirst = await acquireWindowCheckSlot("tauriv2");
  await assert.rejects(
    () => acquireWindowCheckSlot("tauriv2"),
    /already active.*test-concurrency=1/,
  );
  releaseFirst();
  const releaseSecond = await acquireWindowCheckSlot("tauriv2");
  releaseSecond();
});
