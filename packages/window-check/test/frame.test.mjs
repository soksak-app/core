import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { frames } from "../frame.mjs";

test("frames are listed in the order of their stills, with the stills that wrote no frame left out", (t) => {
  // A frame is named by the index of its still in the recording; a failed or not requested still leaves a gap in the names.
  const directory = mkdtempSync(join(tmpdir(), "soksak-frame-order-"));
  t.after(() => rmSync(directory, { recursive: true }));
  for (const index of [0, 1, 3, 10, 4095]) writeFileSync(join(directory, `frame-${String(index).padStart(4, "0")}.bgra`), "");
  writeFileSync(join(directory, "frame-0004.bgra.partial"), "");
  assert.deepEqual(frames(directory).map((path) => path.split("/").at(-1)),
    ["frame-0000.bgra", "frame-0001.bgra", "frame-0003.bgra", "frame-0010.bgra", "frame-4095.bgra"]);
});

test("frames refuse a name that is not the four digits of a still index", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "soksak-frame-name-"));
  t.after(() => rmSync(directory, { recursive: true }));
  writeFileSync(join(directory, "frame-10000.bgra"), "");
  assert.throws(() => frames(directory), /frame-10000\.bgra/);
});
