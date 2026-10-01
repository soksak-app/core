#!/usr/bin/env node
// 빌드할 사이드카 패키지 목록. scripts/workspace-registry.json 이 workspace registry 에 넣을 플러그인을 선언하고,
// 각 plugin.json 이 그 플러그인이 쓰는 사이드카를 정하며, 각 sidecar.json 의 helpers 가 그 사이드카가 실행 파일 옆에
// 두어야 하는 다른 패키지의 실행 파일을 정한다. 목록을 손으로 적으면 선언과 빌드가 갈라지므로 선언에서 유도한다.
//
// 인자 없이 실행하면 pnpm 필터(`-F <이름> …`)를 stdout 에 쓴다. Makefile 이 그대로 쓴다.
import { readFileSync, readdirSync } from "node:fs";

const PLACES = ["plugins", "sidecars"];

const read = (url) => JSON.parse(readFileSync(url, "utf8"));

/** place 아래의 디렉터리 이름. package.json 이 없는 디렉터리도 포함한다(호출자가 거른다). */
function folders(root, place) {
  try {
    return readdirSync(new URL(`${place}/`, root), { withFileTypes: true })
      .filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** 워크스페이스 안의 패키지 이름 → 디렉터리 URL. 이름 규칙이 아니라 package.json 의 name 으로 찾는다. */
export function packageFolders(root) {
  const found = new Map();
  for (const place of PLACES) {
    for (const name of folders(root, place)) {
      const dir = new URL(`${place}/${name}/`, root);
      try {
        found.set(read(new URL("package.json", dir)).name, dir);
      } catch {} // package.json 이 없으면 패키지가 아니다.
    }
  }
  return found;
}

/** scripts/workspace-registry.json 이 선언한 플러그인 패키지 이름. */
export function workspacePlugins(root = new URL("../", import.meta.url)) {
  return read(new URL("scripts/workspace-registry.json", root)).plugins;
}

/** 워크스페이스의 플러그인이 선언한 사이드카 이름. */
function declaredSidecars(root, dirs) {
  const names = [];
  for (const plugin of workspacePlugins(root)) {
    const dir = dirs.get(plugin);
    if (!dir) throw new Error(`scripts/workspace-registry.json: no package named ${plugin}`);
    // 기본값: sidecars 는 plugin.json 의 선택 필드이며 사이드카를 쓰지 않는 플러그인에는 없다.
    for (const sidecar of read(new URL("plugin.json", dir)).sidecars ?? []) names.push(sidecar);
  }
  return names;
}

/**
 * 빌드할 사이드카 패키지 이름. manifests 와 seeds 를 주면 저장소를 읽지 않는다(검사용).
 * manifests 는 이름 → sidecar.json 의 내용이고, seeds 는 시작 이름들이다.
 */
export function sidecarPackages(root = new URL("../", import.meta.url), manifests = null, seeds = null) {
  const dirs = manifests ? null : packageFolders(root);
  const manifestOf = (name) => {
    if (manifests) return manifests[name] ?? {};
    const dir = dirs.get(name);
    if (!dir) throw new Error(`no package named ${name}`);
    try {
      return read(new URL("sidecar.json", dir));
    } catch {
      return {}; // 실행 파일이 없는 라이브러리·헬퍼 패키지도 빌드 대상이다.
    }
  };
  const pending = [...(seeds ?? declaredSidecars(root, dirs))];
  const found = new Set();
  while (pending.length > 0) {
    const name = pending.pop();
    if (found.has(name)) continue; // 헬퍼가 서로를 가리켜도 여기서 끝난다.
    found.add(name);
    for (const helper of manifestOf(name).helpers ?? []) pending.push(helper.package);
  }
  return [...found];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(`${sidecarPackages().map((name) => `-F ${name}`).join(" ")}\n`);
}
