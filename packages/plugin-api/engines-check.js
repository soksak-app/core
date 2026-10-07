#!/usr/bin/env node
// plugin 이 빌드에 쓰는 core release 를 engines.soksak 으로 선언했는지 검사한다(docs/spec/installation.md).
//
// 규칙: plugin repository 의 package.json engines.soksak 은 `*`(`>=0.0.0`, 모든 core version) 이거나 이 @soksak/plugin-api 의
// version 에 대한 `^<version>` 이다.
//
//   soksak-engines [plugin repository]
import { readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** 이 @soksak/plugin-api 의 version. plugin 이 빌드에 쓰는 core release 다. */
export function pluginApiVersion() {
  return JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;
}

/** plugin package.json 의 engines.soksak 이 `*` 나 `^<version>` 이 아니면 오류 하나를 돌려준다. */
export function enginesErrors(pkg, version) {
  const range = pkg?.engines?.soksak;
  return range === "*" || range === `^${version}` ? []
    : [`package.json: engines.soksak ${range} must be * or ^${version}, the @soksak/plugin-api version`];
}

// package manager 는 package 를 link 로 두므로 시작한 경로를 풀어서 이 module 과 비교한다.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  // 기본값: 사용법의 [plugin repository] 를 생략하면 현재 폴더의 plugin repository 를 검사한다.
  const repository = resolve(process.argv[2] ?? ".");
  const version = pluginApiVersion();
  const errors = enginesErrors(JSON.parse(readFileSync(join(repository, "package.json"), "utf8")), version);
  if (errors.length) {
    process.stderr.write(errors.map((error) => `${error}\n`).join(""));
    process.exit(1);
  }
  process.stdout.write(`Engines check passed: engines.soksak is ^${version}\n`);
}
