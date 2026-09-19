#!/usr/bin/env node
// 애플리케이션의 프런트엔드를 한 디렉터리에 배치한다.
//
//   soksak-stage <출력 디렉터리> [--executables <디렉터리>] [--diagnostics]
//
// 현재 디렉터리의 애플리케이션 패키지에서 environment.json 을 읽는다. 패키지 위치는
// Node 모듈 해석으로 찾는다. 파일은 복사만 하고 내용을 바꾸지 않는다.
//
//   <출력>/                        워크벤치 패키지의 files
//   <출력>/modules/<패키지 이름>/   soksak, plugin-api, 각 플러그인 패키지의 files
//   <출력>/runtime/                 environment.json 의 runtime 디렉터리
//   <출력>/environment.json         애플리케이션의 environment.json
//   <출력>/modules/<사이드카>/sidecar.json  플러그인이 의존하는 사이드카의 sidecar.json
//
// --executables 를 지정하면 사이드카 실행 파일을 그 디렉터리에 파일 이름 그대로 복사한다.
// 네이티브 호스트는 자기 실행 파일과 같은 디렉터리에서 사이드카 실행 파일을 찾는다.
//
//   <출력>/diagnostics.js           --diagnostics 이면 워크벤치의 observe.js(페이지 진단 메서드),
//                                  아니면 빈 모듈. 진단 코드는 진단 빌드에만 들어간다
//   <출력>/transcript.js            --diagnostics 이면 진단 모듈이 쓰는 호출 기록기

import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { replaceFile } from "./replace-file.mjs";
import { STAGED } from "./staged.js";
import {
  ENVIRONMENT, MANIFEST, RUNTIME, SIDECAR, modulePath, validateEnvironment, validateManifest, validateSidecar,
} from "@soksak/plugin-api";

const USAGE = "usage: soksak-stage <output directory> [--executables <directory>] [--diagnostics]";
const args = process.argv.slice(2);
const [out, ...rest] = args;
let executables;
let diagnostics = false;
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === "--executables" && rest[i + 1] && executables === undefined) executables = rest[++i];
  else if (rest[i] === "--diagnostics" && !diagnostics) diagnostics = true;
  else { console.error(USAGE); process.exit(2); }
}
if (!out || out.startsWith("--")) {
  console.error(USAGE);
  process.exit(2);
}

const app = process.cwd();
const target = resolve(app, out);
const executableTarget = executables && resolve(app, executables);
const workbench = dirname(fileURLToPath(import.meta.url));
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

/** from 패키지의 의존성으로 name 패키지의 디렉터리를 찾는다. */
function packageDir(from, name) {
  return dirname(createRequire(join(from, "package.json")).resolve(`${name}/package.json`));
}

/** 패키지의 files 항목을 dest 에 복사한다. files 가 없으면 실패한다. */
function copyPackage(dir, dest) {
  const { name, files } = readJson(join(dir, "package.json"));
  if (!Array.isArray(files)) throw new Error(`${name}: package.json requires files`);
  for (const file of files) cpSync(join(dir, file), join(dest, file), { recursive: true });
}

const environment = validateEnvironment(readJson(join(app, ENVIRONMENT)));
const runtime = join(app, environment.runtime);
if (!existsSync(join(runtime, "index.js"))) throw new Error(`${environment.runtime}/index.js is missing`);

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });

copyPackage(workbench, target);
for (const name of ["soksak", "@soksak/plugin-api"]) {
  copyPackage(packageDir(workbench, name), join(target, modulePath(name, "")));
}
if (executableTarget) mkdirSync(executableTarget, { recursive: true });
const sidecars = new Set();
// 호스트는 실행 파일을 파일 이름으로 찾고 스테이징은 그 이름으로 한 디렉터리에 모은다. 서로 다른
// 원본이 같은 이름을 요구하면 나중 것이 앞의 것을 조용히 덮으므로 여기서 멈춘다.
const placed = new Map();

/** 빌드된 실행 파일을 파일 이름 그대로 실행 파일 디렉터리에 둔다. */
function place(owner, dir, path) {
  const built = join(dir, path);
  const file = basename(path);
  const taken = placed.get(file);
  if (taken && taken !== built) throw new Error(`${owner}: ${file} is already staged from ${taken}`);
  placed.set(file, built);
  if (!existsSync(built)) throw new Error(`${owner}: ${path} is not built`);
  replaceFile(built, join(executableTarget, file));
}

for (const name of environment.plugins) {
  const dir = packageDir(app, name);
  const manifest = validateManifest(readJson(join(dir, MANIFEST)));
  copyPackage(dir, join(target, modulePath(name, "")));
  for (const sidecar of manifest.sidecars ?? []) {
    if (sidecars.has(sidecar)) continue;
    sidecars.add(sidecar);
    const sidecarDir = packageDir(dir, sidecar);
    const declared = validateSidecar(readJson(join(sidecarDir, SIDECAR)));
    mkdirSync(join(target, modulePath(sidecar, "")), { recursive: true });
    copyFileSync(join(sidecarDir, SIDECAR), join(target, modulePath(sidecar, SIDECAR)));
    if (!executableTarget) continue;

    place(sidecar, sidecarDir, declared.executable);
    // 헬퍼는 그 사이드카의 의존성이므로 사이드카 디렉터리에서 해석한다.
    for (const helper of declared.helpers ?? []) {
      place(helper.package, packageDir(sidecarDir, helper.package), helper.executable);
    }
  }
}
cpSync(runtime, join(target, RUNTIME), { recursive: true });
if (diagnostics) {
  copyFileSync(join(workbench, "observe.js"), join(target, "diagnostics.js"));
  copyFileSync(join(workbench, "transcript.js"), join(target, "transcript.js"));
}
else writeFileSync(join(target, "diagnostics.js"), "// 진단 빌드가 아니다. 진단 메서드가 없다.\nexport {};\n");

writeFileSync(join(target, ENVIRONMENT), `${JSON.stringify(environment, null, 2)}\n`);

// STAGED 목록의 파일들이 실제로 만들어졌는지 검증.
// 선언과 실제가 갈라지지 않도록 한다.
for (const stagedFile of STAGED.always) {
  const stagedPath = join(target, stagedFile);
  if (!existsSync(stagedPath)) {
    throw new Error(`declared always-staged file not created: ${stagedFile}`);
  }
}
if (diagnostics) {
  for (const stagedFile of STAGED.diagnostics) {
    const stagedPath = join(target, stagedFile);
    if (!existsSync(stagedPath)) {
      throw new Error(`declared diagnostics-staged file not created: ${stagedFile}`);
    }
  }
}
console.log(`staged ${environment.plugins.length} plugins and ${sidecars.size} sidecars into ${target}` +
  (diagnostics ? " with diagnostics" : ""));
