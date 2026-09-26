// 번역 문장 대신 작업 ID·깊이·상태를 비교한다.
export function checklist(text, file, errors) {
  const entries = [], identifiers = new Set();
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    const match = line.match(/^(\s*)- \[([^\]]*)\] (.*)$/);
    if (!match) continue;
    const [, indent, state, label] = match;
    if (![" ", "~", "o", "!"].includes(state)) errors.push(`${file}:${index + 1}: invalid checklist state [${state}]`);
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

export function checkCompletedItems(previous, current, file) {
  const errors = [];
  const before = checklist(previous, file, []);
  const after = new Map(checklist(current, file, []).filter((entry) => entry.id).map((entry) => [entry.id, entry]));
  for (const entry of before) {
    if (entry.id && entry.state === "o" && after.get(entry.id)?.state !== "o") {
      errors.push(`${file}: completed checklist item ${entry.id} must remain complete; add a linked follow-up identifier`);
    }
  }
  return errors;
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
