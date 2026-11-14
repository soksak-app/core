// At a high load the watch becomes active, or delivers a change, only after the process or the connection whose state a wait
// awaits ended. The tests hold the watch past the abort of the signal of the wait (the fault point watchFault.start of folder-wait.mjs: the
// real subscription starts only after the test aborted the signal) and require that the wait judges
// the state of the folder at the abort.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { untilEndpoint } from "../endpoint-wait.mjs";
import { endWatches, watchFault } from "../folder-wait.mjs";
import { joinedFailure } from "../failure.mjs";

// The fault point watchFault.start holds the start of the watch until the test releases it.
let release = () => {};

function folder(t) {
  const dir = fs.mkdtempSync(join(tmpdir(), "folder-wait-abort-"));
  watchFault.start = () => new Promise((resolve) => { release = resolve; });
  t.after(async () => {
    watchFault.start = null;
    const ended = await endWatches();
    fs.rmSync(dir, { recursive: true, force: true });
    if (ended.length === 1) throw ended[0];
    if (ended.length > 1) throw joinedFailure(`${ended.length} watch ends failed`, ended);
  });
  return dir;
}

function publish(dir, endpoint) {
  fs.writeFileSync(join(dir, "endpoint.json"), `${JSON.stringify(endpoint)}\n`);
}

// Starts the wait, aborts its signal while the watch is held, then lets the watch start.
function atAbort(start) {
  const starter = new AbortController();
  const waiting = start(starter.signal);
  starter.abort(new Error("the starter ended"));
  release();
  return waiting;
}

test("a wait whose watch is not active at the abort reports the content of the file at the abort", { timeout: 10000 }, async (t) => {
  const dir = folder(t);
  publish(dir, { pid: 100, address: "/tmp/old.sock" });
  await assert.rejects(atAbort((signal) => untilEndpoint(dir, 100, { signal })),
    new RegExp(`^Error: ${join(dir, "endpoint.json")} named no process other than 100 before the starter ended; it holds \\{"pid":100,"address":"/tmp/old.sock"\\}$`));
});

test("a wait whose change is not notified by the abort ends with the state that the folder holds at the abort", { timeout: 10000 }, async (t) => {
  const dir = folder(t);
  publish(dir, { pid: 200, address: "/tmp/new.sock" });
  assert.deepEqual(await atAbort((signal) => untilEndpoint(dir, 100, { signal })), { pid: 200, address: "/tmp/new.sock" });
});
