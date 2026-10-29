import assert from "node:assert/strict";
import test from "node:test";
import { checklist, itemIdentifier } from "../checklist.js";

test("an identifier is a letter prefix and a number with dot or hyphen segments, stated as `<identifier> — `", () => {
  assert.deepEqual(itemIdentifier("F238-c-11 — P1: text"), { leading: "F238-c-11", id: "F238-c-11" });
  assert.deepEqual(itemIdentifier("F7-1: P1: colon form"), { leading: "F7-1", id: null });
  assert.deepEqual(itemIdentifier("E2E measurement restoration: text"), { leading: null, id: null });
});

test("a checklist identifier that two lines of one file state is refused with both lines, in any identifier form", () => {
  const errors = [];
  checklist("- [o] F218-2.4 — P2: first\n- [ ] F218-2.4 — P2: second\n", "docs/features.md", errors);
  assert.deepEqual(errors, ["docs/features.md:2: duplicate checklist identifier F218-2.4 (first stated on line 1)"]);
  const plain = [];
  checklist("- [o] F9-1 — P2: first\n- [ ] F9-1 — P2: second\n", "docs/features.md", plain);
  assert.deepEqual(plain, ["docs/features.md:2: duplicate checklist identifier F9-1 (first stated on line 1)"]);
  for (const id of ["F212.10-core-3-16", "F238-c-11", "F212.6a-1", "F212.12-1-10-6g", "F212.10-hwp-2"]) {
    const named = [];
    checklist(`- [o] ${id} — P2: first\n- [ ] ${id} — P2: second\n`, "docs/features.md", named);
    assert.deepEqual(named, [`docs/features.md:2: duplicate checklist identifier ${id} (first stated on line 1)`]);
  }
});

test("a checklist item whose label starts with an identifier states it as `<identifier> — `", () => {
  const errors = [];
  checklist("- [o] F212.12-2-2-4-8-2-3 (owner: core): P1: second form\n- [o] F7-1: P1: colon form\n- [o] E2E measurement restoration: text\n",
    "docs/features.md", errors);
  assert.deepEqual(errors, [
    "docs/features.md:1: checklist item F212.12-2-2-4-8-2-3 must state its identifier as `F212.12-2-2-4-8-2-3 — `",
    "docs/features.md:2: checklist item F7-1 must state its identifier as `F7-1 — `",
  ]);
});

test("unavailable-evidence records require every nonempty canonical field in both languages", { timeout: 1000 }, () => {
  const cases = [
    { name: "Scope", en: ["Evidence: logs", "Result: Unverified because the original run is absent", "Follow-up when: the run is recovered"],
      ko: ["근거: 로그", "결과: 미검증, 최초 실행이 없다", "후속 조건: 실행을 복구할 때"] },
    { name: "Evidence", en: ["Scope: old assertion", "Result: Unverified because the original run is absent", "Follow-up when: the run is recovered"],
      ko: ["범위: 과거 assertion", "결과: 미검증, 최초 실행이 없다", "후속 조건: 실행을 복구할 때"] },
    { name: "Result", en: ["Scope: old assertion", "Evidence: logs", "Follow-up when: the run is recovered"],
      ko: ["범위: 과거 assertion", "근거: 로그", "후속 조건: 실행을 복구할 때"] },
    { name: "Follow-up when", en: ["Scope: old assertion", "Evidence: logs", "Result: Unverified because the original run is absent"],
      ko: ["범위: 과거 assertion", "근거: 로그", "결과: 미검증, 최초 실행이 없다"] },
    { name: "Scope", en: ["Scope:", "Evidence: logs", "Result: Unverified because the original run is absent", "Follow-up when: the run is recovered"],
      ko: ["범위:", "근거: 로그", "결과: 미검증, 최초 실행이 없다", "후속 조건: 실행을 복구할 때"] },
    { name: "Evidence", en: ["Scope: old assertion", "Evidence:", "Result: Unverified because the original run is absent", "Follow-up when: the run is recovered"],
      ko: ["범위: 과거 assertion", "근거:", "결과: 미검증, 최초 실행이 없다", "후속 조건: 실행을 복구할 때"] },
    { name: "Result", en: ["Scope: old assertion", "Evidence: logs", "Result:", "Follow-up when: the run is recovered"],
      ko: ["범위: 과거 assertion", "근거: 로그", "결과:", "후속 조건: 실행을 복구할 때"] },
    { name: "Follow-up when", en: ["Scope: old assertion", "Evidence: logs", "Result: Unverified because the original run is absent", "Follow-up when:"],
      ko: ["범위: 과거 assertion", "근거: 로그", "결과: 미검증, 최초 실행이 없다", "후속 조건:"] },
  ];
  for (const entry of cases) {
    const enFields = entry.en.join(" ");
    const enErrors = [];
    checklist(`- [-] G1 — Evidence unavailable: ${enFields}\n`, "docs/features.md", enErrors);
    assert.match(enErrors.join("\n"), new RegExp(`requires (?:a )?nonempty ${entry.name}:? field`),
      `English ${entry.name} omission or empty value was accepted`);

    const koFields = entry.ko.join(" ");
    const koErrors = [];
    checklist(`- [-] G1 — 근거 복구 불가: ${koFields}\n`, "docs/features.ko.md", koErrors);
    const koName = { Scope: "범위", Evidence: "근거", Result: "결과", "Follow-up when": "후속 조건" }[entry.name];
    assert.match(koErrors.join("\n"), new RegExp(`requires (?:a )?nonempty ${koName}:? field`),
      `Korean ${koName} omission or empty value was accepted`);
  }
});

test("unavailable-evidence records reject verified results and noncanonical field order", { timeout: 1000 }, () => {
  for (const [file, line, message] of [
    ["docs/features.md", "- [-] G1 — Evidence unavailable: Scope: assertion Evidence: retained logs Result: Verified Follow-up when: source recovery\n", /begin with Unverified/],
    ["docs/features.md", "- [-] G1 — Evidence unavailable: Scope: assertion Evidence: retained logs Result: not unverified Follow-up when: source recovery\n", /begin with Unverified/],
    ["docs/features.md", "- [-] G1 — Evidence unavailable: Scope: assertion Evidence: retained logs Result: Unverified, comparison passed Follow-up when: source recovery\n", /cannot state a verified or passing Result/],
    ["docs/features.md", "- [-] G1 — Evidence unavailable: Evidence: retained logs Scope: assertion Result: Unverified Follow-up when: source recovery\n", /canonical order/],
    ["docs/features.md", "- [-] G1 — Evidence unavailable: Scope: assertion Scope: duplicate Evidence: retained logs Result: Unverified Follow-up when: source recovery\n", /repeats Scope: field/],
    ["docs/features.ko.md", "- [-] G1 — 근거 복구 불가: 범위: assertion 근거: logs 결과: 검증 완료 후속 조건: 복구\n", /begin with 미검증/],
    ["docs/features.ko.md", "- [-] G1 — 근거 복구 불가: 범위: assertion 근거: logs 결과: 미검증, 비교 통과 후속 조건: 복구\n", /cannot state a verified or passing Result/],
    ["docs/features.ko.md", "- [-] G1 — 근거 복구 불가: 근거: logs 범위: assertion 결과: 미검증 후속 조건: 복구\n", /canonical order/],
  ]) {
    const errors = [];
    checklist(line, file, errors);
    assert.match(errors.join("\n"), message, `invalid record was accepted: ${line}`);
  }
});
