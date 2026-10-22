// Runs the published declared UI snapshot cases (packages/plugin-api/contract/declared-ui-snapshot.json) against the snapshot
// sender and receiver of core. Each step performs one operation and compares the messages, reports, deliveries, result and error
// that the step produced with the published output.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createSnapshotReceiver, createSnapshotSender } from "../snapshots.js";

const CONTRACT = JSON.parse(readFileSync(new URL("../contract/declared-ui-snapshot.json", import.meta.url), "utf8"));
const EXPECTED_IDS = [
  "snapshot.push.sends-first-value-and-releases-on-ack",
  "snapshot.push.counts-values-overwritten-in-transit",
  "snapshot.ack.refuses-a-seq-that-is-not-in-transit",
  "snapshot.peer-lost.reports-the-transit-and-the-dirty-value",
  "snapshot.peer-lost.refuses-an-unknown-reason",
  "snapshot.pull.returns-the-latest-value-and-refuses-a-missing-one",
  "snapshot.receiver.acknowledges-then-delivers",
];

/** Runs one case and returns the output of each step in order. */
function runCase(testCase) {
  const sent = [];
  const reports = [];
  const delivered = [];
  let listener = null;
  const onMessage = (next) => {
    listener = next;
    return () => { listener = null; };
  };
  const send = (message) => { sent.push(structuredClone(message)); };
  const sender = testCase.role === "receiver" ? null : createSnapshotSender({
    plugin: "demo",
    send,
    onMessage,
    report: (report) => reports.push(structuredClone(report)),
  });
  if (testCase.role === "receiver") {
    createSnapshotReceiver({
      plugin: "demo",
      send,
      onMessage,
      onSnapshot: (status, seq, value, skipped) => delivered.push({ status, seq, value, skipped }),
    });
  }
  return testCase.steps.map((step) => {
    let result = null;
    let throws = null;
    try {
      if ("push" in step) sender.push(step.push.status, step.push.value);
      else if ("ack" in step) listener({ event: "declared-ui.snapshot.ack", plugin: "demo", ...step.ack });
      else if ("peerLost" in step) sender.peerLost(step.peerLost);
      else if ("pull" in step) result = structuredClone(sender.pull(step.pull.status));
      else if ("receive" in step) listener(structuredClone(step.receive));
      else throw new Error(`unsupported snapshot step ${Object.keys(step).join(", ")}`);
    } catch (error) {
      throws = error.message;
    }
    return {
      sent: sent.splice(0),
      reports: reports.splice(0),
      delivered: delivered.splice(0),
      result,
      throws,
    };
  });
}

test("declared UI snapshot contract publishes the required cases in order", () => {
  assert.deepEqual(CONTRACT.cases.map(({ id }) => id), EXPECTED_IDS);
});

for (const testCase of CONTRACT.cases) {
  test(`declared UI snapshot ${testCase.id} matches each ordered step`, () => {
    const actual = runCase(testCase);
    assert.deepEqual(actual, testCase.steps.map(({ output }) => output));
  });
}
