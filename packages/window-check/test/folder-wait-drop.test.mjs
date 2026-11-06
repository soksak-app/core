// FSEvents marks a batch after events were lost, and the backend of @parcel/watcher passes that to its callback as an error
// while its stream keeps running. A loaded system makes such a batch only at times, so the tests inject it into every
// callback (fault injection: test/platform/darwin/fsevents-drop.c, loaded with DYLD_INSERT_LIBRARIES) and require that a
// wait reads the folder at the report and goes on. The library writes its lines to the standard error of the child, and a
// child without the REPORTED line fails, because a run in which no report arrived passes without testing the report. A
// child with lost events learns of its changes only through the reports, and the second report of the same folder adds no
// event to the list of the backend, so only the report itself can wake the wait. The
// waits run in a child process because dyld injects at the start of a process. The tests of the other errors replace the
// watcher in this process and leave the children alone.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import { fileURLToPath } from "node:url";

let reportOfWatch = () => {};
mock.module("@parcel/watcher", {
  namedExports: {
    subscribe: async (_folder, callback) => {
      reportOfWatch = callback;
      return { unsubscribe: async () => {} };
    },
  },
});

const { untilFolderState } = await import("../folder-wait.mjs");
const { CHURN_TEST_LIMIT_MS, runChurn } = await import("./churn-child.mjs");

const here = fileURLToPath(new URL(".", import.meta.url));
const INJECTED = "fsevents-drop: loaded\nfsevents-drop: reported\n";
const CHILD_LIMIT_MS = 45000;

function folder(t, prefix) {
  const dir = fs.mkdtempSync(join(tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Builds the fault injection library and makes the watched folder of a test.
function injected(t) {
  const build = folder(t, "folder-wait-drop-build-");
  const library = join(build, "fsevents-drop.dylib");
  execFileSync("cc", ["-dynamiclib", "-framework", "CoreServices", "-o", library,
    join(here, "platform", "darwin", "fsevents-drop.c")]);
  return { library, watched: folder(t, "folder-wait-drop-") };
}

async function underReports(t, report, events, script, args) {
  const { library, watched } = injected(t);
  return new Promise((resolve) => {
    execFile(process.execPath, [join(here, script), watched, ...args],
      { env: { ...process.env, DYLD_INSERT_LIBRARIES: library, FSEVENTS_DROP_REPORT: report, FSEVENTS_DROP_EVENTS: events }, timeout: CHILD_LIMIT_MS, killSignal: "SIGKILL" },
      (error, stdout, stderr) => resolve({ code: error ? error.code ?? null : 0, signal: error?.signal ?? null, stdout, stderr }));
  });
}

for (const report of ["client", "kernel", "overflow"]) {
  test(`waits go on through the ${report} report of lost events while the folder changes`, { timeout: CHURN_TEST_LIMIT_MS }, async (t) => {
    const cycles = 20;
    const { library, watched } = injected(t);
    const env = { ...process.env, DYLD_INSERT_LIBRARIES: library, FSEVENTS_DROP_REPORT: report, FSEVENTS_DROP_EVENTS: "kept" };
    assert.deepEqual(await runChurn(watched, cycles, env, folder(t, "folder-wait-drop-progress-")),
      { code: 0, signal: null, stdout: `cycles ${cycles}\n`, stderr: INJECTED });
  });

  test(`the ${report} report of lost events ends a wait for one change before its deadline`, { timeout: 60000 }, async (t) => {
    assert.deepEqual(await underReports(t, report, "kept", "folder-wait-single-change.mjs", []),
      { code: 0, signal: null, stdout: "changed\n", stderr: INJECTED });
  });

  test(`the ${report} report in a batch that adds no event ends a wait before its deadline`, { timeout: 60000 }, async (t) => {
    assert.deepEqual(await underReports(t, report, "lost", "folder-wait-report-only.mjs", []),
      { code: 0, signal: null, stdout: "changed\n", stderr: INJECTED });
  });
}

test("an error of the watch that does not ask for a scan rejects the wait", { timeout: 10000 }, async () => {
  const ended = new Error("Buffer overflow. Some events may have been lost.");
  const waiting = untilFolderState("/watched", () => {
    queueMicrotask(() => reportOfWatch(ended));
    return undefined;
  }, 5000, () => new Error("expired"));
  await assert.rejects(waiting, ended);
});

test("a report of lost events without a state rejects no wait and reads the folder once more", { timeout: 10000 }, async () => {
  let reads = 0;
  const waiting = untilFolderState("/watched", () => {
    reads += 1;
    if (reads === 2) return reads;
    queueMicrotask(() => reportOfWatch(new Error("Too many events. File system must be re-scanned.")));
    return undefined;
  }, 5000, () => new Error("expired"));
  assert.equal(await waiting, 2);
});
