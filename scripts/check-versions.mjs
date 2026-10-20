// Checks that the versions declared by the workspace manifests equal the current release version.
//
// Reads the top-level "version" of package.json, plugin.json, sidecar.json, and tauri.conf.json tracked by Git, the [package] version of
// Cargo.toml, the `const CoreVersion` declared by version.go of a Go package without a manifest,
// CFBundleShortVersionString and CFBundleVersion of the Info.plist of an application bundle, and the `Version:` line of a Makefile that writes a pkg-config file.
// Workspace files that declare no version (the root package.json, the Cargo workspace, other Makefiles) are
// not checked. RELEASE of this file is the single source of all declared versions.
//
//   node scripts/check-versions.mjs
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const RELEASE = "0.0.19";
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const JSON_MANIFESTS = new Set(["package.json", "plugin.json", "sidecar.json", "tauri.conf.json"]);

/** The version declared in the [package] section of Cargo.toml. undefined if absent. */
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

/** The CoreVersion declared by Go version.go. undefined if absent. */
export function goCoreVersion(text) {
  return text.match(/^const CoreVersion = "([^"]*)"$/m)?.[1];
}

/** The applicationVersion declared by Go host.go. It is the application version used by the endpoint. undefined if absent. */
export function goApplicationVersion(text) {
  return text.match(/^\s*(?:var\s+)?applicationVersion\s*=\s*"([^"]*)"\s*$/m)?.[1];
}

/** The string that key declares in Info.plist. undefined if absent. */
export function plistString(text, key) {
  return text.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`))?.[1];
}

/** The `Version:` line of the pkg-config file that a Makefile writes. undefined if absent. */
export function pkgConfigVersion(text) {
  return text.match(/'Version: ([^']*)'/)?.[1];
}

/** files is a list of { path, text }. Returns one error for each file whose declared version differs from the release. */
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
