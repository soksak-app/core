// The shared cases of the colors of a group card (docs/spec/cases/group-look.json, docs/spec/groups.md#drawing). Palette GroupLook of
// packages/workbench-mygo runs the same file, so a case is one statement of the drawing that both workbenches meet.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { groupLook } from "../group-look.js";

const cases = JSON.parse(readFileSync(new URL("../../../docs/spec/cases/group-look.json", import.meta.url), "utf8")).cases;

for (const kase of cases) {
  test(`group look: ${kase.name}`, { timeout: 5000 }, () => {
    assert.deepEqual(groupLook(kase.tokens, kase.level, { seam: kase.seam, fade: kase.fade }), kase.returns);
  });
}
