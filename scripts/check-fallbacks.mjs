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
const EXCLUDED = /(^|\/)(test|tests|testing|bench|vendor|dist|build|scripts|node_modules)\/|\.test\.|_test\.(go|rs|m)$|\.d\.(ts|mts|cts)$/;

/** 언어별 형태. 한 줄에서 찾는다. */
const PATTERNS = {
  js: [
    ["nullish default", /\?\?(?!=)/],
    ["nullish assignment", /\?\?=/],
    ["or default", null],
    ["or assignment", /\|\|=/],
    ["optional call", /\?\.\(/],
    ["empty catch", /catch\s*(\([^)]*\))?\s*\{\s*\}/],
    ["swallowing catch", /\.catch\(\s*(?:\(\s*[^)]*\s*\)|[\w$]+)\s*=>\s*(?:\{\s*\}|null\b|undefined\b|false\b|\[\]|\{\s*return\s+(?:null|undefined|false|\[\])\s*;?\s*\})\s*,?\s*\)/],
  ],
  rs: [
    ["discarded result", /\blet _ =/],
    ["defaulting unwrap", /\.unwrap_or(_default|_else)?\(/],
    ["discarded error", /\.ok\(\)\s*;/],
  ],
  go: [
    ["discarded error", /\b_\s*=\s*[^\n;]+/],
    ["ignored second result", /,\s*_\s*:?=/],
  ],
  m: [
    ["caught exception", /@catch/],
  ],
};

const language = (file) => {
  if (/\.(?:mjs|cjs|js|mts|cts|jsx|tsx|ts)$/.test(file)) return "js";
  if (file.endsWith(".rs")) return "rs";
  if (file.endsWith(".go")) return "go";
  if (/\.(m|mm)$/.test(file)) return "m";
  return null;
};

/** 이 줄 또는 바로 위에 이어진 주석 줄에 적힌 기본값의 까닭. */
const REASON = /(기본값|default): \S.{9,}/;
const COMMENT = /^\s*(\/\/|\*|\/\*)/;
const OR_OPERATOR = /\|\|(?![=])/g;

/** Logical OR used as a value fallback; boolean conditions remain ordinary logic. */
function hasOrDefault(line) {
  for (const match of line.matchAll(OR_OPERATOR)) {
    const before = line.slice(0, match.index);
    const after = line.slice(match.index + match[0].length).trimStart();
    // `||` in a condition or a boolean-producing expression is not a fallback.
    // This audit intentionally targets value positions rather than every logical OR.
    if (/\b(?:if|while|for)\s*\(/.test(before)) continue;
    if (/(?:===|!==|==|!=|<=|>=|(?<![=!<>])<(?![=])|(?<![=!<>])>(?![=]))/.test(line)) continue;
    if (/\bBoolean\s*\([^)]*$/.test(before) || /\breturn\s+!!/.test(before)) continue;
    if (/=>\s*[^;]*$/.test(before) && /\b(?:is|has|can)[A-Z]\w*\s*\(/.test(line)) continue;
    if (/^!/.test(after) || /!\s*$/.test(before)) continue;

    const assignment = before.match(/(?:^|[;{}])\s*(?:const|let|var)\s+([\w$.]+)\s*=\s*|(?:^|[;{}])\s*([\w$.]+)\s*=(?!=)\s*/);
    const assignedName = assignment?.[1] ?? assignment?.[2];
    if (assignedName && after.startsWith(assignedName) && !/[\w$]/.test(after[assignedName.length] ?? "")) continue;

    const valuePosition = assignedName !== undefined || /\breturn\s+[^;]*$/.test(before);
    const booleanName = /^(?:const|let|var)\s+(?:is|has|can)[A-Z_]/i.test(before.trim());
    const booleanCalls = /(?:^|\W)(?:is|has|can)[A-Z_]\w*\s*\([^)]*\)\s*$/.test(before) &&
      /^(?:is|has|can)[A-Z_]\w*\s*\(/.test(after);
    const literalFallback = /^(?:["'`]|-?\d|\[\]|\{\}|null\b|false\b|true\b|undefined\b)/.test(after);
    const namedFallback = /^(?:[\w$.]*)(?:fallback|default|empty|unknown|placeholder)[\w$]*/i.test(after);
    if (literalFallback || namedFallback || (valuePosition && !booleanName && !booleanCalls)) return true;
  }
  return false;
}

function reasonFor(lines, index) {
  const current = lines[index].match(REASON);
  if (current) return current[0].trim();
  for (let above = index - 1; above >= 0 && COMMENT.test(lines[above]); above--) {
    const match = lines[above].match(REASON);
    if (match) return match[0].trim();
  }
  return null;
}

/** 제품 코드에서 발견한 모든 기본값·오류 버림과 그 문서화된 이유를 돌려준다. */
export function listFallbacks(files, read) {
  const found = [];
  for (const file of files) {
    const kind = language(file);
    if (!kind || !PRODUCT.test(file) || EXCLUDED.test(file)) continue;
    const source = read(file);
    const lines = source.split("\n");
    lines.forEach((line, index) => {
      if (COMMENT.test(line)) return;
      for (const [pattern, regex] of PATTERNS[kind]) {
        const continuation = pattern === "or default" && /^\s*\|\|/.test(line) && index > 0;
        const candidate = continuation ? `${lines[index - 1]} ${line}` : line;
        const matches = pattern === "or default" ? hasOrDefault(candidate) : regex.test(line);
        const reasonIndex = continuation ? index - 1 : index;
        if (matches) found.push({ file, line: index + 1, pattern, code: line.trim(), reason: reasonFor(lines, reasonIndex) });
      }
    });
    if (kind === "js") {
      for (const match of source.matchAll(/catch\s*(?:\([^)]*\))?\s*\{\s*\}/g)) {
        const index = source.slice(0, match.index).split("\n").length - 1;
        if (found.some((item) => item.file === file && item.line === index + 1 && item.pattern === "empty catch")) continue;
        found.push({ file, line: index + 1, pattern: "empty catch", code: lines[index].trim(), reason: reasonFor(lines, index) });
      }
      for (const match of source.matchAll(/\.catch\(\s*(?:\(\s*[^)]*\s*\)|[\w$]+)\s*=>\s*\{\s*\}\s*,?\s*\)/gs)) {
        const index = source.slice(0, match.index).split("\n").length - 1;
        if (COMMENT.test(lines[index])) continue;
        if (found.some((item) => item.file === file && item.line === index + 1 && item.pattern === "swallowing catch")) continue;
        found.push({ file, line: index + 1, pattern: "swallowing catch", code: lines[index].trim(), reason: reasonFor(lines, index) });
      }
    }
  }
  return found;
}

/** 까닭이 적히지 않은 자리를 돌려준다. */
export function findFallbacks(files, read) {
  return listFallbacks(files, read).filter((item) => item.reason === null);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const listOnly = process.argv.length === 3 && process.argv[2] === "--list";
  if (process.argv.length > 2 && !listOnly) {
    console.error("usage: node scripts/check-fallbacks.mjs [--list]");
    process.exit(2);
  }
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: ROOT, encoding: "utf8" })
    .split("\n").filter(Boolean);
  const all = listFallbacks(files, (file) => readFileSync(join(ROOT, file), "utf8"));
  const unresolved = all.filter((item) => item.reason === null);
  if (listOnly) {
    for (const item of all) {
      const reason = item.reason === null ? "UNJUSTIFIED" : `reason=${item.reason}`;
      console.log(`${item.file}:${item.line}: ${item.pattern} [${reason}] ${item.code}`);
    }
  }
  if (unresolved.length) {
    if (!listOnly) console.error(unresolved.map((item) => `${item.file}:${item.line}: ${item.pattern} without a stated reason: ${item.code}`).join("\n"));
    console.error(`${unresolved.length} defaults or discarded errors have no stated reason. Replace each with an explicit error, ` +
      "or state on its line or in the comment above it why the default is part of the contract (기본값: … / default: …).");
    process.exit(1);
  }
  console.log(`Fallback checks passed: ${all.length} occurrences listed; ${all.length - unresolved.length} have a stated contract reason.`);
}
