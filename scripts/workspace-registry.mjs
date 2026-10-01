#!/usr/bin/env node
// 워크스페이스 registry. scripts/workspace-registry.json 이 선언한 plugin 을 pack 하고, 그 plugin.json 이 쓰는
// sidecar 를 현재 플랫폼으로 release 한 뒤, 그 결과로 registry 파일을 쓰고 `sok registry build` 로 index.json 을
// 만든다(docs/spec/cli.md). build 와 window check 는 이 registry 에서 plugin 을 설치한다.
//
//   node scripts/workspace-registry.mjs --sok <sok 실행 파일> --out <registry 폴더> [--diagnostics]
//
// --diagnostics 는 plugin 을 진단 package 로 pack 한다. 진단 build 와 window check 가 이 registry 에서 설치한다.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { packageFolders, workspacePlugins } from "./sidecar-packages.mjs";

const ROOT = new URL("../", import.meta.url);

const read = (url) => JSON.parse(readFileSync(url, "utf8"));

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

function write(path, value) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** registry 폴더를 새로 쓰고 index.json 을 만든다. 출력 폴더의 이전 항목은 지운다. */
export function buildWorkspaceRegistry(binary, out, diagnostics, root = ROOT) {
  const dirs = packageFolders(root);
  const releases = join(out, "releases");
  for (const folder of ["plugins", "sidecars", "packs", "releases"]) rmSync(join(out, folder), { recursive: true, force: true });
  const sidecars = new Map();
  for (const name of workspacePlugins(root)) {
    const dir = dirs.get(name);
    if (!dir) throw new Error(`no package named ${name}`);
    const manifest = read(new URL("plugin.json", dir));
    const pkg = read(new URL("package.json", dir));
    const pack = sok(binary, ["plugin", "pack", fileURLToPath(dir), releases, ...(diagnostics ? ["--diagnostics"] : [])]);
    write(join(out, "plugins", `${manifest.id}.json`), pluginEntry(manifest, pkg, pack));
    // 기본값: sidecar 를 쓰지 않는 plugin 의 plugin.json 에는 sidecars 가 없다.
    for (const sidecar of manifest.sidecars ?? []) sidecars.set(sidecar, dirs.get(sidecar));
  }
  for (const [name, dir] of sidecars) {
    if (!dir) throw new Error(`no package named ${name}`);
    const release = sok(binary, ["sidecar", "release", fileURLToPath(dir), releases]);
    const file = name.startsWith("@") ? name.slice(1).replace("/", "-") : name;
    write(join(out, "sidecars", `${file}.json`), sidecarEntry(read(new URL("package.json", dir)), read(new URL("sidecar.json", dir)), release));
  }
  for (const pack of read(new URL("scripts/workspace-registry.json", root)).packs) write(join(out, "packs", `${pack.name}.json`), pack);
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
