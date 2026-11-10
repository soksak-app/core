// A check removes the folder of its wait in its after hook, while the watch of the wait ends on a libuv worker thread. The
// FSEvents backend of @parcel/watcher 2.6.0 stopped and released the stream of a watch whose root was removed in its
// callback on the run loop thread, without the lock of the backend, while the end of the watch stopped the same stream on
// the worker thread, so one of them used a released stream: the process ended with SIGBUS in
// FSEventStreamUnscheduleFromRunLoop, or with SIGSEGV or SIGTRAP, after its checks passed.
// patches/@parcel__watcher@2.6.0.patch stops every stream on the run loop thread. The waits run in a child process, because
// a fault of the library ends the process that runs it, and the test judges by how the child ended.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const child = fileURLToPath(new URL("../../../folder-wait-root-removal.mjs", import.meta.url));

test("waits whose folder is removed while their watches end leave the process running", async (t) => {
  // FSEvents reports the removed root by its path with the links resolved, so the folder of the child holds no link.
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "folder-wait-root-removal-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rounds = 400;
  const result = await new Promise((resolve) => {
    execFile(process.execPath, [child, root, String(rounds)], (error, stdout, stderr) => {
      resolve({ code: error ? error.code ?? null : 0, signal: error?.signal ?? null, stdout, stderr });
    });
  });
  assert.deepEqual(result, { code: 0, signal: null, stdout: `rounds ${rounds}\n`, stderr: "" });
});
