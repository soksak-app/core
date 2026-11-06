// Compares task ID, depth, and state instead of translated sentences.
import { spawnSync } from "node:child_process";
import { checklist } from "@soksak/kit/checklist";

export function checklistCounts(text, file = "docs/features.md") {
  const errors = [];
  const entries = checklist(text, file, errors);
  if (errors.length) throw new Error(errors.join("\n"));
  const counts = { waiting: 0, active: 0, complete: 0, held: 0, closed: 0, total: entries.length };
  const names = { " ": "waiting", "~": "active", o: "complete", "!": "held", "-": "closed" };
  for (const { state } of entries) counts[names[state]]++;
  return counts;
}

// These are guards on retained historical records, not product behavior tests.
// A checklist without the corresponding record has no obligation to add it.
export function auditHistoricalScopeWording(source, file = "docs/features.md") {
  const forbidden = file.endsWith(".ko.md") ? [
    "통제 사이트 pixel과 복원/신규 문서 검증은 F3에서 미완료로 남아 있다.",
    "통제 사이트 픽셀과 복원/신규 문서 검증은 F3에서 미완료로 남아 있다.",
  ] : [
    "Controlled-site pixel and restored/new-document application checks remain open under F3.",
    "Controlled-site pixels and restored/new-document validation remain open under F3.",
  ];
  return forbidden.filter((phrase) => source.includes(phrase)).map((phrase) => `${file}: F3 scope is reported as currently open: ${phrase}`);
}

export function auditModalParitySnapshotWording(source, file = "docs/features.md") {
  if (!/^\s*- \[[^\]]+\] F10\.2 —/m.test(source)) return [];
  const korean = file.endsWith(".ko.md");
  const marker = korean ? "2026-09-21 parity 감사 스냅샷 시점" : "At the 2026-09-21 audit snapshot";
  const correction = korean ? "이후 F10.2 수정이 Wails 자식 WebView 계약을" : "The later F10.2 correction creates the Wails child-WebView contract";
  const line = source.split("\n").find((entry) => entry.includes(marker));
  if (!line) return [`${file}: modal parity observation is not explicitly dated as a historical snapshot`];
  if (!line.includes(correction)) return [`${file}: modal parity observation does not state the current F10.2 correction`];
  return [];
}

export function auditCommittedEvidenceWording(source, file = "docs/features.md") {
  const line = source.split("\n").find((entry) => /^\s*- \[[^\]]+\] F0\.1 —/.test(entry));
  if (!line) return [];
  const korean = file.endsWith(".ko.md");
  if (line.includes(korean ? "현재 미커밋 구현" : "current dirty implementation")) {
    return [`${file}: F0.1 evidence still claims a current dirty implementation`];
  }
  if (!line.includes(korean ? "이 F0.1 변경" : "this F0.1 change")) {
    return [`${file}: F0.1 evidence does not identify its build by its checklist ID`];
  }
  return [];
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

/**
 * The errors of the conflict markers that a merge left at the start of a line of a tracked or new text file under the current folder. The
 * separator line is not one, because a Markdown heading has that form. git grep answers 1 when it finds nothing.
 */
export function conflictMarkerErrors() {
  const found = spawnSync("git", ["grep", "--untracked", "-n", "-I", "-E", "^(<{7}|>{7}) "], { encoding: "utf8", maxBuffer: 1 << 24 });
  if (found.status !== 0 && found.status !== 1) throw new Error(`git grep failed with status ${found.status}: ${found.stderr}`);
  return found.stdout.split("\n").filter(Boolean).map((line) => `${line.split(":", 2).join(":")}: a conflict marker`);
}
