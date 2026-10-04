// 사용자에게 보이는 오류는 하나의 표시 경로(shown-errors.js)로만 보이고, 오류 색은 그 경로가 붙이는 data-error 요소에만
// 쓴다(AGENTS.md). 이 검사는 stylesheet 와 원본에서 그 규칙을 어긴 곳을 찾는다.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const here = new URL("../", import.meta.url);
const files = (extension) => readdirSync(here).filter((name) => name.endsWith(extension));
// 오류가 아닌 곳의 오류 색. 탭 닫기 단추의 hover 는 닫기라는 동작을 강조할 뿐 오류를 보이지 않는다.
const NOT_ERRORS = new Set([".tab__x:hover"]);

test("the error color is used only by the elements of the error display path", () => {
  const offending = [];
  for (const name of files(".css")) {
    const text = readFileSync(new URL(name, here), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const match of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = match[1].trim();
      if (!match[2].includes("var(--no)")) continue;
      if (selector.split(",").every((part) => part.includes("[data-error]") || NOT_ERRORS.has(part.trim()))) continue;
      offending.push(`${name}: ${selector}`);
    }
  }
  assert.deepEqual(offending, [], "these rules color an error outside the error display path");
});

test("only the error display path marks an element as an error", () => {
  const offending = [];
  for (const name of [...files(".js"), ...files(".html")]) {
    if (name === "shown-errors.js") continue;
    const text = readFileSync(new URL(name, here), "utf8");
    for (const [index, line] of text.split("\n").entries()) {
      if (/dataset\.error\b|["']data-error["']|\[data-error\]/.test(line)) offending.push(`${name}:${index + 1}: ${line.trim()}`);
    }
  }
  assert.deepEqual(offending, [], "these lines mark an error without the error display path");
});
