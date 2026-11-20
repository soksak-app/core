import assert from "node:assert/strict";
import test from "node:test";

import { catLine, endLine, intervalFigures, LONG_EVERY, LONG_LINE, loadLines, parseAmounts, parseOptions, textLines, WIDE_EVERY } from "../measure-terminal-text.mjs";

test("the amounts of lines are positive integers in increasing order", () => {
  assert.deepEqual(parseAmounts("100, 1000,10000"), [100, 1000, 10000]);
  assert.throws(() => parseAmounts("1000,100"), /--lines must increase \(1000,100\)/);
  assert.throws(() => parseAmounts("0"), /--lines must be a positive integer \(0\)/);
  assert.throws(() => parseAmounts("10,x"), /--lines must be a positive integer \(x\)/);
});

test("the options require the application, its configuration folder as an absolute path and the plugin", () => {
  assert.throws(() => parseOptions(["--sok", "sok", "--config-dir", "/c"]), /--plugin PLUGIN/);
  assert.throws(() => parseOptions(["--sok", "sok", "--config-dir", "c", "--plugin", "p"]), /--config-dir must be an absolute path \(c\)/);
  assert.deepEqual(parseOptions(["--sok", "sok", "--config-dir", "/c", "--plugin", "p", "--keys", "5"]),
    { sok: "sok", configDir: "/c", plugin: "p", amounts: [1000, 10000, 100000], frames: 600, keys: 5, json: false });
});

test("the text lines continue the numbering of the earlier amounts and hold wide and long lines", () => {
  const text = textLines(0, LONG_EVERY);
  const lines = text.split("\n");
  assert.equal(lines.pop(), "", "the text ends in a newline");
  assert.equal(lines.length, LONG_EVERY);
  assert.match(lines[0], /^line 0000000 the quick brown fox/);
  assert.match(lines[WIDE_EVERY - 1], /^line 0000009 한글 텍스트 漢字 かな 𝐀𝐁𝐂 🙂/);
  assert.equal(lines[LONG_EVERY - 1].length, LONG_LINE);
  assert.match(textLines(LONG_EVERY, LONG_EVERY + 1), /^line 0000100 /);
  assert.equal(textLines(5, 5), "");
  assert.throws(() => textLines(5, 4), /0 <= from <= to/);
});

test("the end line of an amount is in the output of the shell line and not in its echo", () => {
  const line = catLine("terminal-text.txt", 1000);
  assert.equal(line, "cat \"terminal-text.txt\"; printf 'text-''end %d\\n' 1000\n");
  assert.equal(line.includes(endLine(1000)), false);
  assert.equal(endLine(1000), "text-end 1000");
});

test("the load lines are the load average and the CPU usage of top", () => {
  const text = "Processes: 700 total\n2026/11/20 04:30:00\nLoad Avg: 6.43, 9.98, 11.75 \nCPU usage: 14.28% user, 17.6% sys, 68.64% idle \nSharedLibs: x\n";
  assert.deepEqual(loadLines(text), ["Load Avg: 6.43, 9.98, 11.75", "CPU usage: 14.28% user, 17.6% sys, 68.64% idle"]);
});

test("the figures of an interval divide the CPU time of each row and of the totals by the actions", () => {
  const rows = [{ role: "host", pid: 1, cpuSeconds: 0.5, bytes: 100 }, { role: "sidecar vt", pid: 3, cpuSeconds: 0.1, bytes: 30 }];
  const totals = { application: { cpuSeconds: 0.5, bytes: 100 }, sidecars: { cpuSeconds: 0.1, bytes: 30 }, total: { cpuSeconds: 0.6, bytes: 130 } };
  const figures = intervalFigures({ measurement: { seconds: 2, apps: [{ rows, totals }], errors: [] }, actions: 100 });
  assert.equal(figures.rows[0].msPerAction, 5);
  assert.deepEqual(figures.totals.total, { msPerAction: 6, bytes: 130 });
  assert.throws(() => intervalFigures({ measurement: { seconds: 2, apps: [{ rows, totals }], errors: [] }, actions: 0 }), /at least one action/);
});
