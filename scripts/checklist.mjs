// 번역 문장 대신 작업 ID·깊이·상태를 비교한다.
export function checklist(text, file, errors) {
  const entries = [], identifiers = new Set();
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    const match = line.match(/^(\s*)- \[([^\]]*)\] (.*)$/);
    if (!match) continue;
    const [, indent, state, label] = match;
    if (![" ", "~", "o", "!", "-"].includes(state)) errors.push(`${file}:${index + 1}: invalid checklist state [${state}]`);
    const id = label.match(/^([A-Z]\d+(?:\.\d+)*(?:-\d+)*)\s+—\s+/)?.[1] ?? null;
    if (state === "!") {
      const korean = file.endsWith(".ko.md");
      const cause = korean ? /원인:\s*(.*?)\s+재시도 조건:/u : /Cause:\s*(.*?)\s+Retry when:/i;
      const retry = korean ? /재시도 조건:\s*(.+)$/u : /Retry when:\s*(.+)$/i;
      const causeValue = label.match(cause)?.[1]?.trim();
      const retryValue = label.match(retry)?.[1]?.trim();
      const hasContent = (value) => value && /[\p{L}\p{N}]/u.test(value);
      const missing = [!hasContent(causeValue) && (korean ? "원인" : "cause"), !hasContent(retryValue) && (korean ? "재시도 조건" : "retry condition")].filter(Boolean);
      if (missing.length) errors.push(`${file}:${index + 1}: blocked checklist item ${id ?? "without an identifier"} requires nonempty ${missing.join(" and ")}`);
    }
    // [-] 는 재현하지 못해 닫은 항목이다. 닫기 전에 시도한 내용을 기록한다.
    if (state === "-") {
      const korean = file.endsWith(".ko.md");
      const record = (korean ? /재현되지 않음:\s*(.+)$/u : /Not reproduced:\s*(.+)$/i).exec(label)?.[1]?.trim();
      if (!record || !/[\p{L}\p{N}]/u.test(record)) {
        errors.push(`${file}:${index + 1}: not reproduced checklist item ${id ?? "without an identifier"} requires a nonempty ${korean ? "재현되지 않음" : "Not reproduced"} record`);
      }
    }
    if (id && identifiers.has(id)) errors.push(`${file}:${index + 1}: duplicate checklist identifier ${id}`);
    if (id) identifiers.add(id);
    entries.push({ id, indent: indent.length, state });
  }
  return entries;
}

export function checkChecklistTranslations(english, korean) {
  const errors = [];
  const first = checklist(english, "docs/features.md", errors);
  const second = checklist(korean, "docs/features.ko.md", errors);
  if (!first.length || !second.length) errors.push("canonical feature checklist is missing");
  if (JSON.stringify(first) !== JSON.stringify(second)) errors.push("checklist translations differ in identifiers, ordering, nesting, or state");
  return errors;
}

export function checkCompletedItems(previous, current, file, retiredIds = new Set()) {
  const errors = [];
  const before = checklist(previous, file, []);
  const after = new Map(checklist(current, file, []).filter((entry) => entry.id).map((entry) => [entry.id, entry]));
  for (const entry of before) {
    if (entry.id && entry.state === "o" && after.get(entry.id)?.state !== "o" && !retiredIds.has(entry.id)) {
      errors.push(`${file}: completed checklist item ${entry.id} must remain complete; add a linked follow-up identifier`);
    }
    if (entry.id && entry.state === "-" && after.get(entry.id)?.state !== "-" && !retiredIds.has(entry.id)) {
      errors.push(`${file}: closed checklist item ${entry.id} must remain closed; add a linked follow-up identifier`);
    }
  }
  return errors;
}

export function retiredChecklistItems(english, korean) {
  const parse = (text, pattern, file) => {
    const entries = new Map();
    const errors = [];
    for (const match of text.matchAll(pattern)) {
      const [, id, reason] = match;
      if (!reason.trim()) errors.push(`${file}: retired checklist entry ${id} requires a reason`);
      if (entries.has(id)) errors.push(`${file}: duplicate retired checklist entry ${id}`);
      entries.set(id, reason.trim());
    }
    return { entries, errors };
  };
  const en = parse(english, /^- Retired checklist entry `([A-Z]\d+(?:\.\d+)*(?:-\d+)*)`:(.*)$/gm, "CHANGELOG.md");
  const ko = parse(korean, /^- 체크리스트 항목 `([A-Z]\d+(?:\.\d+)*(?:-\d+)*)` 폐기:(.*)$/gm, "CHANGELOG.ko.md");
  const errors = [...en.errors, ...ko.errors];
  const enIds = [...en.entries.keys()].sort();
  const koIds = [...ko.entries.keys()].sort();
  if (JSON.stringify(enIds) !== JSON.stringify(koIds)) errors.push("retired checklist entries differ between changelog translations");
  return { ids: new Set(errors.length ? [] : enIds), errors };
}

// 변경 기록과 번역이 같은 정보를 같은 순서로 담는지 검사한다. 구역 제목의 수, 구역별 항목 수, 그리고 위치마다
// 번역하지 않는 작업 ID와 코드 조각이 같아야 한다.
export function checkChangelogTranslations(english, korean) {
  const sections = (text) => {
    const result = [];
    for (const line of text.split("\n")) {
      if (line.startsWith("## ")) result.push({ heading: line, entries: [] });
      else if (line.startsWith("- ")) {
        if (result.length === 0) return { error: "changelog entry before the first section heading", result };
        result.at(-1).entries.push(line);
      }
    }
    return { result };
  };
  const invariant = (line) => JSON.stringify([
    [...new Set([...line.matchAll(/\b[FGV]\d+(?:[.\u2013-]\d+)*\b/g)].map((match) => match[0].replace("\u2013", "-")))].sort(),
    [...new Set([...line.matchAll(/`([^`]+)`/g)].map((match) => match[1]))].sort(),
  ]);
  const en = sections(english), ko = sections(korean);
  const errors = [];
  if (en.error) errors.push(`CHANGELOG.md: ${en.error}`);
  if (ko.error) errors.push(`CHANGELOG.ko.md: ${ko.error}`);
  if (errors.length) return errors;
  if (en.result.length !== ko.result.length) return [`changelog translations have ${en.result.length} and ${ko.result.length} sections`];
  en.result.forEach((section, index) => {
    const other = ko.result[index];
    if (section.entries.length !== other.entries.length) {
      errors.push(`changelog section ${index + 1} (${section.heading}) has ${section.entries.length} entries and its translation ${other.entries.length}`);
      return;
    }
    section.entries.forEach((entry, position) => {
      if (invariant(entry) !== invariant(other.entries[position])) {
        errors.push(`changelog section ${index + 1} entry ${position + 1} differs from its translation in task identifiers or code: ${entry.slice(0, 80)}`);
      }
    });
  });
  return errors;
}

// 명세는 현재 계약만 적는다. 체크리스트 ID(V5-106, G1.4-14-3 처럼 접두사와 숫자 접미사)는 진행 기록이므로 명세에 쓰지 않는다.
const CHECKLIST_ID = /\b(?:[A-Z]\d+(?:\.\d+)*)(?:-\d+)+\b/g;

/** 명세 text 에 적힌 체크리스트 ID 마다 오류 하나를 반환한다. */
export function checkSpecificationIds(text, file) {
  const errors = [];
  text.split("\n").forEach((line, index) => {
    for (const match of line.matchAll(CHECKLIST_ID)) errors.push(`${file}:${index + 1}: specification cites checklist ID ${match[0]}`);
  });
  return errors;
}
