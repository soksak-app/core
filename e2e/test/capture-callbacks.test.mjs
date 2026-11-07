import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { classifyCaptureCallbacks } from "../capture-callbacks.mjs";

const complete = (sequence = 1, frame = "frame-0001.bgra") => ({ sequence, status: 0, frame, displayTime: "1234" });
test("capture callbacks classify all defined noncomplete statuses without changing their rows", () => {
  const rows = [complete(), ...[1, 2, 3, 4, 5].map((status, index) => ({ sequence: index + 2, status, frame: null }))];
  const before = JSON.stringify(rows);
  const result = classifyCaptureCallbacks(rows, ["/declared/frame-0001.bgra"]);
  assert.equal(result.callbacks, rows);
  assert.equal(result.complete[0], rows[0]);
  assert.deepEqual(result.noncomplete, rows.slice(1));
  assert.equal(JSON.stringify(rows), before);
});
for (const [name, rows, paths] of [
  ["unknown status", [{ sequence: 1, status: 6, frame: null }], []],
  ["missing status", [{ sequence: 1, status: null, frame: null }], []],
  ["fractional status", [{ sequence: 1, status: 1.5, frame: null }], []],
  ["sequence gap", [complete(2)], ["frame-0001.bgra"]],
  ["duplicate callback sequence", [complete(), complete(1, "frame-0002.bgra")], ["frame-0001.bgra", "frame-0002.bgra"]],
  ["noncomplete frame claim", [{ sequence: 1, status: 1, frame: "frame-0001.bgra" }], ["frame-0001.bgra"]],
  ["complete without file", [complete(1, null)], []],
  ["duplicate complete frame", [complete(), complete(2)], ["frame-0001.bgra", "frame-0002.bgra"]],
  ["missing callback", [], ["frame-0001.bgra"]],
  ["missing retained file", [complete()], []],
  ["duplicate retained file", [complete()], ["frame-0001.bgra", "frame-0001.bgra"]],
  ["reordered frames", [complete(1, "frame-0002.bgra"), complete(2)], ["frame-0001.bgra", "frame-0002.bgra"]],
]) test(`capture callback classification rejects ${name}`, () => {
  assert.throws(() => classifyCaptureCallbacks(rows, paths), /callback|status|sequence|frame|file/i);
});

test("actual idle callback fixture retains its declared bytes and original callback numbers", () => {
  const provenance = JSON.parse(readFileSync(new URL("./fixtures/capture-idle-callbacks.provenance.json", import.meta.url), "utf8"));
  const raw = readFileSync(new URL("./fixtures/capture-idle-callbacks.json", import.meta.url));
  assert.equal(createHash("sha256").update(raw).digest("hex"), provenance.fixtureSha256);
  const rows = JSON.parse(raw);
  assert.deepEqual(rows.map(row => row.sequence), provenance.copiedSequences);
  assert.ok(rows.every(row => row.status === 1 && row.frame === null));
});
