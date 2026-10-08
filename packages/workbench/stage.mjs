#!/usr/bin/env node
// 애플리케이션의 프런트엔드를 한 디렉터리에 배치한다(docs/spec/plugins.md 의 스테이징 배치).
//
//   soksak-stage <출력 디렉터리> [--diagnostics] [--installed <설정 디렉터리>]
//
// 현재 디렉터리의 애플리케이션 패키지에서 environment.json 을 읽는다. 패키지 위치는
// Node 모듈 해석으로 찾는다. 파일은 복사만 하고 내용을 바꾸지 않는다.
//
//   <출력>/                        워크벤치 패키지의 files
//   <출력>/modules/<패키지 이름>/   soksak, plugin-api 패키지의 files
//   <출력>/runtime/                 environment.json 의 runtime 디렉터리
//   <출력>/environment.json         애플리케이션의 environment.json
//   <출력>/diagnostics.js           --diagnostics 이면 워크벤치의 observe.js(페이지 진단 메서드),
//                                  아니면 release-diagnostics.js(빈 모듈). 진단 코드는 진단 빌드에만
//                                  들어간다
//   <출력>/transcript.js 등          --diagnostics 이면 진단 모듈이 쓰는 파일(staged.js 의 STAGED.diagnostics)
//
// 플러그인은 bundle 에 넣지 않는다. 네이티브 host 는 설정 디렉터리에 설치된 플러그인을 제공한다
// (docs/spec/installation.md). host 가 없는 애플리케이션(브라우저 예제)은 --installed 로 설정 디렉터리를 주며,
// 그러면 host 가 제공할 문서를 쓴다.
//
//   <출력>/installed-plugins.json   켜진 설치 플러그인 목록과 manifest. diagnostics 는 --diagnostics 일 때만 담는다
//   <출력>/modules/<플러그인>/       켜진 각 설치 플러그인의 파일
//   <출력>/shared/<id>.<point>/      the shared modules of extension points

import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { STAGED } from "./staged.js";
import {
  ENVIRONMENT, INSTALLED_PLUGINS, RUNTIME, modulePath, validateEnvironment, validateInstalledPlugins,
} from "@soksak/plugin-api";

const USAGE = "usage: soksak-stage <output directory> [--diagnostics] [--installed <configuration directory>]";
const args = process.argv.slice(2);
const [out, ...rest] = args;
let installedDirectory;
let diagnostics = false;
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === "--installed" && rest[i + 1] && installedDirectory === undefined) installedDirectory = rest[++i];
  else if (rest[i] === "--diagnostics" && !diagnostics) diagnostics = true;
  else { console.error(USAGE); process.exit(2); }
}
if (!out || out.startsWith("--")) {
  console.error(USAGE);
  process.exit(2);
}

const app = process.cwd();
const target = resolve(app, out);
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

/**
 * 설정 디렉터리의 plugins/installed.json 에서 켜진 플러그인을 id 순서로 읽는다. 형식은 command line sok 이 쓰고
 * 검사한다(docs/spec/installation.md). 여기서는 쓰는 필드가 있는지만 보고, 없으면 실패한다.
 */
function enabledInstalledPlugins(configuration) {
  const file = join(configuration, "plugins", "installed.json");
  if (!existsSync(file)) throw new Error(`${file} does not exist; install plugins with sok first`);
  const installed = readJson(file);
  // 형식 1 파일은 sok 이나 애플리케이션이 읽을 때 형식 2 로 바꾼다.
  if (installed?.format !== 2 || typeof installed.plugins !== "object" || installed.plugins === null) {
    throw new Error(`${file}: expected format 2 with plugins`);
  }
  return Object.entries(installed.plugins)
    .filter(([, plugin]) => plugin.enabled === true)
    .map(([id, plugin]) => {
      if (typeof plugin.package !== "string" || typeof plugin.version !== "string" || typeof plugin.path !== "string") {
        throw new Error(`${file}: plugin ${id} requires package, version and path`);
      }
      // 파일은 설치가 설정 디렉터리에 대한 상대 경로로 기록한 폴더에서만 읽는다(docs/spec/installation.md).
      return { id, package: plugin.package, version: plugin.version, dir: join(configuration, plugin.path) };
    })
    .sort((a, b) => (a.id < b.id ? -1 : 1));
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
cpSync(runtime, join(target, RUNTIME), { recursive: true });
copyFileSync(join(workbench, diagnostics ? "observe.js" : "release-diagnostics.js"), join(target, "diagnostics.js"));
if (diagnostics) {
  for (const file of STAGED.diagnostics) copyFileSync(join(workbench, file), join(target, file));
}
writeFileSync(join(target, ENVIRONMENT), `${JSON.stringify(environment, null, 2)}\n`);

let plugins = [];
if (installedDirectory) {
  plugins = enabledInstalledPlugins(resolve(app, installedDirectory));
  const document = [];
  for (const plugin of plugins) {
    cpSync(plugin.dir, join(target, modulePath(plugin.package, "")), { recursive: true });
    const entry = { id: plugin.id, package: plugin.package, version: plugin.version, manifest: readJson(join(plugin.dir, "plugin.json")) };
    // Places the shared modules of extension points where a host serves /shared/<plugin id>.<point>/<specifier>.js (docs/spec/installation.md).
    // default: extends is an optional field of plugin.json; a plugin without it shares no module.
    for (const [point, declaration] of Object.entries(entry.manifest.extends ?? {})) {
      // default: a point without modules shares no module.
      for (const [specifier, path] of Object.entries(declaration.modules ?? {})) {
        const shared = join(target, "shared", `${plugin.id}.${point}`, `${specifier}.js`);
        mkdirSync(dirname(shared), { recursive: true });
        copyFileSync(join(plugin.dir, path), shared);
      }
    }
    const declared = join(plugin.dir, "diagnostics.json");
    // 기본값: diagnostics.json 이 없는 플러그인은 진단 선언이 없다.
    if (diagnostics && existsSync(declared)) entry.diagnostics = readJson(declared);
    document.push(entry);
  }
  validateInstalledPlugins({ plugins: document });
  writeFileSync(join(target, INSTALLED_PLUGINS), `${JSON.stringify({ plugins: document })}\n`);
}

// STAGED 목록의 파일들이 실제로 만들어졌는지 검증.
// 선언과 실제가 갈라지지 않도록 한다.
for (const stagedFile of STAGED.always) {
  if (!existsSync(join(target, stagedFile))) throw new Error(`declared always-staged file not created: ${stagedFile}`);
}
if (diagnostics) {
  for (const stagedFile of STAGED.diagnostics) {
    if (!existsSync(join(target, stagedFile))) throw new Error(`declared diagnostics-staged file not created: ${stagedFile}`);
  }
}
console.log(`staged the workbench into ${target}${installedDirectory ? ` with ${plugins.length} installed plugins` : ""}` +
  (diagnostics ? " with diagnostics" : ""));
