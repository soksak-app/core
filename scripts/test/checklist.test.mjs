import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { checkChangelogTranslations, checkSpecificationIds, retiredChecklistItems } from "../checklist.mjs";

const checker = fileURLToPath(new URL("../check-docs.mjs", import.meta.url));
const englishTable = "\n| Feature | Implementation | Validation | Release |\n| --- | --- | --- | --- |\n| Test | Source | Unverified | Unreleased |\n";
const koreanTable = "\n| 기능 | 구현 | 검증 | 배포 |\n| --- | --- | --- | --- |\n| 검사 | 소스 | 미검증 | 미배포 |\n";
function check(t, english, korean, previous = "", retirement, files = {}) {
  const root = mkdtempSync(join(tmpdir(), "checklist-audit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(spawnSync("git", ["init", "-q", root]).status, 0);
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "docs/features.md"), previous + englishTable);
  writeFileSync(join(root, "docs/features.ko.md"), previous + koreanTable);
  if (retirement) {
    writeFileSync(join(root, "CHANGELOG.md"), `# Changelog\n\n## Unreleased\n\n${retirement.english}\n`);
    writeFileSync(join(root, "CHANGELOG.ko.md"), `# 변경 기록\n\n## 미배포\n\n${retirement.korean}\n`);
  }
  assert.equal(spawnSync("git", ["add", "docs"], { cwd: root }).status, 0);
  assert.equal(spawnSync("git", ["-c", "user.name=Checklist fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture baseline"], { cwd: root }).status, 0);
  writeFileSync(join(root, "docs/features.md"), english + englishTable);
  writeFileSync(join(root, "docs/features.ko.md"), korean + koreanTable);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const result = spawnSync(process.execPath, [checker], { cwd: root, encoding: "utf8", timeout: 2000 });
  assert.equal(result.error, undefined);
  return result;
}

test("checklist permits translated text and linked follow-up identifiers", { timeout: 3000 }, (t) => {
  const result = check(t, "- [o] G1 — done\n- [~] G1-1 — follow up\n", "- [o] G1 — 완료\n- [~] G1-1 — 후속\n");
  assert.equal(result.status, 0, result.stderr);
});

test("checklist permits retiring a completed entry when paired changelogs record why it was misclassified", { timeout: 3000 }, (t) => {
  const retirement = {
    english: "- Retired checklist entry `G1`: it recorded an agent work rule, not project work.",
    korean: "- 체크리스트 항목 `G1` 폐기: 프로젝트 작업이 아니라 에이전트 업무 규칙을 기록한 항목이었다.",
  };
  const previous = "- [o] G1 — procedural rule\n";
  const result = check(t, "- [~] G2 — task\n", "- [~] G2 — 작업\n", previous, retirement);
  assert.equal(result.status, 0, result.stderr);
});

test("completed checklist items cannot be removed without a paired retirement record", { timeout: 3000 }, (t) => {
  const result = check(t, "- [~] G2 — task\n", "- [~] G2 — 작업\n", "- [o] G1 — completed\n");
  assert.notEqual(result.status, 0, "documentation audit accepted an undocumented removal");
  assert.match(result.stderr, /completed checklist item G1 must remain complete/);
});

test("retirement records require a reason and the same IDs in both translations", () => {
  const noReason = retiredChecklistItems("- Retired checklist entry `G1`:\n", "- 체크리스트 항목 `G1` 폐기:\n");
  assert.match(noReason.errors.join("\n"), /requires a reason/);
  const mismatch = retiredChecklistItems("- Retired checklist entry `G1`: mistaken entry.\n", "- 체크리스트 항목 `G2` 폐기: 잘못된 항목.\n");
  assert.match(mismatch.errors.join("\n"), /entries differ between changelog translations/);
});

test("checklist permits an explicitly blocked item with a cause and retry condition", { timeout: 3000 }, (t) => {
  const english = "- [!] G1 — blocked. Cause: the process is active. Retry when: the process exits.\n";
  const korean = "- [!] G1 — 보류. 원인: 프로세스가 실행 중이다. 재시도 조건: 프로세스가 종료된다.\n";
  const result = check(t, english, korean);
  assert.equal(result.status, 0, result.stderr);
});

for (const [name, english, korean] of [
  ["missing cause", "- [!] G1 — blocked. Retry when: available.\n", "- [!] G1 — 보류. 원인: 이유. 재시도 조건: 가능할 때.\n"],
  ["empty cause", "- [!] G1 — blocked. Cause: . Retry when: available.\n", "- [!] G1 — 보류. 원인: 이유. 재시도 조건: 가능할 때.\n"],
  ["missing retry condition", "- [!] G1 — blocked. Cause: unavailable.\n", "- [!] G1 — 보류. 원인: 이유. 재시도 조건: 가능할 때.\n"],
  ["empty retry condition", "- [!] G1 — blocked. Cause: unavailable. Retry when: .\n", "- [!] G1 — 보류. 원인: 이유. 재시도 조건: 가능할 때.\n"],
]) {
  test(`checklist rejects [!] with ${name}`, { timeout: 3000 }, (t) => {
    const result = check(t, english, korean);
    assert.notEqual(result.status, 0, "documentation audit accepted an incomplete blocked record");
    assert.match(result.stderr, /blocked checklist item .* requires/);
  });
}

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

test("the documentation audit rejects a specification that cites a checklist ID", { timeout: 3000 }, (t) => {
  const result = check(t, "- [~] G1 — task\n", "- [~] G1 — 작업\n", "", undefined, {
    "docs/spec/fixture.md": "# Contract\n\n[한국어](fixture.ko.md)\n\nThe service reconnects at once (V5-106).\n",
    "docs/spec/fixture.ko.md": "# 계약\n\n[English](fixture.md)\n\n서비스는 즉시 다시 연결한다(V5-106).\n",
  });
  assert.notEqual(result.status, 0, "documentation audit accepted a checklist ID in a specification");
  assert.match(result.stderr, /docs\/spec\/fixture\.md:5: specification cites checklist ID V5-106/);
});

test("a specification that cites a checklist ID is rejected", () => {
  const text = "# Contract\n\nThe service reconnects at once (V5-106).\nNested work is tracked in V5-117-1-3 and G1.4-14-3.\nA plain contract line.\n";
  assert.deepEqual(checkSpecificationIds(text, "docs/spec/fixture.md"), [
    "docs/spec/fixture.md:3: specification cites checklist ID V5-106",
    "docs/spec/fixture.md:4: specification cites checklist ID V5-117-1-3",
    "docs/spec/fixture.md:4: specification cites checklist ID G1.4-14-3",
  ]);
  assert.deepEqual(checkSpecificationIds("Version 1.2-beta and UTF-8 text.\n", "docs/spec/fixture.md"), []);
});
