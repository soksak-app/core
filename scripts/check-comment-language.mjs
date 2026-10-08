#!/usr/bin/env node
// Checks the comment language rule of AGENTS.md: comments are written in English. The check reports each comment line of
// a tracked source file that holds a Hangul character. Generated folders are left out.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The checked files; generated output is left out. */
const SOURCE = /\.(js|mjs|cjs|ts|html|css|go|rs|m|h|sh)$|(^|\/)Makefile$/;
const EXCLUDED = /(^|\/)(dist|node_modules|target)\//;

const HANGUL = /[가-힣]/;

/** The language of a file, which sets the syntax of its comments and strings. */
function language(file) {
  if (/(^|\/)Makefile$/.test(file) || file.endsWith(".sh")) return "hash";
  if (file.endsWith(".css")) return "css";
  if (file.endsWith(".html")) return "html";
  if (file.endsWith(".rs")) return "rust";
  if (file.endsWith(".go")) return "go";
  return "c";
}

/** The quotes that open a string. A Rust single quote also marks a lifetime, so it does not open a string. */
const QUOTES = { c: "\"'`", go: "\"'`", rust: "\"", css: "\"'", hash: "\"'" };

/**
 * Returns the comments of the source text line by line, each { line, text } with lines counted from 1.
 * For html it reads <!-- --> comments and the C-style comments inside <script>.
 */
export function comments(file, text) {
  const kind = language(file);
  if (kind === "html") return htmlComments(text);
  if (kind === "go") return goComments(text);
  return scan(text, kind, 0);
}

/** A Go cgo preamble (the block comment right before import "C") is C code, so only its C comments are comments. */
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
        // #! on the first line names the interpreter.
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

/** Strips the comment markers around the content of a comment. */
function body(text) {
  return text.replace(/^[\s/*!#-]+/, "").replace(/[\s*]+$/, "");
}

/**
 * The comment lines of files that hold Hangul. Comments are written in English (AGENTS.md); a Hangul character in a
 * comment marks a line that is not. read(file) returns the text of the file.
 */
export function findKoreanComments(files, read) {
  const found = [];
  for (const file of files) {
    if (!SOURCE.test(file) || EXCLUDED.test(file)) continue;
    for (const comment of comments(file, read(file))) {
      if (HANGUL.test(comment.text)) found.push({ file, line: comment.line, text: body(comment.text) });
    }
  }
  return found;
}

/**
 * The working tree files to check: tracked files and new files that are not ignored, without files deleted from the
 * working tree. list(...args) returns the lines of `git ls-files args`.
 */
export function workingTreeFiles(list) {
  const deleted = new Set(list("--deleted"));
  return list("--cached", "--others", "--exclude-standard").filter((file) => !deleted.has(file));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = workingTreeFiles((...args) =>
    execFileSync("git", ["ls-files", ...args], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean));
  const found = findKoreanComments(files, (file) => readFileSync(join(ROOT, file), "utf8"));
  for (const item of found) console.error(`- ${item.file}:${item.line} ${item.text}`);
  if (found.length > 0) {
    console.error(`Comment language check failed: ${found.length} comment lines are not English`);
    process.exit(1);
  }
  console.log("Comment language check passed: comments are English");
}
