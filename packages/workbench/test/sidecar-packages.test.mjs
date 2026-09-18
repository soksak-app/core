// 빌드할 사이드카 목록은 선언에서 나온다. 애플리케이션의 environment.json 이 플러그인을 정하고,
// 각 plugin.json 이 사이드카를 정하며, 각 sidecar.json 의 helpers 가 그 사이드카가 옆에 두어야
// 하는 실행 파일을 정한다. 목록을 손으로 적으면 선언과 빌드가 갈라진다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { packageFolders, sidecarPackages } from "../../../scripts/sidecar-packages.mjs";

const root = new URL("../../../", import.meta.url);

const read = (url) => JSON.parse(readFileSync(url, "utf8"));

/** 애플리케이션이 선언한 플러그인들이 선언한 사이드카 이름. */
function declared() {
  const dirs = packageFolders(root);
  const names = new Set();
  for (const app of ["wailsv3", "tauriv2"]) {
    for (const plugin of read(new URL(`apps/${app}/environment.json`, root)).plugins) {
      for (const sidecar of read(new URL("plugin.json", dirs.get(plugin))).sidecars ?? []) names.add(sidecar);
    }
  }
  return [...names].sort();
}

test("the sidecar build list is what the applications declare", () => {
  assert.deepEqual(sidecarPackages(root).sort(), declared());
});

test("the list carries the helpers a sidecar declares", () => {
  const found = sidecarPackages(root, {
    "@soksak/sidecar-a": { helpers: [{ package: "@soksak/sidecar-b", executable: "build/b" }] },
    "@soksak/sidecar-b": {},
  }, ["@soksak/sidecar-a"]);
  assert.deepEqual(found.sort(), ["@soksak/sidecar-a", "@soksak/sidecar-b"]);
});

test("a helper chain is followed to its end and a cycle ends", () => {
  const found = sidecarPackages(root, {
    "@soksak/sidecar-a": { helpers: [{ package: "@soksak/sidecar-b", executable: "build/b" }] },
    "@soksak/sidecar-b": { helpers: [{ package: "@soksak/sidecar-c", executable: "build/c" }] },
    "@soksak/sidecar-c": { helpers: [{ package: "@soksak/sidecar-a", executable: "build/a" }] },
  }, ["@soksak/sidecar-a"]);
  assert.deepEqual(found.sort(),
    ["@soksak/sidecar-a", "@soksak/sidecar-b", "@soksak/sidecar-c"]);
});
