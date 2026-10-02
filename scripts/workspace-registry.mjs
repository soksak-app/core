#!/usr/bin/env node
// 워크스페이스 registry(docs/spec/plugins.md#repositories). scripts/workspace-registry.json 이 core checkout 기준 상대
// 폴더로 선언한 plugin repository 를 pack 하고, 그 plugin 이 쓰는 sidecar 를 선언된 sidecar repository 에서 build 해
// 현재 플랫폼으로 release 한 뒤, 그 결과로 registry 파일을 쓰고 `sok registry build` 로 index.json 을 만든다
// (docs/spec/cli.md). build 와 window check 는 이 registry 에서 plugin 을 설치한다. Network 는 쓰지 않는다.
//
//   node scripts/workspace-registry.mjs --sok <sok 실행 파일> --out <registry 폴더> [--diagnostics]
//
// --diagnostics 는 plugin 을 진단 package 로 pack 한다. 진단 build 와 window check 가 이 registry 에서 설치한다.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = new URL("../", import.meta.url);
const DECLARATION = "scripts/workspace-registry.json";

const read = (url) => JSON.parse(readFileSync(url, "utf8"));

const folderText = (value) => typeof value === "string" && value !== "" && !value.startsWith("/");

/**
 * scripts/workspace-registry.json 의 선언을 검사한다. plugins 는 plugin repository 폴더, sidecars 는
 * {repository, folder}(folder 는 repository 안에서 sidecar.json 을 가진 폴더), packs 는 registry pack 항목이다.
 * 폴더는 core checkout 기준 상대 경로다.
 */
export function checkDeclaration(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${DECLARATION}: expected an object`);
  const keys = Object.keys(value).sort().join();
  if (keys !== "packs,plugins,sidecars") throw new Error(`${DECLARATION}: expected the keys packs, plugins and sidecars`);
  if (!Array.isArray(value.plugins) || !value.plugins.every(folderText)) {
    throw new Error(`${DECLARATION}: plugins must be relative folders`);
  }
  if (new Set(value.plugins).size !== value.plugins.length) throw new Error(`${DECLARATION}: a plugin folder is repeated`);
  if (!Array.isArray(value.sidecars) || !value.sidecars.every((item) => item && folderText(item.repository) && folderText(item.folder)
    && Object.keys(item).sort().join() === "folder,repository")) {
    throw new Error(`${DECLARATION}: sidecars must be { repository, folder } with relative folders`);
  }
  if (!Array.isArray(value.packs)) throw new Error(`${DECLARATION}: packs must be a list`);
  return value;
}

/** package.json repository 의 주소. 문자열이거나 { url } 이다. */
export function repositoryText(repository) {
  const url = typeof repository === "string" ? repository : repository?.url;
  if (typeof url !== "string" || url === "") throw new Error("package.json repository has no url");
  return url;
}

/** plugin 하나의 registry 항목. pack 은 `sok plugin pack` 의 출력이다. */
export function pluginEntry(manifest, pkg, pack) {
  return {
    id: manifest.id, package: pkg.name, name: manifest.name, description: pkg.description, license: pkg.license,
    repository: repositoryText(pkg.repository),
    versions: [{
      version: pkg.version, package: { url: pathToFileURL(pack.archive).href, sha256: pack.sha256 },
      // 기본값: sidecar 를 쓰지 않는 plugin 은 package.json 에 soksak 이 없고 sidecar 범위도 없다.
      engines: { soksak: pkg.engines?.soksak }, sidecars: pkg.soksak?.sidecars ?? {},
    }],
  };
}

/** sidecar 하나의 registry 항목. release 는 `sok sidecar release` 의 출력이다. */
export function sidecarEntry(pkg, declaration, release) {
  return {
    name: pkg.name, repository: repositoryText(pkg.repository),
    versions: [{
      version: pkg.version, protocol: declaration.protocol,
      assets: { [release.platform]: { url: pathToFileURL(release.archive).href, sha256: release.sha256 } },
    }],
  };
}

function sok(binary, args) {
  return JSON.parse(execFileSync(binary, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }));
}

/** sidecar repository 의 `make build` 가 sidecar.json 이 가리키는 실행 파일을 쓴다. */
function buildSidecar(repository) {
  execFileSync("make", ["-C", repository, "build"], { stdio: ["ignore", "inherit", "inherit"] });
}

function write(path, value) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** registry 폴더를 새로 쓰고 index.json 을 만든다. 출력 폴더의 이전 항목은 지운다. */
export function buildWorkspaceRegistry(binary, out, diagnostics, root = ROOT) {
  const declaration = checkDeclaration(read(new URL(DECLARATION, root)));
  const folder = (relative) => fileURLToPath(new URL(relative.endsWith("/") ? relative : `${relative}/`, root));
  // sidecar package 이름 → 선언된 repository 와 sidecar 폴더.
  const declared = new Map();
  for (const item of declaration.sidecars) {
    const repository = folder(item.repository);
    const sidecar = join(repository, item.folder);
    declared.set(read(pathToFileURL(join(sidecar, "package.json"))).name, { repository, sidecar });
  }
  const releases = join(out, "releases");
  for (const name of ["plugins", "sidecars", "packs", "releases"]) rmSync(join(out, name), { recursive: true, force: true });
  const used = new Set();
  for (const relative of declaration.plugins) {
    const dir = folder(relative);
    const manifest = read(pathToFileURL(join(dir, "plugin.json")));
    const pkg = read(pathToFileURL(join(dir, "package.json")));
    const pack = sok(binary, ["plugin", "pack", dir, releases, ...(diagnostics ? ["--diagnostics"] : [])]);
    write(join(out, "plugins", `${manifest.id}.json`), pluginEntry(manifest, pkg, pack));
    // 기본값: sidecar 를 쓰지 않는 plugin 의 package.json 에는 soksak.sidecars 가 없다.
    for (const name of Object.keys(pkg.soksak?.sidecars ?? {})) {
      if (!declared.has(name)) throw new Error(`${DECLARATION}: plugin ${manifest.id} uses ${name}, which no declared sidecar folder holds`);
      used.add(name);
    }
  }
  const built = new Set();
  for (const name of used) {
    const { repository, sidecar } = declared.get(name);
    if (!built.has(repository)) {
      buildSidecar(repository);
      built.add(repository);
    }
    const release = sok(binary, ["sidecar", "release", sidecar, releases]);
    const file = name.startsWith("@") ? name.slice(1).replace("/", "-") : name;
    write(join(out, "sidecars", `${file}.json`),
      sidecarEntry(read(pathToFileURL(join(sidecar, "package.json"))), read(pathToFileURL(join(sidecar, "sidecar.json"))), release));
  }
  for (const pack of declaration.packs) write(join(out, "packs", `${pack.name}.json`), pack);
  write(join(out, "revoked.json"), { plugins: [], sidecars: [] });
  return sok(binary, ["registry", "build", out]);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const value = (flag) => {
    const index = args.indexOf(flag);
    if (index < 0 || index + 1 >= args.length) throw new Error(`${flag} is required`);
    return args[index + 1];
  };
  const result = buildWorkspaceRegistry(value("--sok"), value("--out"), args.includes("--diagnostics"));
  console.log(`Workspace registry: ${result.index} (${result.plugins} plugins, ${result.sidecars} sidecars, ${result.packs} packs)`);
}
