// Compares task ID, depth, and state instead of translated sentences.
import { checklist } from "../packages/plugin-api/checklist.js";

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
    // An open item leaves the checklist only through a recorded state or a retirement record, so no work disappears unrecorded.
    if (entry.id && [" ", "~", "!"].includes(entry.state) && !after.has(entry.id) && !retiredIds.has(entry.id)) {
      errors.push(`${file}: open checklist item ${entry.id} was removed; record its completion or closure, or retire it`);
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
