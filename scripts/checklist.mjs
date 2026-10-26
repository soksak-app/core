// Compares task ID, depth, and state instead of translated sentences.
function unavailableEvidenceErrors(label, file, line, id, korean) {
  const prefix = korean ? "근거 복구 불가:" : "Evidence unavailable:";
  const fields = korean
    ? ["범위:", "근거:", "결과:", "후속 조건:"]
    : ["Scope:", "Evidence:", "Result:", "Follow-up when:"];
  const prefixMention = korean ? label.includes("근거 복구 불가:") : /Evidence unavailable:/i.test(label);
  if (!prefixMention) return null;

  const errors = [];
  const item = id ?? "without an identifier";
  const prefixAt = label.indexOf(prefix);
  if (prefixAt < 0 || label.split(prefix).length !== 2) {
    errors.push(`${file}:${line}: closed checklist item ${item} requires one canonical ${prefix.trim()} prefix`);
    return errors;
  }

  const body = label.slice(prefixAt + prefix.length).trimStart();
  const occurrences = fields.map((field) => body.split(field).length - 1);
  for (let index = 0; index < fields.length; index++) {
    if (occurrences[index] === 0) {
      errors.push(`${file}:${line}: closed checklist item ${item} requires a nonempty ${fields[index]} field`);
    } else if (occurrences[index] > 1) {
      errors.push(`${file}:${line}: closed checklist item ${item} repeats ${fields[index]} field`);
    }
  }
  const positions = fields.map((field) => body.indexOf(field));
  const present = positions.map((position, index) => ({ position, index })).filter(({ position }) => position >= 0);
  const ordered = present.every((entry, index) => entry.index === index && (index === 0
    ? entry.position === 0 : entry.position > present[index - 1].position));
  if (!ordered) {
    errors.push(`${file}:${line}: closed checklist item ${item} requires fields in canonical order ${fields.join(" ")}`);
  }
  if (errors.length) return errors;

  const values = fields.map((field, index) => body.slice(positions[index] + field.length,
    index + 1 < fields.length ? positions[index + 1] : body.length).trim());
  for (let index = 0; index < values.length; index++) {
    if (!/[\p{L}\p{N}]/u.test(values[index])) {
      errors.push(`${file}:${line}: closed checklist item ${item} requires nonempty ${fields[index]} field`);
    }
  }
  const result = values[2];
  const explicitlyUnverified = korean ? result.startsWith("미검증") : /^Unverified(?:\b|:)/u.test(result);
  if (!explicitlyUnverified) {
    errors.push(`${file}:${line}: closed checklist item ${item} requires Result: to begin with ${korean ? "미검증" : "Unverified"}`);
  }
  const passingResult = korean ? /(?:검증 완료|검증됨|검증되었|통과|성공)/u.test(result)
    : /\b(?:verified|pass(?:ed|es|ing)?)\b/iu.test(result);
  if (passingResult) {
    errors.push(`${file}:${line}: closed checklist item ${item} cannot state a verified or passing Result:`);
  }
  return errors;
}

export function checklist(text, file, errors) {
  const entries = [], identifiers = new Map();
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    const match = line.match(/^(\s*)- \[([^\]]*)\] (.*)$/);
    if (!match) continue;
    const [, indent, state, label] = match;
    if (![" ", "~", "o", "!", "-"].includes(state)) errors.push(`${file}:${index + 1}: invalid checklist state [${state}]`);
    const id = label.match(/^([A-Z]\d+(?:[.-]\d+[a-z]?)*)\s+—\s+/)?.[1] ?? null;
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
    // [-] records non-reproduction, an authorized unavailable-evidence audit, or a scoped Windows/Linux exclusion.
    if (state === "-") {
      const korean = file.endsWith(".ko.md");
      const unavailable = unavailableEvidenceErrors(label, file, index + 1, id, korean);
      if (unavailable !== null) {
        errors.push(...unavailable);
      } else {
        const record = (korean ? /재현되지 않음:\s*(.+)$/u : /Not reproduced:\s*(.+)$/i).exec(label)?.[1]?.trim();
        const hasAttemptRecord = record && /[\p{L}\p{N}]/u.test(record);
        const scopeRecord = (korean ? /플랫폼 범위 제외:\s*(.+)$/u : /Platform excluded:\s*(.+)$/i).exec(label)?.[1]?.trim();
        const hasScopedPlatformRecord = scopeRecord
          && /\b(?:Windows|Linux)\b/i.test(scopeRecord)
          && (korean
            ? /(?:환경이 없|구현되지 않|사용할 수 없|실행할 수 없)/u.test(scopeRecord) && /(?:미검증|검증되지 않)/u.test(scopeRecord)
            : /(?:unavailable|not implemented|not available)/i.test(scopeRecord) && /(?:unverified|not verified)/i.test(scopeRecord));
        if (!hasAttemptRecord && !hasScopedPlatformRecord) {
          errors.push(`${file}:${index + 1}: closed checklist item ${id ?? "without an identifier"} requires either a nonempty ${korean ? "재현되지 않음" : "Not reproduced"} record or a complete ${korean ? "플랫폼 범위 제외" : "Platform excluded"} record`);
        }
      }
    }
    // An identifier that two lines state is refused whatever its form, with the line of its first statement.
    if (id && identifiers.has(id)) errors.push(`${file}:${index + 1}: duplicate checklist identifier ${id} (first stated on line ${identifiers.get(id)})`);
    if (id && !identifiers.has(id)) identifiers.set(id, index + 1);
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

// Checks that the changelog and its translation hold the same information in the same order: the number of section headings, the number of items per section, and, at each position, the
// task IDs and code spans that are not translated must be the same.
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

// A specification states the current contract only. A checklist ID (a prefix and a numeric suffix, like V5-106 or G1.4-14-3) is a progress record, so it is not written in a specification.
const CHECKLIST_ID = /\b(?:[A-Z]\d+(?:\.\d+)*)(?:-\d+)+\b/g;

/** Returns one error for each checklist ID written in the text of a specification. */
export function checkSpecificationIds(text, file) {
  const errors = [];
  text.split("\n").forEach((line, index) => {
    for (const match of line.matchAll(CHECKLIST_ID)) errors.push(`${file}:${index + 1}: specification cites checklist ID ${match[0]}`);
  });
  return errors;
}
