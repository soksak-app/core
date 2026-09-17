// 창 검사가 임의 코드 실행과 옛 관측 통로를 쓰지 않는지 검사한다.
//
// 창 검사는 로컬 엔드포인트의 선언된 항목(status, command, dom)과 네이티브 입력만 사용한다.
// 문서에 코드를 보내 실행하는 방법은 없으며, 그런 호출을 적은 검사는 거부한다.
//
//   node scripts/check-e2e.mjs
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("../", import.meta.url).pathname;
const DIR = join(ROOT, "e2e");

const RULES = [
  { what: "eval", pattern: /\beval(Async)?\b/ },
  { what: "Function constructor", pattern: /\bnew\s+Function\s*\(/ },
  { what: "native probe", pattern: /\bnativeProbe\b|["'`]native ["'`]\s*\+/ },
  { what: "TCP control port", pattern: /\b4973[1-3]\b|node:net/ },
];

const errors = [];
for (const name of readdirSync(DIR)) {
  if (!name.endsWith(".mjs")) continue;
  const path = join(DIR, name);
  readFileSync(path, "utf8").split("\n").forEach((line, index) => {
    for (const rule of RULES) {
      if (rule.pattern.test(line)) errors.push(`${relative(ROOT, path)}:${index + 1}: uses ${rule.what}`);
    }
  });
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Window check sources use only the endpoint");
}
