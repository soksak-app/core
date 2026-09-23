import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { checkChangelogTranslations } from "../checklist.mjs";

const checker = fileURLToPath(new URL("../check-docs.mjs", import.meta.url));
const englishTable = "\n| Feature | Implementation | Validation | Release |\n| --- | --- | --- | --- |\n| Test | Source | Unverified | Unreleased |\n";
const koreanTable = "\n| 기능 | 구현 | 검증 | 배포 |\n| --- | --- | --- | --- |\n| 검사 | 소스 | 미검증 | 미배포 |\n";
function check(t, english, korean, previous = "") {
  const root = mkdtempSync(join(tmpdir(), "checklist-audit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(spawnSync("git", ["init", "-q", root]).status, 0);
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "docs/features.md"), previous + englishTable);
  writeFileSync(join(root, "docs/features.ko.md"), previous + koreanTable);
  assert.equal(spawnSync("git", ["add", "docs"], { cwd: root }).status, 0);
  assert.equal(spawnSync("git", ["-c", "user.name=Checklist fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture baseline"], { cwd: root }).status, 0);
  writeFileSync(join(root, "docs/features.md"), english + englishTable);
  writeFileSync(join(root, "docs/features.ko.md"), korean + koreanTable);
  const result = spawnSync(process.execPath, [checker], { cwd: root, encoding: "utf8", timeout: 2000 });
  assert.equal(result.error, undefined);
  return result;
}

test("checklist permits translated text and linked follow-up identifiers", { timeout: 3000 }, (t) => {
  const result = check(t, "- [o] G1 — done\n- [~] G1-1 — follow up\n", "- [o] G1 — 완료\n- [~] G1-1 — 후속\n");
  assert.equal(result.status, 0, result.stderr);
});

for (const updated of ["- [~] G1 — reopened\n", "- [~] G1-1 — replaced\n"]) {
  test(`checklist preserves completed scope: ${updated.trim()}`, { timeout: 3000 }, (t) => {
    const result = check(t, updated, updated, "- [o] G1 — completed\n");
    assert.notEqual(result.status, 0, "completed task was reopened or removed");
    assert.match(result.stderr, /completed checklist item G1/);
  });
}
for (const [name, english, korean, reason] of [
  ["duplicate IDs", "- [o] G1 — one\n- [ ] G1 — two\n", "- [o] G1 — 하나\n- [ ] G1 — 둘\n", "duplicate"],
  ["invalid states", "- [x] G1 — done\n", "- [x] G1 — 완료\n", "invalid checklist state"],
  ["different states", "- [o] G1 — done\n", "- [~] G1 — 작업\n", "checklist translations differ"],
  ["different ordering", "- [ ] G1 — first\n- [ ] G2 — second\n", "- [ ] G2 — 둘\n- [ ] G1 — 하나\n", "checklist translations differ"],
  ["different nested states", "- [~] G1 — first\n  - [o] nested\n", "- [~] G1 — 하나\n  - [ ] 하위\n", "checklist translations differ"],
  ["different nesting", "- [~] G1 — first\n  - [o] nested\n", "- [~] G1 — 하나\n- [o] 하위\n", "checklist translations differ"],
]) {
  test(`checklist rejects ${name}`, { timeout: 3000 }, (t) => {
    const result = check(t, english, korean);
    assert.notEqual(result.status, 0, "documentation audit accepted an invalid checklist");
    assert.match(result.stderr, new RegExp(reason));
  });
}

const englishLog = "# Changelog\n\n## Unreleased\n\n- F1-2: changed `a.js`.\n- Added `b`.\n\n## 2026-09-22\n\n- G3: done.\n";
const koreanLog = "# 변경 기록\n\n## 미배포\n\n- F1-2: `a.js`를 바꿨다.\n- `b`를 추가했다.\n\n## 2026-09-22\n\n- G3: 완료했다.\n";

test("changelog translations with the same sections, entries, identifiers, and code pass", () => {
  assert.deepEqual(checkChangelogTranslations(englishLog, koreanLog), []);
});

test("a missing, reordered, or altered changelog translation fails", () => {
  const missing = koreanLog.replace("- `b`를 추가했다.\n", "");
  assert.match(checkChangelogTranslations(englishLog, missing).join("\n"), /has 2 entries and its translation 1/);
  const reordered = koreanLog.replace("- F1-2: `a.js`를 바꿨다.\n- `b`를 추가했다.\n", "- `b`를 추가했다.\n- F1-2: `a.js`를 바꿨다.\n");
  assert.match(checkChangelogTranslations(englishLog, reordered).join("\n"), /entry 1 differs/);
  const altered = koreanLog.replace("`a.js`", "`a.ts`");
  assert.match(checkChangelogTranslations(englishLog, altered).join("\n"), /entry 1 differs/);
  const noSection = koreanLog.replace("## 2026-09-22\n\n", "");
  assert.match(checkChangelogTranslations(englishLog, noSection).join("\n"), /2 and 1 sections/);
  assert.match(checkChangelogTranslations("# Changelog\n\n- early\n", koreanLog).join("\n"), /entry before the first section heading/);
});
