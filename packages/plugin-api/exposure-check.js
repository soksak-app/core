#!/usr/bin/env node
// 공개 항목의 이름이 선언과 맞는지 소스에서 검사한다(docs/spec/exposure.md).
//
// 규칙:
//   1. 소스에 적은 공개 이름(따옴표 안의 이름, data-expose, data-command, 연결과 실행)은 선언되어 있다.
//   2. 선언한 status 와 명령은 등록되고, 선언한 dom 이름은 요소에 붙는 값으로 적혀 있다.
// 코어는 워크벤치를, 각 플러그인 repository 는 자기 페이지와 섹션을 이 검사로 확인한다. 섹션 모듈이 적는 코어
// status 와 명령은 core-exposure.json 의 선언과 비교한다. 조작 요소가 명령과 dom 이름을 갖는지는 실행 중인
// 문서의 audit 이 판단한다.
//
//   soksak-exposure [plugin repository]
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/* 공개 이름이 아닌 따옴표 안의 점 이름. 파일 이름이다. */
const FILE = /\.(html|js|mjs|json|css)$/;

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

/** 코어가 선언한 status 와 명령의 이름. core 의 워크벤치 선언에서 만든 core-exposure.json 이다. */
export function coreExposure() {
  return readJson(new URL("./core-exposure.json", import.meta.url));
}

/** dir 아래의 test 를 만족하는 파일. node_modules, test, dist, build 는 건너뛴다. */
export function* sourceFiles(dir, test) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (!["node_modules", "test", "dist", "build"].includes(name)) yield* sourceFiles(path, test);
    } else if (test(name)) {
      yield path;
    }
  }
}

/**
 * 한 구성 요소(코어 또는 플러그인 하나)의 오류 목록. sources 는 { path, text }, registrations 는 등록 코드의
 * 문장, sections 는 섹션 모듈 경로의 집합, core 는 { status, commands } 이름 목록이며 섹션 모듈이 적는 코어
 * 이름을 검사한다. where 는 등록 오류에 쓰는 구성 요소의 자리다.
 */
export function auditExposure({ owner, where, exposes, sources, registrations = [], sections = new Set(), core = null }) {
  const errors = [];
  const report = (path, index, text) => errors.push(`${path}:${index + 1}: ${text}`);
  // 기본값: exposes 의 status, commands, dom 은 선택 필드이며 없으면 그 종류의 선언이 없다.
  const entries = (list) => new Set((list ?? []).map((e) => e.name));
  const declared = { status: entries(exposes.status), command: entries(exposes.commands), dom: entries(exposes.dom) };
  // 기본값: core 가 없으면(코어 자신의 검사) 섹션 모듈이 없으므로 코어 이름 목록이 비어 있다.
  const coreNames = (list) => new Set(list ?? []);
  const coreStatus = coreNames(core?.status);
  const coreCommand = coreNames(core?.commands);
  // 이름은 세 종류 중 하나로 선언되면 선언된 것이다.
  const any = (name) => Object.values(declared).some((set) => set.has(name));
  const quoted = new RegExp(`["'\`](${owner}\\.[a-z0-9-]+(?:\\.[a-z0-9-]+)*)["'\`]`, "g");
  const shown = new Set();

  for (const { path, text } of sources) {
    text.split("\n").forEach((line, index) => {
      // 1. 이름
      if (sections.has(path)) {
        for (const [, name] of line.matchAll(/["'`](core\.[a-z0-9-]+(?:\.[a-z0-9-]+)*)["'`]/g)) {
          if (!coreStatus.has(name) && !coreCommand.has(name)) report(path, index, `${name} is not a declared core status or command`);
        }
      }
      for (const [, name] of line.matchAll(quoted)) {
        if (!FILE.test(name) && !any(name)) report(path, index, `${name} is not declared`);
      }
      for (const [, name] of line.matchAll(/data-command=["']([^"']+)["']/g)) {
        if (!declared.command.has(name)) report(path, index, `data-command ${name} is not a declared command`);
      }
      for (const [, name] of line.matchAll(/\b(?:mark|bind)\(\s*\w+(?:\.\w+|\([^)]*\))*\s*,\s*["']([^"']+)["']/g)) {
        // 섹션 모듈은 코어 명령도 연결할 수 있다(docs/spec/plugins.md#sections).
        const boundCore = sections.has(path) && coreCommand.has(name);
        if (!declared.command.has(name) && !boundCore) report(path, index, `${name} is bound to an element but is not a declared command`);
      }
      for (const [, name] of line.matchAll(/\b(?:run|command)\(\s*["']([^"']+)["']/g)) {
        if (!declared.command.has(name)) report(path, index, `${name} is run but is not a declared command`);
      }
      const domNames = [
        ...[...line.matchAll(/data-expose=["']([^"']+)["']/g)].map((m) => m[1]),
        ...[...line.matchAll(/[Ee]xpose\s*[:=]\s*["']([^"']+)["']/g)].map((m) => m[1]),
        ...(line.includes("dataset.expose") ? [...line.matchAll(quoted)].map((m) => m[1]) : []),
        ...[...line.matchAll(/(?:expose|context\.exposure)\.dom\(\s*["']([^"']+)["']/g)].map((m) => m[1]),
      ];
      // 이름을 인자로 받아 요소에 붙이는 함수(act, field 등)도 있으므로, 선언된 dom 이름이 따옴표로 적힌 곳은
      // 표시한 곳으로 센다.
      for (const [, name] of line.matchAll(quoted)) if (declared.dom.has(name)) shown.add(name);
      for (const name of domNames) {
        if (name.includes("${")) continue;
        shown.add(name);
        if (!declared.dom.has(name)) report(path, index, `data-expose ${name} is not a declared dom entry`);
      }
    });
  }

  // 2. 등록과 표시
  const all = sources.map((source) => source.text).join("\n") + registrations.join("\n");
  for (const name of declared.status) {
    const pattern = owner === "core" ? `status\\(\\s*"${name}"` : `(?:expose|context\\.exposure)\\.status\\(\\s*["']${name}["']`;
    if (!new RegExp(pattern).test(all)) errors.push(`${where}: status ${name} is declared but not registered`);
  }
  for (const name of declared.command) {
    const pattern = owner === "core" ? `(?:registry|expose)\\.command\\(\\s*"${name}"` : `(?:expose|context\\.exposure)\\.command\\(\\s*["']${name}["']`;
    if (!new RegExp(pattern).test(all)) errors.push(`${where}: command ${name} is declared but not registered`);
  }
  for (const name of declared.dom) {
    if (!shown.has(name)) errors.push(`${where}: dom ${name} is declared but no element carries it`);
  }
  return errors;
}

/**
 * 플러그인 repository 하나를 검사한다. plugin.json 과 diagnostics.json(진단 build 의 선언)을 합쳐 ui/ 의 소스와
 * 비교한다. 경로는 repository 기준 상대 경로로 보고한다.
 */
export function checkPluginRepository(root, core = coreExposure()) {
  const manifest = readJson(join(root, "plugin.json"));
  const ui = join(root, "ui");
  const paths = existsSync(ui) ? [...sourceFiles(ui, (name) => /\.(js|html)$/.test(name))] : [];
  const diagnosticsPath = join(root, "diagnostics.json");
  // 기본값: diagnostics.json 이 없는 플러그인은 진단 build 의 선언이 없다.
  const diagnostics = existsSync(diagnosticsPath) ? readJson(diagnosticsPath).exposes : {};
  const exposes = Object.fromEntries(["status", "commands", "dom"].map((key) =>
    // 기본값: exposes 와 그 항목은 plugin.json 의 선택 필드이며 없으면 선언이 없다.
    [key, [...(manifest.exposes?.[key] ?? []), ...(diagnostics[key] ?? [])]]));
  // 기본값: sections 는 plugin.json 의 선택 필드이며 없으면 섹션 모듈이 없다.
  const sections = new Set((manifest.sections ?? []).flatMap((section) =>
    (typeof section.module === "string" ? [section.module] : [section.module.horizontal, section.module.vertical])));
  return auditExposure({
    owner: manifest.id, where: `plugin ${manifest.id}`, exposes,
    sources: paths.map((path) => ({ path: relative(root, path), text: readFileSync(path, "utf8") })),
    sections, core,
  });
}

// package manager 는 package 를 link 로 두므로 시작한 경로를 풀어서 이 module 과 비교한다.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  // 기본값: 인자가 없으면 현재 폴더의 plugin repository 를 검사한다.
  const root = resolve(process.argv[2] ?? ".");
  const errors = checkPluginRepository(root);
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`Exposure checks passed: plugin ${readJson(join(root, "plugin.json")).id}`);
  }
}
