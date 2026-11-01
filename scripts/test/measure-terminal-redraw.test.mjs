import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { frameMilliseconds, parseOptions, screenText } from "../measure-terminal-redraw.mjs";

test("the cpu milliseconds per frame are the cpu share of a second divided by the frames of that second", () => {
  assert.equal(frameMilliseconds(50, 20), 25);
  assert.equal(frameMilliseconds(0, 10), 0);
  assert.throws(() => frameMilliseconds(-1, 10), /cpu share must be a nonnegative number \(-1\)/);
  assert.throws(() => frameMilliseconds(10, 0), /rate must be a positive integer \(0\)/);
});

test("the text of a screen joins the characters of each row and counts an empty cell as spaces of its width", () => {
  assert.equal(screenText([[{ ch: "a", width: 1 }, { width: 1 }, { ch: "b", width: 1 }], [{ ch: "한", width: 2 }, { width: 0 }]]), "a b\n한");
  assert.throws(() => screenText(null), /terminal.screen is not a list of rows/);
});

test("the options require the application, the surface and a rate from 1 to 120", () => {
  assert.deepEqual(parseOptions(["--sok", "/bin/sok", "--config-dir", "/tmp/c", "--surface", "tab-a"]),
    { sok: "/bin/sok", configDir: "/tmp/c", surface: "tab-a", rate: 20, interval: 10, json: false });
  assert.throws(() => parseOptions(["--sok", "/bin/sok", "--config-dir", "/tmp/c"]), /required options/);
  assert.throws(() => parseOptions(["--sok", "s", "--config-dir", "rel", "--surface", "t"]), /--config-dir must be an absolute path \(rel\)/);
  assert.throws(() => parseOptions(["--sok", "s", "--config-dir", "/c", "--surface", "t", "--rate", "121"]), /--rate must be an integer from 1 to 120 \(121\)/);
});

test("the fixture draws a start line, its frames and an end line with the number of frames", { timeout: 10000 }, () => {
  const fixture = fileURLToPath(new URL("../fixtures/status-redraw.mjs", import.meta.url));
  const run = spawnSync(process.execPath, [fixture, "20", "0.3"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^status-redraw start rate=20\n/);
  const end = /status-redraw end frames=(\d+)\n$/.exec(run.stdout);
  assert.ok(end && Number(end[1]) >= 1, `the fixture ended without its frame count: ${JSON.stringify(run.stdout.slice(-60))}`);
  assert.equal(spawnSync(process.execPath, [fixture, "0", "1"], { encoding: "utf8" }).status, 1, "a rate of 0 was accepted");
});
