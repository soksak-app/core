#!/usr/bin/env node
// 기록이 저장소에 관한 사실만 적는지 검사한다. 문서는 코드 블록 밖의 모든 줄을, 설정 파일(workflow, Makefile)은 주석 줄만
// 검사하고, 위반을 `path:line` 으로 보고한다. 저장소마다 이 명령으로 자기 기록을 검사한다.
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

/** 기록에 쓰지 않는 표현과 그 범주. 색 코드와 UUID 같은 16진수 값은 커밋 참조가 아니다. */
export const RECORD_PATTERNS = [
  ["commit reference", /\((?:[0-9a-f]{7,40})\)|`[0-9a-f]{7,40}`|\b(?:commit|pin) [0-9a-f]{7,40}\b|\b[0-9a-f]{7,40}\.\.[0-9a-f]{7,40}\b/i],
  ["pull request number", /\bPR #?\d+\b|\bpull request #?\d+\b/i],
  ["CI run number", /\brun \d{8,}\b/i],
  ["personal path", /\/Users\/|~\/backup/],
  ["account of who found or requested", /\bFound (?:on|while)\b|\b(?:Requested|Reported|Found|Decided) by\b|\bthe user's (?:decision|request|report)\b|사용자 결정|사용자가 (?:보고|발견|결정)|\bas the user asked\b|\bthe user (?:asked|decided|requested)\b|사용자 요청|사용자가 요청|발견:|\d{4}-\d{2}-\d{2}(?:[^.\n]|\.(?! )){0,80}?발견했|사용자가(?:[^.\n]|\.(?! )){0,120}?보고했/i],
  // macOS 는 운영 체제 이름이다. "Mac" 은 뒤에 글자가 없을 때만 그 컴퓨터를 가리킨다.
  ["local environment", /\b[Tt]his (?:machine|Mac)(?![A-Za-z])|이 (?:머신|Mac)(?![A-Za-z])/],
];

// 마크다운 코드 블록을 같은 수의 빈 줄로 바꾼다. 위반의 줄 번호가 원본과 같게 유지된다.
const withoutCode = (text) => text.replace(/^(`{3,}|~{3,}).*\n[\s\S]*?^\1\s*$/gm, (block) => block.replace(/[^\n]/g, ""));

/** text 에서 기록 규칙을 어기는 줄을 `file:line: category: match` 로 돌려준다. kind 는 `document` 또는 `config`. */
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

/** 검사할 파일의 종류. 문서는 `.md`, 설정은 workflow 와 Makefile 이다. 그 밖의 파일은 null. */
export function recordKind(file) {
  if (file.endsWith(".md")) return "document";
  if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(file) || /(?:^|\/)Makefile$/.test(file)) return "config";
  return null;
}

const COMMIT_TYPES = ["feat", "fix", "docs", "style", "refactor", "test", "chore"];
const FOOTER = /^(?:Refs|Co-Authored-By|Signed-off-by|Generated(?: with| by)?|Reviewed-by)\b|^🤖|claude\.ai\/code/i;

/** 커밋 메시지가 `type(scope): Subject (#ID)`, 빈 줄, 72자에서 줄을 바꾼 본문, 꼬리말 없음의 형식인지 검사한다. */
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

/** repository 가 추적하는 기록 파일의 위반. */
export function repositoryRecordViolations(repository) {
  const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: repository, encoding: "utf8" })
    .split("\0").filter((file) => file && existsSync(join(repository, file)));
  const files = tracked.filter((file) => recordKind(file) !== null || termChecked(file));
  return { files, errors: files.flatMap((file) => {
    const text = readFileSync(join(repository, file), "utf8");
    return [...(recordKind(file) ? recordViolations(text, file, recordKind(file)) : []), ...(termChecked(file) ? termViolations(text, file) : [])];
  }) };
}

// package manager 는 package 를 link 로 두므로 시작한 경로를 풀어서 이 module 과 비교한다.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  // 기본값: 사용법의 [repository] 를 생략하면 현재 폴더의 repository 를 검사한다.
  const { files, errors } = repositoryRecordViolations(resolve(process.argv[2] ?? "."));
  if (errors.length) {
    process.stderr.write(errors.map((error) => `${error}\n`).join(""));
    process.stderr.write(`${errors.length} record lines state something other than facts about this repository\n`);
    process.exit(1);
  }
  process.stdout.write(`Record checks passed: ${files.length} files\n`);
}
