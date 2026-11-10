// The end of a watch of @parcel/watcher runs on a libuv worker thread after its wait settled, while the next waits start
// their watches on the JavaScript thread. In 2.6.0 the end erased the shared backend from its map while a start in flight
// had taken it, so that start added its watch to a backend outside the map, the end of that watch built a new backend and
// found nothing to stop there, and the stream of the watch stayed open; the map itself was read and written on both threads
// without a lock. After a few hundred rounds the open streams made every new stream fail to start ("Error starting FSEvents
// stream"), and that failure released the callbacks of the watch on the worker thread. patches/@parcel__watcher@2.6.0.patch
// keeps a backend in the map while a runner holds it and locks the maps of the backends and the watchers. The waits run in a
// child process, because a fault of the library ends the process that runs it, and the test judges by how the child ended.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const child = fileURLToPath(new URL("../../../folder-wait-overlap.mjs", import.meta.url));

test("waits whose watches end while the next watches start leave no stream open and the process continues", async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), "folder-wait-overlap-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rounds = 400;
  const result = await new Promise((resolve) => {
    execFile(process.execPath, [child, root, String(rounds)], (error, stdout, stderr) => {
      resolve({ code: error ? error.code ?? null : 0, signal: error?.signal ?? null, stdout, stderr });
    });
  });
  assert.deepEqual(result, { code: 0, signal: null, stdout: `rounds ${rounds}\n`, stderr: "" });
});
