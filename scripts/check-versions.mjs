// 작업공간 manifest 가 선언한 버전이 현재 릴리스 버전과 같은지 검사한다.
//
// Git 이 추적하는 package.json, plugin.json, sidecar.json, tauri.conf.json 의 최상위 "version" 과
// Cargo.toml 의 [package] version, manifest 가 없는 Go 패키지의 version.go 가 선언한 `const CoreVersion`,
// 애플리케이션 번들 Info.plist 의 CFBundleShortVersionString 과 CFBundleVersion, pkg-config 파일을 쓰는 Makefile 의
// `Version:` 줄을 읽는다. 버전을 선언하지 않은 작업공간 파일(루트 package.json, Cargo 작업공간, 다른 Makefile)은
// 검사 대상이 아니다. 이 파일의 RELEASE 가 모든 선언 버전의 단일 원천이다.
//
//   node scripts/check-versions.mjs
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const RELEASE = "0.0.7";
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const JSON_MANIFESTS = new Set(["package.json", "plugin.json", "sidecar.json", "tauri.conf.json"]);

/** Cargo.toml 의 [package] 절에 선언된 version. 없으면 undefined. */
export function cargoPackageVersion(text) {
  let inPackage = false;
  for (const line of text.split("\n")) {
    const section = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (section) {
      inPackage = section[1] === "package";
      continue;
    }
    const version = inPackage && line.match(/^\s*version\s*=\s*"([^"]*)"\s*$/);
    if (version) return version[1];
  }
  return undefined;
}

/** Go version.go 가 선언한 CoreVersion. 없으면 undefined. */
export function goCoreVersion(text) {
  return text.match(/^const CoreVersion = "([^"]*)"$/m)?.[1];
}

/** Go host.go 가 선언한 applicationVersion. 엔드포인트에 쓰는 애플리케이션 버전이다. 없으면 undefined. */
export function goApplicationVersion(text) {
  return text.match(/^\s*(?:var\s+)?applicationVersion\s*=\s*"([^"]*)"\s*$/m)?.[1];
}

/** Info.plist 의 key 가 선언한 문자열. 없으면 undefined. */
export function plistString(text, key) {
  return text.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`))?.[1];
}

/** Makefile 이 쓰는 pkg-config 의 `Version:` 줄. 없으면 undefined. */
export function pkgConfigVersion(text) {
  return text.match(/'Version: ([^']*)'/)?.[1];
}

/** files 는 { path, text } 목록이다. 선언된 버전이 release 와 다른 파일마다 오류 하나를 반환한다. */
export function auditVersions(files, release = RELEASE) {
  const errors = [];
  for (const { path, text } of files) {
    const name = basename(path);
    let version;
    if (JSON_MANIFESTS.has(name)) {
      let value;
      try {
        value = JSON.parse(text);
      } catch (error) {
        errors.push(`${path}: invalid JSON (${error.message})`);
        continue;
      }
      version = value?.version;
    } else if (name === "Cargo.toml") {
      version = cargoPackageVersion(text);
    } else if (name === "host.go") {
      version = goApplicationVersion(text);
    } else if (name === "version.go") {
      version = goCoreVersion(text);
      if (version === undefined) errors.push(`${path}: const CoreVersion is not declared`);
    } else if (name === "Info.plist") {
      for (const key of ["CFBundleShortVersionString", "CFBundleVersion"]) {
        const value = plistString(text, key);
        if (value === undefined) errors.push(`${path}: ${key} is not declared`);
        else if (value !== release) errors.push(`${path}: ${key} ${JSON.stringify(value)} must be ${release}`);
      }
      continue;
    } else if (name === "Makefile") {
      version = pkgConfigVersion(text);
    } else {
      continue;
    }
    if (version !== undefined && version !== release) {
      errors.push(`${path}: version ${JSON.stringify(version)} must be ${release}`);
    }
  }
  return errors;
}

export function workspaceManifests(root = ROOT) {
  const others = ["Cargo.toml", "version.go", "host.go", "Info.plist", "Makefile"];
  const names = [...JSON_MANIFESTS, ...others].map((name) => `*${name}`);
  return execFileSync("git", ["ls-files", "--", ...names], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((path) => path && (JSON_MANIFESTS.has(basename(path)) || others.includes(basename(path))))
    .map((path) => ({ path, text: readFileSync(join(root, path), "utf8") }));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const errors = auditVersions(workspaceManifests());
  if (errors.length) {
    console.error(`Version checks failed:\n${errors.map((error) => `- ${error}`).join("\n")}`);
    process.exit(1);
  }
  console.log(`Version checks passed: every declared workspace version is ${RELEASE}`);
}
