// The FSEvents callback of @parcel/watcher runs on its run loop thread as soon as the stream of a new watch is started,
// while the call that starts it has not returned, and it uses the tree of the watch state there. The test runs waits of
// untilFolderState while another thread changes the folder, and it holds every stream start for 50 ms after
// FSEventStreamStart (fault injection: test/platform/darwin/fsevents-start-delay.c, loaded with DYLD_INSERT_LIBRARIES), so
// changes arrive at the callback during each start. The waits run in a child process, because a fault of the callback
// ends the process that runs it.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

function folder(t, prefix) {
  const dir = fs.mkdtempSync(join(tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("waits whose watches start while the folder changes end with the changed state and the process continues", { timeout: 60000 }, async (t) => {
  const build = folder(t, "folder-wait-stream-start-build-");
  const library = join(build, "fsevents-start-delay.dylib");
  execFileSync("cc", ["-dynamiclib", "-framework", "CoreServices", "-o", library,
    join(here, "platform", "darwin", "fsevents-start-delay.c")]);
  const watched = folder(t, "folder-wait-stream-start-");
  const cycles = 20;
  const result = await new Promise((resolve) => {
    execFile(process.execPath, [join(here, "folder-wait-churn.mjs"), watched, String(cycles)],
      { env: { ...process.env, DYLD_INSERT_LIBRARIES: library }, timeout: 45000, killSignal: "SIGKILL" },
      (error, stdout, stderr) => resolve({ code: error ? error.code ?? null : 0, signal: error?.signal ?? null, stdout, stderr }));
  });
  assert.deepEqual({ code: result.code, signal: result.signal, stdout: result.stdout },
    { code: 0, signal: null, stdout: `cycles ${cycles}\n` }, `stderr: ${result.stderr}`);
});
