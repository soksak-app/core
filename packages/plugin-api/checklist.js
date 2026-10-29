// Parses the canonical checklist of a repository: each `- [<state>] <label>` line, its identifier, depth and state, and the
// errors of the state records. The release gate, the record checks of every repository and the documentation checks of core
// read checklists through this module, so one grammar decides what an item and its identifier are.
/**
 * The identifier of a checklist label. An identifier is a letter prefix and a number followed by dot or hyphen segments of
 * letters and digits (F212.10-core-3-16, F238-c-11, F212.6a-1). A label that starts with one states it as `<identifier> — `:
 * `leading` is the identifier at the start of the label and `id` is it only when that form follows.
 */
export function itemIdentifier(label) {
  // default: a label that does not start with an identifier has none.
  const leading = label.match(/^([A-Z]+\d+[a-z]?(?:[.-][0-9A-Za-z]+)*)(?=[\s:(]|$)/)?.[1] ?? null;
  const id = leading && label.slice(leading.length).match(/^\s+—\s+/) ? leading : null;
  return { leading, id };
}

function unavailableEvidenceErrors(label, file, line, id, korean) {
  const prefix = korean ? "근거 복구 불가:" : "Evidence unavailable:";
  const fields = korean
    ? ["범위:", "근거:", "결과:", "후속 조건:"]
    : ["Scope:", "Evidence:", "Result:", "Follow-up when:"];
  const prefixMention = korean ? label.includes("근거 복구 불가:") : /Evidence unavailable:/i.test(label);
  if (!prefixMention) return null;

  const errors = [];
  // default: an item without an identifier is named by that fact in the error.
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
    const { leading, id } = itemIdentifier(label);
    if (leading && !id) errors.push(`${file}:${index + 1}: checklist item ${leading} must state its identifier as \`${leading} — \``);
    if (state === "!") {
      const korean = file.endsWith(".ko.md");
      const cause = korean ? /원인:\s*(.*?)\s+재시도 조건:/u : /Cause:\s*(.*?)\s+Retry when:/i;
      const retry = korean ? /재시도 조건:\s*(.+)$/u : /Retry when:\s*(.+)$/i;
      const causeValue = label.match(cause)?.[1]?.trim();
      const retryValue = label.match(retry)?.[1]?.trim();
      const hasContent = (value) => value && /[\p{L}\p{N}]/u.test(value);
      const missing = [!hasContent(causeValue) && (korean ? "원인" : "cause"), !hasContent(retryValue) && (korean ? "재시도 조건" : "retry condition")].filter(Boolean);
      // default: an item without an identifier is named by that fact in the error.
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
          // default: an item without an identifier is named by that fact in the error.
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
