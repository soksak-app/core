#!/usr/bin/env node
// 제품 코드의 대체값과 삼킨 오류를 찾는다. AGENTS.md 는 대체값 강제 변환, 무시한 결과, 알리지 않은 오류를 금지한다.
// 기본값이 계약의 일부인 자리는 그 줄이나 바로 위 주석 줄에 `기본값:`(packages/soksak 에서는 `default:`)으로
// 시작하는 까닭을 적는다. 까닭 없이 찾은 자리는 실패다.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 제품 코드. 테스트, 검사 도구, 벤치, 벤더, 생성물은 뺀다. */
const PRODUCT = /^(packages|plugins|sidecars|native|apps)\//;
const EXCLUDED = /(^|\/)(test|tests|testing|bench|vendor|dist|build|scripts|frontend|node_modules)\/|\.test\.|_test\.(go|rs|m)$|\.d\.ts$/;

/** 언어별 형태. 한 줄에서 찾는다. */
const PATTERNS = {
  js: [
    ["nullish default", /\?\?(?!=)/],
    ["or default", /(?:\|\|\s*(?:["'`]|-?\d|\[\]|\{\}|null\b|false\b|true\b|undefined\b)|\b(?:const|let|var)\s+\w+\s*=\s*[\w$.]+\s*\|\|\s*[\w$.]+)/],
    ["optional call", /\?\.\(/],
    ["empty catch", /catch\s*(\([^)]*\))?\s*\{\s*\}/],
    ["swallowing catch", /\.catch\(\s*\(\)\s*=>\s*(\{\s*\}|null|undefined|false|\[\])\s*\)/],
  ],
  rs: [
    ["discarded result", /\blet _ =/],
    ["defaulting unwrap", /\.unwrap_or(_default|_else)?\(/],
    ["discarded error", /\.ok\(\)\s*;/],
  ],
  go: [
    ["discarded error", /^\s*_\s*=\s*/],
    ["ignored second result", /,\s*_\s*:?=/],
  ],
  m: [
    ["caught exception", /@catch/],
  ],
};

const language = (file) => {
  if (/\.(m?js|ts)$/.test(file)) return "js";
  if (file.endsWith(".rs")) return "rs";
  if (file.endsWith(".go")) return "go";
  if (/\.(m|mm)$/.test(file)) return "m";
  return null;
};

/** 이 줄 또는 바로 위에 이어진 주석 줄에 적힌 기본값의 까닭. */
const REASON = /(기본값|default): \S.{9,}/;
const COMMENT = /^\s*(\/\/|\*|\/\*)/;

function reasoned(lines, index) {
  if (REASON.test(lines[index])) return true;
  for (let above = index - 1; above >= 0 && COMMENT.test(lines[above]); above--) {
    if (REASON.test(lines[above])) return true;
  }
  return false;
}

/** 까닭이 적히지 않은 자리를 돌려준다. */
export function findFallbacks(files, read) {
  const found = [];
  for (const file of files) {
    const kind = language(file);
    if (!kind || !PRODUCT.test(file) || EXCLUDED.test(file)) continue;
    const source = read(file);
    const lines = source.split("\n");
    lines.forEach((line, index) => {
      if (COMMENT.test(line)) return;
      for (const [pattern, regex] of PATTERNS[kind]) {
        if (regex.test(line) && !reasoned(lines, index)) found.push({ file, line: index + 1, pattern, code: line.trim() });
      }
    });
    if (kind === "js") {
      for (const match of source.matchAll(/catch\s*(?:\([^)]*\))?\s*\{\s*\}/g)) {
        const index = source.slice(0, match.index).split("\n").length - 1;
        if (found.some((item) => item.file === file && item.line === index + 1 && item.pattern === "empty catch") || reasoned(lines, index)) continue;
        found.push({ file, line: index + 1, pattern: "empty catch", code: lines[index].trim() });
      }
    }
  }
  return found;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: ROOT, encoding: "utf8" })
    .split("\n").filter(Boolean);
  const found = findFallbacks(files, (file) => readFileSync(join(ROOT, file), "utf8"));
  if (found.length) {
    console.error(found.map((item) => `${item.file}:${item.line}: ${item.pattern} without a stated reason: ${item.code}`).join("\n"));
    console.error(`${found.length} defaults or discarded errors have no stated reason. Replace each with an explicit error, ` +
      "or state on its line or in the comment above it why the default is part of the contract (기본값: … / default: …).");
    process.exit(1);
  }
  console.log("Fallback checks passed");
}
