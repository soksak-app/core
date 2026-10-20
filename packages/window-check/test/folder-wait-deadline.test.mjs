// At a high load the watch becomes active, or delivers a change, only after the deadline of a wait. The tests hold the
// watch past the deadline (fault injection at @parcel/watcher: the subscription resolves only after the test moved the
// clock past the deadline, and it reports no change) and require that the wait judges the state of the folder there.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";

let release = () => {};
mock.module("@parcel/watcher", {
  namedExports: {
    subscribe: () => new Promise((resolve) => {
      release = () => resolve({ unsubscribe: async () => {} });
    }),
  },
});

const { untilEndpoint } = await import("../endpoint-wait.mjs");

function folder(t) {
  const dir = fs.mkdtempSync(join(tmpdir(), "folder-wait-deadline-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function publish(dir, endpoint) {
  fs.writeFileSync(join(dir, "endpoint.json"), `${JSON.stringify(endpoint)}\n`);
}

// Starts the wait, moves the clock past its deadline while the watch is held, then lets the watch start.
function atDeadline(t, start) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const waiting = start();
  t.mock.timers.tick(100);
  release();
  return waiting;
}

test("a wait whose watch is not active at its deadline reports the content of the file at the deadline", { timeout: 10000 }, async (t) => {
  const dir = folder(t);
  publish(dir, { pid: 100, address: "/tmp/old.sock" });
  await assert.rejects(atDeadline(t, () => untilEndpoint(dir, 100, 100)),
    new RegExp(`^Error: ${join(dir, "endpoint.json")} named no process other than 100 within 100 ms; it holds \\{"pid":100,"address":"/tmp/old.sock"\\}$`));
});

test("a wait whose change is not notified by its deadline ends with the state that the folder holds at the deadline", { timeout: 10000 }, async (t) => {
  const dir = folder(t);
  publish(dir, { pid: 200, address: "/tmp/new.sock" });
  assert.deepEqual(await atDeadline(t, () => untilEndpoint(dir, 100, 100)), { pid: 200, address: "/tmp/new.sock" });
});
