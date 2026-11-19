import assert from "node:assert/strict";
import test from "node:test";

import { boxShows, formatReport, groupFigures, groupOf, inputEnd, inputText, parseLengths, parseOptions, pasteBytes, shows } from "../measure-terminal-input.mjs";

/** The screen rows of `lines`, one cell for each character. */
const rows = (...lines) => lines.map((line) => [...line].map((ch) => ({ ch, width: 1 })));

test("the lengths are integers of at least the least value in increasing order", () => {
  assert.deepEqual(parseLengths("--lengths", "0, 1000,50000", 0), [0, 1000, 50000]);
  assert.throws(() => parseLengths("--pastes", "0", 1), /--pastes must hold integers of at least 1 \(0\)/);
  assert.throws(() => parseLengths("--lengths", "10,10", 0), /--lengths must increase \(10,10\)/);
  assert.deepEqual(parseOptions(["--sok", "s", "--config-dir", "/c", "--plugin", "p"]),
    { sok: "s", configDir: "/c", plugin: "p", lengths: [0, 1000, 10000, 50000], pastes: [10000, 50000], frames: 600, keys: 40, json: false });
  assert.throws(() => parseOptions(["--sok", "s", "--config-dir", "c", "--plugin", "p"]), /--config-dir must be an absolute path \(c\)/);
});

test("an input has its length and ends in the end that names the length", () => {
  for (const length of [0, 3, 6, 1000, 50000]) assert.equal(inputText(length).length, length);
  assert.equal(inputText(0), "");
  assert.equal(inputText(2), "01");
  assert.equal(inputText(3), "]3[");
  assert.equal(inputEnd(1000), "]1000[");
  assert.ok(inputText(1000).endsWith("]1000["));
  assert.equal(pasteBytes("ab"), "\x1b[200~ab\x1b[201~");
  assert.throws(() => inputText(-1), /non-negative integer/);
});

test("a screen shows a text across wrapped rows and the status line of the box exactly", () => {
  const screen = rows("$ 0123", "45]10[", "input-box chars=10000", "input-box chars=10   ");
  assert.equal(shows(screen, "2345]10["), true);
  assert.equal(shows(screen, "]11["), false);
  assert.equal(boxShows(screen, 10), true);
  assert.equal(boxShows(screen, 1000), false);
});

test("the groups count each process once and the report names each program and length", () => {
  assert.deepEqual(["host", "page w", "document t/", "webkit webcontent", "sidecar vt", "webkit gpu"].map(groupOf),
    ["host", "webContent", "webContent", "webContent", "sidecars", "other"]);
  const interval = (ms) => ({
    seconds: 1, actions: 1, errors: [],
    rows: [{ role: "host", pid: 1, msPerAction: ms, bytes: 1048576 }, { role: "document a/", pid: 2, msPerAction: 1, bytes: 1048576 },
      { role: "document b/", pid: 2, msPerAction: 1, bytes: 1048576 }, { role: "sidecar vt", pid: 3, msPerAction: 2, bytes: 2097152 }],
    totals: { total: { msPerAction: ms + 3 } },
  });
  assert.deepEqual(groupFigures(interval(4)), { host: { ms: 4, bytes: 1048576 }, webContent: { ms: 1, bytes: 1048576 },
    sidecars: { ms: 2, bytes: 2097152 }, other: { ms: 0, bytes: 0 } });
  const input = { length: 10, idle: { ...interval(0), occluded: [true, true], load: ["Load Avg: 1"] }, keys: { ...interval(4), presented: 2, load: [] } };
  const program = { inputs: [input], pastes: [{ length: 20, ...interval(5), load: [] }] };
  const report = formatReport({ plugin: "p", frames: 6, keys: 2, shell: program, box: program });
  assert.match(report, /^shell input 10: idle ms\/period 0\.000\/1\.000\/2\.000; key ms 4\.00\/1\.00\/2\.00 total 7\.00; MB 1\.0\/1\.0\/2\.0/m);
  assert.match(report, /^box paste 20: 1\.00 s, CPU ms 5\.0\/1\.0\/2\.0 total 8\.0/m);
});
