#!/usr/bin/env node
// Checks that records state only facts about the repository. Documents are checked on every line outside code blocks, and configuration files (workflow, Makefile) only on comment lines,
// and violations are reported as `path:line`. Each repository checks its own records with this command.
//
//   soksak-records [repository]
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The rejected synonyms of terms.json, each with the term to use, the names that may hold it, such as names of external
 * libraries, and a pattern that also matches it in identifiers.
 */
export const REJECTED_TERMS = JSON.parse(readFileSync(new URL("./terms.json", import.meta.url), "utf8")).terms
  .flatMap(({ term, rejected, allowed }) => rejected.map((word) => ({
    word,
    term,
    allowed,
    pattern: new RegExp(`(?<![A-Za-z0-9])${word.split(/[\s-]+/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\s_-]?")}s?(?![A-Za-z0-9]|\\.json)`, "gi"),
    // The same words joined with capital initials inside an identifier.
    camel: new RegExp(`(?<=[a-z0-9])${word.split(/[\s-]+/).map((part) => part[0].toUpperCase() + part.slice(1)).join("")}s?(?![a-z])`, "g"),
  })));

/**
 * Lines of text that use a rejected synonym, as `file:line: rejected term "<word>", use "<term>": <match>`. A synonym
 * also matches in its plural; one followed by `.json` names a file such as package.json and is not a use.
 */
export function termViolations(text, file) {
  const errors = [];
  text.split("\n").forEach((line, index) => {
    const found = REJECTED_TERMS.flatMap(({ word, term, allowed, pattern, camel }) => {
      // An allowed name, such as the name of an external library, holds the word without using it.
      const spans = allowed.flatMap((name) => [...line.matchAll(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))]
        .map((match) => [match.index, match.index + name.length]));
      return [...line.matchAll(pattern), ...line.matchAll(camel)]
        .filter((match) => !spans.some(([start, end]) => match.index >= start && match.index < end))
        .map((match) => ({ word, term, text: match[0], start: match.index, end: match.index + match[0].length }));
    });
    // A match inside a longer match of another rejected synonym is the same use, so only the longer one is reported.
    for (const item of found) {
      if (found.some((other) => other !== item && other.start <= item.start && other.end >= item.end && other.end - other.start > item.end - item.start)) continue;
      errors.push(`${file}:${index + 1}: rejected term "${item.word}", use "${item.term}": ${item.text}`);
    }
  });
  return errors;
}

/**
 * Whether a file is checked for rejected terms: every tracked text file of these kinds except the term list, the
 * tests of this check, whose fixtures hold rejected synonyms, and the changelogs and checklists, which record earlier
 * changes in the words of their time.
 */
export function termChecked(file) {
  if (/(?:^|\/)terms\.json$/.test(file) || /(?:^|\/)records-check\.test\.mjs$/.test(file) || /(?:^|\/)CHANGELOG(?:\.[a-z]+)?\.md$/.test(file) || /(?:^|\/)features(?:\.[a-z]+)?\.md$/.test(file)) return false;
  if (/\.(?:md|js|mjs|cjs|ts|go|rs|m|h|json|ya?ml|toml)$/.test(file)) return true;
  return /(?:^|\/)Makefile$/.test(file);
}

/** The expressions that records do not use, with their categories. Hexadecimal values such as color codes and UUIDs are not commit references. */
export const RECORD_PATTERNS = [
  ["commit reference", /\((?:[0-9a-f]{7,40})\)|`[0-9a-f]{7,40}`|\b(?:commit|pin) [0-9a-f]{7,40}\b|\b[0-9a-f]{7,40}\.\.[0-9a-f]{7,40}\b/i],
  ["pull request number", /\bPR #?\d+\b|\bpull request #?\d+\b/i],
  ["CI run number", /\brun \d{8,}\b/i],
  ["personal path", /\/Users\/|~\/backup/],
  ["account of who found or requested", /\bFound (?:on|while)\b|\b(?:Requested|Reported|Found|Decided) by\b|\bthe user's (?:decision|request|report)\b|사용자 결정|사용자가 (?:보고|발견|결정)|\bas the user asked\b|\bthe user (?:asked|decided|requested)\b|사용자 요청|사용자가 요청|발견:|\d{4}-\d{2}-\d{2}(?:[^.\n]|\.(?! )){0,80}?발견했|사용자가(?:[^.\n]|\.(?! )){0,120}?보고했/i],
  // macOS is an operating system name. "Mac" refers to that computer only when no letter follows it.
  ["local environment", /\b[Tt]his (?:machine|Mac)(?![A-Za-z])|이 (?:머신|Mac)(?![A-Za-z])/],
];

// Replaces a Markdown code block with the same number of blank lines. The line numbers of violations stay equal to the original.
const withoutCode = (text) => text.replace(/^(`{3,}|~{3,}).*\n[\s\S]*?^\1\s*$/gm, (block) => block.replace(/[^\n]/g, ""));

/** Returns the lines of text that break a record rule as `file:line: category: match`. kind is `document` or `config`. */
export function recordViolations(text, file, kind = "document") {
  const lines = (kind === "document" ? withoutCode(text) : text).split("\n");
  const errors = [];
  lines.forEach((line, index) => {
    if (kind === "config" && !/^\s*#/.test(line)) return;
    for (const [category, pattern] of RECORD_PATTERNS) {
      const match = pattern.exec(line);
      if (match) errors.push(`${file}:${index + 1}: ${category}: ${match[0]}`);
    }
  });
  return errors;
}

/**
 * The checklist lines of a features file that state an identifier which an earlier line of the same file states, as
 * `file:line: duplicate checklist identifier <id> (first stated on line <n>)`. The identifier grammar matches scripts/checklist.mjs.
 */
export function checklistViolations(text, file) {
  const errors = [];
  const first = new Map();
  text.split("\n").forEach((line, index) => {
    const id = line.match(/^\s*- \[[^\]]*\] ([A-Z]\d+(?:[.-]\d+[a-z]?)*)\s+—\s+/)?.[1];
    if (!id) return;
    if (first.has(id)) errors.push(`${file}:${index + 1}: duplicate checklist identifier ${id} (first stated on line ${first.get(id)})`);
    else first.set(id, index + 1);
  });
  return errors;
}

/** The kind of a file to check. A document is `.md`, and a configuration is a workflow or a Makefile. Any other file is null. */
export function recordKind(file) {
  if (file.endsWith(".md")) return "document";
  if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(file) || /(?:^|\/)Makefile$/.test(file)) return "config";
  return null;
}

const COMMIT_TYPES = ["feat", "fix", "docs", "style", "refactor", "test", "chore"];
const FOOTER = /^(?:Refs|Co-Authored-By|Signed-off-by|Generated(?: with| by)?|Reviewed-by)\b|^🤖|claude\.ai\/code/i;

/** Checks that a commit message has the form `type(scope): Subject (#ID)`, a blank line, a body wrapped at 72 characters and no footer. */
export function commitMessageErrors(message) {
  const lines = message.replace(/\n+$/, "").split("\n");
  const errors = [];
  const subject = /^([a-z]+)\(([a-z0-9-]+)\): (.+) \(#([A-Z][A-Za-z0-9]*(?:[.-][A-Za-z0-9]+)*)\)$/.exec(lines[0]);
  if (!subject) errors.push(`subject must be "type(scope): Subject (#ID)": ${lines[0]}`);
  else {
    const [, type, , text] = subject;
    if (!COMMIT_TYPES.includes(type)) errors.push(`type must be one of ${COMMIT_TYPES.join(", ")}: ${type}`);
    if (text.length > 50) errors.push(`subject is ${text.length} characters, above 50: ${text}`);
    if (!/^[A-Z]/.test(text)) errors.push(`subject must start with a capital letter: ${text}`);
    if (text.endsWith(".")) errors.push(`subject must not end with a period: ${text}`);
  }
  if (lines.length < 3 || lines[1] !== "" || !lines.slice(2).some((line) => line.trim())) {
    errors.push("a blank line and a non-empty body must follow the subject");
  }
  lines.slice(2).forEach((line, index) => {
    if (line.length > 72) errors.push(`body line ${index + 3} is ${line.length} characters, above 72`);
    if (FOOTER.test(line)) errors.push(`body line ${index + 3} is a footer: ${line}`);
  });
  for (const error of recordViolations(lines.join("\n"), "message")) errors.push(error.replace(/^message:/, "line "));
  for (const error of termViolations(lines.join("\n"), "message")) errors.push(error.replace(/^message:/, "line "));
  return errors;
}

/** The violations of the record files that the repository tracks. */
/** The tracked files of the repository that its census declaration does not exclude; an excluded file, a vendored third-party bundle, is not a record of the repository. */
function declaredFiles(repository, tracked) {
  const census = join(repository, "census.json");
  // default: a census declaration without an exclude excludes nothing, so every tracked file is a record of the repository.
  const declaration = existsSync(census) ? JSON.parse(readFileSync(census, "utf8")) : undefined;
  if (declaration !== undefined && (declaration === null || typeof declaration !== "object" || Array.isArray(declaration))) {
    throw new Error(`${census}: declaration must be an object; found ${declaration === null ? "null" : Array.isArray(declaration) ? "array" : typeof declaration} ${JSON.stringify(declaration)}`);
  }
  if (declaration && Object.hasOwn(declaration, "exclude") && typeof declaration.exclude !== "string") {
    throw new Error(`${census}: exclude must be a string; found ${typeof declaration.exclude} ${JSON.stringify(declaration.exclude)}`);
  }
  let exclude = null;
  if (declaration && Object.hasOwn(declaration, "exclude")) {
    try {
      exclude = new RegExp(declaration.exclude);
    } catch (error) {
      throw new Error(`${census}: exclude pattern ${JSON.stringify(declaration.exclude)} is invalid: ${error.message}`, { cause: error });
    }
  }
  return exclude ? tracked.filter((file) => !exclude.test(file)) : tracked;
}

export function repositoryRecordViolations(repository) {
  const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: repository, encoding: "utf8" })
    .split("\0").filter((file) => file && existsSync(join(repository, file)));
  const files = declaredFiles(repository, tracked).filter((file) => recordKind(file) !== null || termChecked(file));
  return { files, errors: files.flatMap((file) => {
    const text = readFileSync(join(repository, file), "utf8");
    return [
      ...(recordKind(file) ? recordViolations(text, file, recordKind(file)) : []),
      ...(termChecked(file) ? termViolations(text, file) : []),
      ...(/(?:^|\/)features(?:\.[a-z]+)?\.md$/.test(file) ? checklistViolations(text, file) : []),
    ];
  }) };
}

// A package manager places a package as a link, so the started path is resolved before it is compared with this module.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  // default: when [repository] of the usage is omitted, the repository in the current folder is checked.
  const { files, errors } = repositoryRecordViolations(resolve(process.argv[2] ?? "."));
  if (errors.length) {
    process.stderr.write(errors.map((error) => `${error}\n`).join(""));
    process.stderr.write(`${errors.length} record lines state something other than facts about this repository\n`);
    process.exit(1);
  }
  process.stdout.write(`Record checks passed: ${files.length} files\n`);
}
