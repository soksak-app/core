import assert from "node:assert/strict";
import test from "node:test";
import { declaredVersion, holdingItems, releaseDecision } from "../release-gate.js";

const decision = (checklistText, tags = []) => releaseDecision({
  manifestName: "package.json", manifestText: '{ "version": "0.0.3" }',
  checklistName: "docs/features.md", checklistText, tagExists: (tag) => tags.includes(tag),
});

test("a repository releases its declared version when the remote has no tag of it and no checklist item is open", () => {
  assert.deepEqual(decision("- [o] F1 — P0: done\n- [-] F2 — P1: Not reproduced: three runs\n"), { release: true, version: "0.0.3", reasons: [] });
});

test("a tag of the declared version holds the release", () => {
  assert.deepEqual(decision("- [o] F1 — P0: done\n", ["v0.0.3"]), { release: false, version: "0.0.3", reasons: ["the tag v0.0.3 exists"] });
});

test("an item that is waiting, active or bypassed holds the release", () => {
  const text = "- [ ] F1 — P0: a\n- [~] F2 — P0: b\n  - [!] F2-1 — P1: c. Cause: no runner. Retry when: a runner exists\n";
  assert.deepEqual(decision(text).reasons, ["3 open items: F1 [ ], F2 [~], F2-1 [!]"]);
});

test("an open item without an identifier and a checklist error are errors, not a release", () => {
  assert.throws(() => holdingItems("docs/features.md", "- [ ] write the guide\n"), /docs\/features\.md: 1 open checklist items have no identifier/);
  assert.throws(() => holdingItems("docs/features.md", "- [x] F1 — P0: a\n"), /invalid checklist state \[x\]/);
});

test("a manifest without a version of three numbers is an error that names the file and what it found", () => {
  assert.throws(() => declaredVersion("package.json", '{ "version": "1.0" }'), /package\.json: version must be .*found "1\.0"/);
  assert.throws(() => declaredVersion("package.json", "{"), /package\.json: not JSON/);
});
