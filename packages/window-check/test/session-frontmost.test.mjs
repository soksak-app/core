// A frontmost change during a check is not a criterion of the check result: the session finish neither reads nor changes
// the frontmost application (F292-39).
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { playApplication } from "../fixtures/endpoint-player.mjs";

const root = realpathSync(mkdtempSync(join(tmpdir(), "soksak-session-frontmost-")));
// The sequential-run lock of the harness is placed in this folder instead of the shared temporary folder.
process.env.TMPDIR = root;
delete process.env.SOKSAK_RUN_ID;
delete process.env.SOKSAK_RUN_FOLDER;
delete process.env.SOKSAK_APP;
const { open } = await import("../app.mjs");

// The folder of the file is removed when the file ends, also when a selection runs none of its tests.
test.after(() => rmSync(root, { recursive: true, force: true }));

// The system tool that reads or activates the frontmost application is osascript. The check runs with no program folder in PATH, so a
// session that starts osascript fails with ENOENT: the open and the finish of a session start no such tool.
test("a frontmost change to another application during a check does not reject the check result", async (t) => {
  const player = await playApplication(t, "window-check-open-idle", "wailsv3");
  const afters = [];
  const check = { name: "probe check", passed: true, diagnostic() {}, after: (fn) => afters.push(fn) };
  const path = process.env.PATH;
  process.env.PATH = "";
  try {
    await open(check, { name: "wailsv3", binary: process.execPath, configDir: player.configDir });
    assert.equal(afters.length, 1);
    await afters[0]();
  } finally {
    process.env.PATH = path;
  }
});
