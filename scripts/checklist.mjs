// 번역 문장 대신 작업 ID·깊이·상태를 비교한다.
export function checklist(text, file, errors) {
  const entries = [], identifiers = new Set();
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    const match = line.match(/^(\s*)- \[([^\]]*)\] (.*)$/);
    if (!match) continue;
    const [, indent, state, label] = match;
    if (![" ", "~", "o"].includes(state)) errors.push(`${file}:${index + 1}: invalid checklist state [${state}]`);
    const id = label.match(/^([A-Z]\d+(?:\.\d+)*(?:-\d+)*)\s+—\s+/)?.[1] ?? null;
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
