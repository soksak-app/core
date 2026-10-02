#!/usr/bin/env node
// 주석 언어 규칙을 검사한다. AGENTS.md 는 packages/soksak 의 주석을 영어로, 다른 디렉터리의 주석을 한국어로 쓰게 한다.
// 이 검사는 packages/soksak 밖의 추적 파일에서 영어 문장(글자 셋 이상인 낱말 뒤에 글자 둘 이상인 낱말)이 있으면서
// 한글이 없는 주석 줄을 보고한다. 식별자, 경로, 주소만 있는 주석과 도구가 읽는 지시문은 문장이 아니므로 제외한다.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 검사하는 파일. packages/soksak 과 생성물은 뺀다. */
const SOURCE = /\.(js|mjs|cjs|ts|html|css|go|rs|m|h|sh)$|(^|\/)Makefile$/;
const EXCLUDED = /^packages\/soksak\/|(^|\/)(dist|node_modules|target)\//;

/** 도구가 읽는 지시문. 주석 내용의 처음에 온다. */
const DIRECTIVE = /^(contract:|go:|export \w+$|#cgo|eslint|@ts-|SPDX|nolint|rustfmt::|clippy::|swiftlint|MARK:)/;

/** 영어 문장을 이루는 낱말의 연속. */
const SENTENCE = /[A-Za-z]{3,}[\s,;:]+[A-Za-z]{2,}/;
const HANGUL = /[가-힣]/;

/** 파일의 언어. 주석과 문자열의 문법을 정한다. */
function language(file) {
  if (/(^|\/)Makefile$/.test(file) || file.endsWith(".sh")) return "hash";
  if (file.endsWith(".css")) return "css";
  if (file.endsWith(".html")) return "html";
  if (file.endsWith(".rs")) return "rust";
  if (file.endsWith(".go")) return "go";
  return "c";
}

/** 문자열을 여는 따옴표. Rust 의 작은따옴표는 수명 표기와 겹치므로 문자열로 보지 않는다. */
const QUOTES = { c: "\"'`", go: "\"'`", rust: "\"", css: "\"'", hash: "\"'" };

/**
 * 원문 text 의 주석을 줄 단위로 돌려준다. 각 항목은 { line, text } 이며 줄 번호는 1 부터다.
 * html 은 <!-- --> 주석과 <script> 안의 C 계열 주석을 읽는다.
 */
export function comments(file, text) {
  const kind = language(file);
  if (kind === "html") return htmlComments(text);
  if (kind === "go") return goComments(text);
  return scan(text, kind, 0);
}

/** Go 의 cgo preamble(import "C" 바로 앞의 블록 주석)은 C 코드이므로 그 안의 C 주석만 주석으로 읽는다. */
function goComments(text) {
  const lineAt = (index) => text.slice(0, index).split("\n").length;
  const preambles = [...text.matchAll(/\/\*([\s\S]*?)\*\/\s*import\s+"C"/g)].map((match) => ({
    first: lineAt(match.index), last: lineAt(match.index + 2 + match[1].length),
    inner: scan(match[1], "c", lineAt(match.index) - 1),
  }));
  const inside = (line) => preambles.some((range) => line >= range.first && line <= range.last);
  return [...scan(text, "go", 0).filter((comment) => !inside(comment.line)), ...preambles.flatMap((range) => range.inner)]
    .sort((a, b) => a.line - b.line);
}

function scan(text, kind, firstLine) {
  const found = [];
  const quotes = QUOTES[kind];
  let line = firstLine + 1;
  let state = "code";
  let quote = "";
  let current = "";
  const flush = () => {
    found.push({ line, text: current });
    current = "";
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (state === "code") {
      if (ch === "\n") { line++; continue; }
      if (kind === "hash" && ch === "#") {
        // 첫 줄의 #! 은 실행기 지정이다.
        if (!(line === 1 && next === "!")) { state = "line"; continue; }
      }
      if (kind !== "hash" && kind !== "css" && ch === "/" && next === "/") { state = "line"; i++; continue; }
      if (kind !== "hash" && ch === "/" && next === "*") { state = "block"; i++; continue; }
      if (quotes.includes(ch)) { state = "string"; quote = ch; continue; }
    } else if (state === "string") {
      if (ch === "\\") { i++; continue; }
      if (ch === quote) { state = "code"; continue; }
      if (ch === "\n" && quote !== "`") { state = "code"; line++; continue; }
      if (ch === "\n") line++;
    } else if (state === "line") {
      if (ch === "\n") { flush(); state = "code"; line++; continue; }
      current += ch;
    } else if (state === "block") {
      if (ch === "*" && next === "/") { flush(); state = "code"; i++; continue; }
      if (ch === "\n") { flush(); line++; continue; }
      current += ch;
    }
  }
  if (state === "line" || state === "block") flush();
  return found;
}

function htmlComments(text) {
  const found = [];
  const lineAt = (index) => text.slice(0, index).split("\n").length;
  for (const match of text.matchAll(/<!--([\s\S]*?)-->/g)) {
    match[1].split("\n").forEach((part, offset) => found.push({ line: lineAt(match.index) + offset, text: part }));
  }
  for (const match of text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
    const start = match.index + match[0].indexOf(">") + 1;
    found.push(...scan(match[1], "c", lineAt(start) - 1));
  }
  return found.sort((a, b) => a.line - b.line);
}

/** 주석 내용에서 꾸밈 기호를 걷어 낸다. */
function body(text) {
  return text.replace(/^[\s/*!#-]+/, "").replace(/[\s*]+$/, "");
}

/** 문장 판정에서 뺄 코드 조각. backtick 으로 묶은 코드, 꺾쇠 태그, 중괄호로 묶은 필드 목록은 식별자다. */
function prose(text) {
  let rest = text.replace(/`[^`]*`/g, " ").replace(/<[^<>]*>/g, " ");
  for (let previous = ""; previous !== rest;) {
    previous = rest;
    rest = rest.replace(/\{[^{}]*\}/g, " ");
  }
  return rest;
}

/**
 * files 가운데 한국어로 써야 하는데 영어 문장만 있는 주석 줄. read(file) 은 파일의 원문을 돌려준다.
 * 주석은 이어진 줄의 묶음 단위로 읽는다. 묶음에 한국어 설명이 있으면 그 안의 명령, 값 모양, 식별자 줄은 설명의 일부다.
 */
export function findEnglishComments(files, read) {
  const found = [];
  for (const file of files) {
    if (!SOURCE.test(file) || EXCLUDED.test(file)) continue;
    // 주석 안의 ``` 울타리 사이는 코드 예제다.
    let fenced = false;
    let block = [];
    const close = () => {
      if (!block.some((item) => HANGUL.test(item.text))) {
        for (const item of block) if (SENTENCE.test(prose(item.text))) found.push({ file, line: item.line, text: item.text });
      }
      block = [];
    };
    for (const comment of comments(file, read(file))) {
      if (block.length && comment.line !== block.at(-1).line + 1) close();
      const text = body(comment.text);
      // 빈 줄, 울타리, 코드 예제, 지시문도 묶음을 잇는다. 판정에는 쓰지 않는다.
      const skipped = text.startsWith("```") ? (fenced = !fenced, true) : fenced || !text || DIRECTIVE.test(text);
      block.push({ line: comment.line, text: skipped ? "" : text });
    }
    close();
  }
  return found;
}

/**
 * 검사할 작업 트리 파일. 추적 파일과 무시되지 않은 새 파일을 읽고, 작업 트리에서 지운 파일은 뺀다.
 * list(...args) 는 `git ls-files args` 의 결과 줄을 돌려준다.
 */
export function workingTreeFiles(list) {
  const deleted = new Set(list("--deleted"));
  return list("--cached", "--others", "--exclude-standard").filter((file) => !deleted.has(file));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = workingTreeFiles((...args) =>
    execFileSync("git", ["ls-files", ...args], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean));
  const found = findEnglishComments(files, (file) => readFileSync(join(ROOT, file), "utf8"));
  for (const item of found) console.error(`- ${item.file}:${item.line} ${item.text}`);
  if (found.length > 0) {
    console.error(`Comment language check failed: ${found.length} English comment lines outside packages/soksak`);
    process.exit(1);
  }
  console.log("Comment language check passed: comments outside packages/soksak are Korean");
}
