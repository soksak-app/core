import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { channelOtherSeqs, expectedTimeline } from "../debug-timeline-files.mjs";

const line = (seq) => `${JSON.stringify({ ts_us: seq * 1000, seq, level: "info", layer: "host", event: "e" })}\n`;

/** A configuration folder whose logs folder holds the files and their texts. */
function folder(t, files) {
  const root = mkdtempSync(join(tmpdir(), "soksak-timeline-files-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "logs"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, "logs", name), text);
  return root;
}

test("the channel other is the rows of the files that are not debug files, their generations included, by process", (t) => {
  const root = folder(t, {
    "host-100-7.jsonl": line(3) + line(5),
    "host-100-7.jsonl.1": line(1),
    "host-100-7.debug.jsonl": line(2) + line(4),
    "rasterprobe-200-9.jsonl": line(1) + line(2) + '{"ts_us":1,"seq":3,"level":"info"', // the last line is not finished yet
    "state-a.json": "{}",
  });
  assert.deepEqual(Object.fromEntries(channelOtherSeqs(root)), { "host-100-7": [1, 3, 5], "rasterprobe-200-9": [1, 2] });
});

test("the appended rows are the rows after the start up to the tail, and the first page is the newest page up to the start", () => {
  const seqs = new Map([["host-100-7", [1, 3, 5, 6, 8]], ["rasterprobe-200-9", [1, 2]]]);
  // A process that the start does not name started after the first page, so each of its rows up to the tail was appended.
  assert.deepEqual(expectedTimeline(seqs, { "host-100-7": 3 }, { "host-100-7": 6, "rasterprobe-200-9": 1 }, 500), { first: 2, appended: 3 });
  assert.deepEqual(expectedTimeline(seqs, { "host-100-7": 8, "rasterprobe-200-9": 2 }, { "host-100-7": 8, "rasterprobe-200-9": 2 }, 4),
    { first: 4, appended: 0 });
});

test("a tail before the start of a process is refused", () => {
  assert.throws(() => expectedTimeline(new Map([["host-100-7", [1, 2]]]), { "host-100-7": 2 }, { "host-100-7": 1 }, 500),
    /the tail 1 of host-100-7 is before the start 2/);
});
