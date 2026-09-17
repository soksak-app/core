#!/usr/bin/env node
// 애플리케이션의 프런트엔드를 한 디렉터리에 배치한다.
//
//   soksak-stage <출력 디렉터리> [--executables <디렉터리>]
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
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ENVIRONMENT, MANIFEST, RUNTIME, SIDECAR, modulePath, validateEnvironment, validateManifest, validateSidecar,
} from "@soksak/plugin-api";

const args = process.argv.slice(2);
const [out] = args;
const executables = args[1] === "--executables" ? args[2] : undefined;
if (!out || !(args.length === 1 || (args.length === 3 && executables))) {
  console.error("usage: soksak-stage <output directory> [--executables <directory>]");
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
    const built = join(sidecarDir, declared.executable);
    if (!existsSync(built)) throw new Error(`${sidecar}: ${declared.executable} is not built`);
    copyFileSync(built, join(executableTarget, basename(declared.executable)));
  }
}
cpSync(runtime, join(target, RUNTIME), { recursive: true });
writeFileSync(join(target, ENVIRONMENT), `${JSON.stringify(environment, null, 2)}\n`);
console.log(`staged ${environment.plugins.length} plugins and ${sidecars.size} sidecars into ${target}`);
