// 공개 항목의 이름이 선언과 맞는지 검사한다.
//
// 규칙(AGENTS.md, docs/spec/exposure.md):
//   1. 소스에 적은 공개 이름(따옴표 안의 이름, data-expose, data-command, 연결과 실행)은
//      선언되어 있다.
//   2. 선언한 status 와 명령은 등록되고, 선언한 dom 이름은 요소에 붙는 값으로 적혀 있다.
// 조작 요소가 명령과 dom 이름을 갖는지는 실행 중인 문서의 audit(core.page.audit,
// core.surface.document 의 unbound)가 판단한다. 소스 모양으로 추측하지 않는다.
// 워크벤치(코어)를 검사한다. 검사 규칙은 plugin-api 의 exposure-check.js 에 있고, 플러그인 페이지는 각 플러그인
// repository 가 그 모듈로 검사한다. --write 는 plugin-api 의 core-exposure.json 을 워크벤치 선언으로 다시 쓴다.
//
//   node scripts/check-exposure.mjs [--write]
import { readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { auditExposure, sourceFiles } from "../packages/plugin-api/exposure-check.js";

const ROOT = new URL("../", import.meta.url).pathname;
const WORKBENCH = join(ROOT, "packages/workbench");
// plugin repository 는 코어 선언의 이름을 plugin-api 의 이 파일에서 읽는다. 워크벤치 선언에서 만든다.
const CORE_EXPOSURE = join(ROOT, "packages/plugin-api/core-exposure.json");

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

/** 워크벤치 선언의 status 와 명령 이름. plugin-api 의 core-exposure.json 의 내용이다. */
export function coreExposureNames(exposes) {
  return {
    status: (exposes.status ?? []).map((e) => e.name),
    commands: (exposes.commands ?? []).map((e) => e.name),
  };
}

const coreExposes = readJson(join(WORKBENCH, "exposure.json")).exposes;
const names = `${JSON.stringify(coreExposureNames(coreExposes), null, 2)}\n`;
const errors = [];
if (process.argv.includes("--write")) writeFileSync(CORE_EXPOSURE, names);
if (readFileSync(CORE_EXPOSURE, "utf8") !== names) {
  errors.push("packages/plugin-api/core-exposure.json differs from packages/workbench/exposure.json; run node scripts/check-exposure.mjs --write");
}
const sources = [...sourceFiles(WORKBENCH, (name) => /\.(js|html)$/.test(name) && !name.endsWith(".mjs"))]
  .map((path) => ({ path: relative(ROOT, path), text: readFileSync(path, "utf8") }));
errors.push(...auditExposure({
  owner: "core",
  where: "packages/workbench",
  exposes: coreExposes,
  sources,
  // 코어 표면 항목(core.surface.*)은 플러그인 페이지 인터페이스가 등록한다.
  registrations: [readFileSync(join(ROOT, "packages/plugin-api/page.js"), "utf8")],
}));

// plugin 의 선언은 각 plugin repository 가 plugin-api 의 soksak-exposure 로 검사한다(docs/spec/plugins.md#repositories).
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Exposure checks passed: core");
}
