// The FSEvents callback of @parcel/watcher runs on its run loop thread as soon as the stream of a new watch is started,
// while the call that starts it has not returned, and it uses the tree of the watch state there. The test runs waits of
// untilFolderState while another thread changes the folder, and it holds every stream start for 50 ms after
// FSEventStreamStart (fault injection: test/platform/darwin/fsevents-start-delay.c, loaded with DYLD_INSERT_LIBRARIES through
// the fault injection facility of test/platform/platform.js, which fails by name on a system without it), so
// changes arrive at the callback during each start. The waits run in a child process, because a fault of the callback
// ends the process that runs it. The library writes LOADED to the standard error of the child when dyld loads it, and the
// test fails when the line is missing, because a child without the delay passes without testing the start.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CHURN_TEST_LIMIT_MS, runChurn } from "./churn-child.mjs";
import { watcherFaultEnvironment } from "./platform/platform.js";

const LOADED = "fsevents-start-delay: loaded\n";

function folder(t, prefix) {
  const dir = fs.mkdtempSync(join(tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("waits whose watches start while the folder changes end with the changed state and the process continues", { timeout: CHURN_TEST_LIMIT_MS }, async (t) => {
  const fault = await watcherFaultEnvironment("fsevents-start-delay", folder(t, "folder-wait-stream-start-build-"));
  const watched = folder(t, "folder-wait-stream-start-");
  const cycles = 20;
  const result = await runChurn(watched, cycles, { ...process.env, ...fault },
    folder(t, "folder-wait-stream-start-progress-"));
  assert.ok(result.stderr.startsWith(LOADED), "the stream start delay was not loaded: the child did not write "
    + `${JSON.stringify(LOADED)} first to its standard error with ${JSON.stringify(fault)} `
    + `(code ${result.code}, signal ${result.signal}); stderr: ${JSON.stringify(result.stderr)}`);
  assert.deepEqual(result, { code: 0, signal: null, stdout: `cycles ${cycles}\n`, stderr: LOADED });
});
