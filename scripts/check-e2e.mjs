// 창 검사가 임의 코드 실행과 옛 관측 통로를 쓰지 않는지 검사한다.
//
// 창 검사는 로컬 엔드포인트의 선언된 항목(status, command, dom)과 네이티브 입력만 사용한다.
// 문서에 코드를 보내 실행하는 방법은 없으며, 그런 호출을 적은 검사는 거부한다.
// 상태는 status.watch 알림으로 기다린다. 정해진 시간만큼 기다리는 대기와 반복 조회는
// 거부한다. setTimeout 은 기다림의 상한(시간이 지나면 거절)으로만 쓸 수 있다.
// e2e 아래의 모든 .mjs 파일을 검사한다(node_modules 제외).
//
//   node scripts/check-e2e.mjs
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = new URL("../", import.meta.url).pathname;
const DIR = join(ROOT, "e2e");

const RULES = [
  { what: "eval", pattern: /\beval(Async)?\b/ },
  { what: "Function constructor", pattern: /\bnew\s+Function\s*\(/ },
  { what: "native probe", pattern: /\bnativeProbe\b|["'`]native ["'`]\s*\+/ },
  { what: "TCP control port", pattern: /\b4973[1-3]\b|node:net/ },
  { what: "a repeating timer", pattern: /\bsetInterval\s*\(/ },
  { what: "a fixed sleep", pattern: /\b(sleep|delay|pause)\s*\(|timers\/promises/, inputPacing: true },
  { what: "application activation that takes user focus", pattern: /\bactivate\s*:\s*true\b/, activationTier: true },
];

// e2e/activation 과 e2e/real 의 검사는 사용자가 승인한 실행에서만 돌며 앱을 활성화할 수 있다.
const ACTIVATION_DIRS = ["e2e/activation/", "e2e/real/"];
// 실제 입력 도구는 사람이 움직이는 속도로 HID 이벤트 사이에 간격을 둔다. 상태를 기다리는 대기가 아니며,
// 간격 없이 보낸 끌기 이벤트는 창 서버가 합친다. 이 파일 밖에서는 고정 대기를 쓸 수 없다.
const INPUT_PACING_FILE = "e2e/real/hid.mjs";

/* setTimeout 은 콜백이 거절(reject)하는 상한으로만 허용한다. */
const TIMEOUT = /\bsetTimeout\s*\(/g;
const DEADLINE_WINDOW = 240;

function* sources(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sources(path);
    else if (name.endsWith(".mjs")) yield path;
  }
}

export function auditE2ESource(text, file) {
  const errors = [];
  text.split("\n").forEach((line, index) => {
    for (const rule of RULES) {
      if (rule.activationTier && ACTIVATION_DIRS.some((dir) => file.startsWith(dir))) continue;
      if (rule.inputPacing && file === INPUT_PACING_FILE) continue;
      if (rule.pattern.test(line)) errors.push(`${file}:${index + 1}: uses ${rule.what}`);
    }
  });
  for (const match of text.matchAll(TIMEOUT)) {
    if (!/\breject\s*\(/.test(text.slice(match.index, match.index + DEADLINE_WINDOW))) {
      const line = text.slice(0, match.index).split("\n").length;
      errors.push(`${file}:${line}: uses setTimeout as a wait; a timeout must reject`);
    }
  }
  return errors;
}

const errors = [];
for (const path of sources(DIR)) {
  errors.push(...auditE2ESource(readFileSync(path, "utf8"), relative(ROOT, path)));
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.log("Window check sources use only the endpoint");
  }
}
