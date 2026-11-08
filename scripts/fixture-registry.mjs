#!/usr/bin/env node
// The fixture registry (docs/spec/plugin-processes.md#verification-boundaries). Packs every fake plugin of e2e/fixtures, a folder that
// holds plugin.json, and releases every fake sidecar of e2e/fixtures/sidecars, a folder that holds sidecar.json, for the current
// platform; then writes the registry files with one pack `fixtures` of every fixture plugin and creates index.json with
// `sok registry build` (docs/spec/cli.md). The core window checks install plugins from this registry. It reads no path outside
// e2e/fixtures and no registry index, and it builds no plugin or sidecar repository.
//
//   node scripts/fixture-registry.mjs --sok <sok executable> --out <registry folder>
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { releasePlatform } from "./platform/platform.js";

/** The folder of the core fixtures. */
export const FIXTURES = fileURLToPath(new URL("../e2e/fixtures/", import.meta.url));
// The folder of the fake sidecars under the fixtures.
const SIDECARS = "sidecars";
// The one pack of the fixture registry.
const PACK = "fixtures";

const read = (path) => JSON.parse(readFileSync(path, "utf8"));

/** Writes value as JSON into path and creates its folder. */
export function writeJson(path, value) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** The address of the package.json repository. It is a string or { url }. */
export function repositoryText(repository) {
  const url = typeof repository === "string" ? repository : repository?.url;
  if (typeof url !== "string" || url === "") throw new Error("package.json repository has no url");
  return url;
}

/** The file name of a sidecar (docs/spec/installation.md#sidecar-release): `scope-name` for `@scope/name`, an unscoped name as it is. */
export function sidecarFileName(name) {
  return name.startsWith("@") ? name.slice(1).replace("/", "-") : name;
}

/**
 * The registry entry of one plugin. pack is the release that the pack returns, and sidecars is the set of the package names of
 * the sidecars of the registry: the index lists only the dependencies on sidecars, and a dependency on a plugin stays in the
 * plugin.json of the release (contract case `cli.registry.checks-plugin-dependencies` of docs/spec/host-contract.md).
 */
export function pluginEntry(manifest, pkg, pack, sidecars) {
  return {
    id: manifest.id, package: pkg.name, name: manifest.name, description: pkg.description, license: pkg.license,
    repository: repositoryText(pkg.repository),
    versions: [{
      version: pkg.version, release: { url: pathToFileURL(pack.release).href, sha256: pack.sha256 },
      // default: the plugin.json of a plugin that uses no sidecar has no dependencies.
      engines: { soksak: pkg.engines?.soksak },
      // default: the plugin.json of a plugin without dependencies has no dependencies.
      sidecars: Object.fromEntries(Object.entries(manifest.dependencies ?? {}).filter(([name]) => sidecars.has(name))),
    }],
  };
}

/** The registry entry of one sidecar. declaration is its sidecar.json, and release is { platform, release, sha256 }. */
export function sidecarEntry(pkg, declaration, release) {
  return {
    name: pkg.name, repository: repositoryText(pkg.repository),
    versions: [{
      version: pkg.version, protocol: declaration.protocol,
      releases: { [release.platform]: { url: pathToFileURL(release.release).href, sha256: release.sha256 } },
    }],
  };
}

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** Writes the pnpm pack file of the plugin folder dir into out (docs/spec/installation.md#plugin-release) and returns it and its sha256. */
export function pnpmPack(dir, out) {
  mkdirSync(out, { recursive: true });
  const { filename } = JSON.parse(execFileSync("pnpm", ["pack", "--json", "--pack-destination", resolve(out)],
    { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }));
  return { release: filename, sha256: sha256(filename) };
}

/**
 * Writes the release of the fake sidecar folder dir for platform into out: the npm pack file of the folder, which keeps the execute
 * bit, named `<file name>-<version>-<platform>.tgz` (docs/spec/installation.md#sidecar-release). Returns it, its sha256 and platform.
 */
export function npmSidecarRelease(dir, out, platform = releasePlatform()) {
  mkdirSync(out, { recursive: true });
  const [{ filename }] = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", resolve(out)],
    { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }));
  const pkg = read(join(dir, "package.json"));
  const release = join(resolve(out), `${sidecarFileName(pkg.name)}-${pkg.version}-${platform}.tgz`);
  renameSync(join(resolve(out), filename), release);
  return { release, sha256: sha256(release), platform };
}

/** Runs `sok registry build` of the folder and returns its JSON result. */
export function registryBuild(binary, folder) {
  return JSON.parse(execFileSync(binary, ["registry", "build", folder], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }));
}

/**
 * The sources of the fixture registry under root: plugins, every folder that holds plugin.json, and sidecars, every folder under
 * root/sidecars that holds sidecar.json; each sorted. A node_modules folder is not searched.
 */
export function fixtureSources(root = FIXTURES) {
  const plugins = [];
  const sidecars = [];
  const sidecarRoot = resolve(root, SIDECARS);
  const visit = (dir) => {
    const entries = readdirSync(dir, { withFileTypes: true });
    const names = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
    if (names.has("plugin.json")) plugins.push(dir);
    const fromSidecars = relative(sidecarRoot, dir);
    if (names.has("sidecar.json") && fromSidecars !== "" && !fromSidecars.startsWith("..") && !isAbsolute(fromSidecars)) sidecars.push(dir);
    for (const entry of entries) if (entry.isDirectory() && entry.name !== "node_modules") visit(join(dir, entry.name));
  };
  visit(resolve(root));
  return { plugins: plugins.sort(), sidecars: sidecars.sort() };
}

/**
 * Writes the fixture registry folder out anew from the fixtures under root and creates index.json; returns the result of the
 * registry build. pack writes a plugin release, release writes a sidecar release, and build runs `sok registry build`.
 */
export function buildFixtureRegistry(binary, out, { root = FIXTURES, pack = pnpmPack, release = npmSidecarRelease, build = registryBuild } = {}) {
  for (const name of ["plugins", "sidecars", "packs", "releases", "revoked.json", "index.json"]) rmSync(join(out, name), { recursive: true, force: true });
  for (const name of ["plugins", "sidecars", "packs"]) mkdirSync(join(out, name), { recursive: true });
  const releases = join(out, "releases");
  const sources = fixtureSources(root);
  const sidecars = new Set();
  for (const dir of sources.sidecars) {
    const pkg = read(join(dir, "package.json"));
    sidecars.add(pkg.name);
    writeJson(join(out, "sidecars", `${sidecarFileName(pkg.name)}.json`), sidecarEntry(pkg, read(join(dir, "sidecar.json")), release(dir, releases)));
  }
  const ids = [];
  for (const dir of sources.plugins) {
    const manifest = read(join(dir, "plugin.json"));
    const entry = pluginEntry(manifest, read(join(dir, "package.json")), pack(dir, releases), sidecars);
    writeJson(join(out, "plugins", `${manifest.id}.json`), entry);
    ids.push(manifest.id);
  }
  writeJson(join(out, "packs", `${PACK}.json`), { name: PACK, description: "Every fake plugin of the core fixtures.", plugins: ids });
  writeJson(join(out, "revoked.json"), { plugins: [], sidecars: [] });
  return build(binary, out);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { sok: { type: "string" }, out: { type: "string" } }, strict: true });
  for (const name of ["sok", "out"]) if (!values[name]) throw new Error(`--${name} is required`);
  const result = buildFixtureRegistry(values.sok, values.out);
  console.log(`Fixture registry: ${result.index} (${result.plugins} plugins, ${result.sidecars} sidecars, ${result.packs} packs)`);
}
