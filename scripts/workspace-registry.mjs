#!/usr/bin/env node
// The workspace registry (docs/spec/plugins.md#repositories). Packs the plugin repositories that scripts/workspace-registry.json declares as folders
// relative to the core checkout with their `make pack`, releases every declared sidecar for the current platform with the
// `make release` of its repository, then writes the registry files from the result and creates index.json with `sok registry build`
// (docs/spec/cli.md). Builds and window checks install plugins from this registry. It uses no network but the read of --plugins public.
//
//   node scripts/workspace-registry.mjs --sok <sok executable> --out <registry folder> [--sidecars diagnostic]
//   node scripts/workspace-registry.mjs --sok <sok executable> --out <registry folder> --sidecars diagnostic --plugins public
//     --sidecar-registry <registry folder of --sidecars diagnostic> --public-index <index URL of the public registry>
//   node scripts/workspace-registry.mjs --install
//
// --sidecars diagnostic runs `make release PROFILE=release FEATURES=diagnostics` in every sidecar repository: a repository whose
// make release takes PROFILE and FEATURES builds the release profile with its feature diagnostics, and a repository whose make
// release takes neither builds as it always does. Only this run writes sidecar-revisions.json beside index.json, the revision of each
// sidecar repository that it built and whether the working tree held changes outside it, which the three-host benchmark compares
// (docs/operations/examples.md); the default run removes an earlier record and reads no Git metadata of the linked repositories.
// --plugins public packs no plugin and builds no sidecar: it reads the index of the public registry (docs/spec/registry.md), the
// one network read of this script, and writes an index of its plugins beside the sidecar releases of the --sidecars diagnostic run
// in --sidecar-registry.
// --install runs `make install`, the installation stage, once in every declared plugin and sidecar repository.
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { compareVersions, satisfies } from "../packages/workbench/version-range.js";

const ROOT = new URL("../", import.meta.url);
const DECLARATION = "scripts/workspace-registry.json";
// The record of the sidecar sources of a --sidecars diagnostic run, beside index.json.
const REVISIONS = "sidecar-revisions.json";
// The make variables of each sidecar release of --sidecars diagnostic.
const DIAGNOSTIC_RELEASE = ["PROFILE=release", "FEATURES=diagnostics"];
const DIAGNOSTIC_RUN = "make registry SIDECARS=diagnostic";

const read = (url) => JSON.parse(readFileSync(url, "utf8"));

const folderText = (value) => typeof value === "string" && value !== "" && !value.startsWith("/");

/**
 * Checks the declarations of scripts/workspace-registry.json. plugins are {repository, id} (id is the id of the plugin.json of
 * the repository, which make boundaries reads without the repository), sidecars are {repository, folder} (folder is the folder
 * in the repository that holds sidecar.json), and packs are registry pack entries. Folders are paths relative to the core checkout.
 */
export function checkDeclaration(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${DECLARATION}: expected an object`);
  const keys = Object.keys(value).sort().join();
  if (keys !== "packs,plugins,sidecars") throw new Error(`${DECLARATION}: expected the keys packs, plugins and sidecars`);
  if (!Array.isArray(value.plugins) || !value.plugins.every((item) => item && folderText(item.repository)
    && typeof item.id === "string" && item.id !== "" && Object.keys(item).sort().join() === "id,repository")) {
    throw new Error(`${DECLARATION}: plugins must be { repository, id } with a relative folder and a plugin id`);
  }
  if (new Set(value.plugins.map((item) => item.repository)).size !== value.plugins.length) {
    throw new Error(`${DECLARATION}: a plugin folder is repeated`);
  }
  if (new Set(value.plugins.map((item) => item.id)).size !== value.plugins.length) throw new Error(`${DECLARATION}: a plugin id is repeated`);
  if (!Array.isArray(value.sidecars) || !value.sidecars.every((item) => item && folderText(item.repository) && folderText(item.folder)
    && Object.keys(item).sort().join() === "folder,repository")) {
    throw new Error(`${DECLARATION}: sidecars must be { repository, folder } with relative folders`);
  }
  if (!Array.isArray(value.packs)) throw new Error(`${DECLARATION}: packs must be a list`);
  return value;
}

/**
 * The folder of a declared repository. scripts/workspace-registry.json declares repositories as siblings of the main checkout
 * (docs/spec/plugins.md#repositories). A worktree under <main>/.claude/worktrees/ has the same declarations, but its own
 * folder is three levels deeper, so the declared folders resolve from the main checkout. The main checkout is the parent of
 * the git common directory, which is <main>/.git for the main checkout and for every worktree of it.
 * commonDir is the output of `git rev-parse --path-format=absolute --git-common-dir`.
 */
export function repositoryFolder(relative, commonDir) {
  return resolve(dirname(commonDir), relative);
}

/** The git common directory of the checkout that holds dir. Every worktree of a repository has the same common directory. */
export function gitCommonDir(dir) {
  return execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

/** The address of the package.json repository. It is a string or { url }. */
export function repositoryText(repository) {
  const url = typeof repository === "string" ? repository : repository?.url;
  if (typeof url !== "string" || url === "") throw new Error("package.json repository has no url");
  return url;
}

/**
 * The registry entry of one plugin. pack is the release that packPlugin returns, and sidecars is the set of the package names of
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

/** The registry entry of one sidecar. release is the result of releaseSidecar. */
export function sidecarEntry(pkg, declaration, release) {
  return {
    name: pkg.name, repository: repositoryText(pkg.repository),
    versions: [{
      version: pkg.version, protocol: declaration.protocol,
      releases: { [release.platform]: { url: pathToFileURL(release.release).href, sha256: release.sha256 } },
    }],
  };
}

function sok(binary, args) {
  return JSON.parse(execFileSync(binary, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }));
}

/**
 * Runs `make <target> OUT=<folder> <variables>` of a repository, which writes one release into the folder, and returns the release
 * that the target added and its sha256; a target that adds no file or more than one file is an error.
 */
function repositoryRelease(repository, target, out, variables = []) {
  // make -C runs the target in the repository, so the path that it receives is absolute.
  out = resolve(out);
  mkdirSync(out, { recursive: true });
  const before = new Set(readdirSync(out));
  execFileSync("make", ["-C", repository, target, `OUT=${out}`, ...variables], { stdio: ["ignore", "inherit", "inherit"] });
  const added = readdirSync(out).filter((name) => !before.has(name));
  if (added.length !== 1) throw new Error(`make ${target} of ${repository} wrote ${added.length} new files into ${out}; expected 1`);
  const release = join(out, added[0]);
  return { release, sha256: createHash("sha256").update(readFileSync(release)).digest("hex") };
}

/**
 * `make pack OUT=<folder>` of the plugin repository writes its release, the pnpm pack file of the plugin
 * (docs/spec/installation.md#plugin-release), into the folder, so a repository builds what its release needs before it packs.
 */
export function packPlugin(repository, out) {
  return repositoryRelease(repository, "pack", out);
}

/**
 * `make release OUT=<folder>` of the sidecar repository builds the sidecar and writes its release of the current platform, the
 * npm pack file of the built sidecar folder named `<file name>-<version>-<platform>.tgz`
 * (docs/spec/installation.md#sidecar-release), into the folder. The platform of the entry is the platform of that name.
 * variables are the make variables of the release, DIAGNOSTIC_RELEASE for --sidecars diagnostic.
 */
export function releaseSidecar(repository, out, variables = []) {
  const release = repositoryRelease(repository, "release", out, variables);
  const platform = /-((?:darwin|linux|windows)-(?:arm64|x64))\.tgz$/.exec(release.release)?.[1];
  if (!platform) throw new Error(`make release of ${repository} wrote ${release.release}, whose name ends with no <os>-<arch>.tgz`);
  return { ...release, platform };
}

/** Writes the pnpm pack file of the plugin folder dir into out (docs/spec/installation.md#plugin-release) and returns it and its sha256. */
export function pnpmPack(dir, out) {
  mkdirSync(out, { recursive: true });
  const { filename } = JSON.parse(execFileSync("pnpm", ["pack", "--json", "--pack-destination", resolve(out)],
    { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }));
  return { release: filename, sha256: createHash("sha256").update(readFileSync(filename)).digest("hex") };
}

/**
 * The revision of the repository at dir, HEAD, and whether its working tree holds changes outside that revision: a tracked file
 * that differs from it or an untracked file that is not ignored.
 */
export function sourceRevision(dir) {
  const git = (args) => {
    try {
      return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      throw new Error(`${dir}: the revision of the sidecar repository cannot be read: ${error.stderr || error.message}`.trim(), { cause: error });
    }
  };
  const revision = git(["rev-parse", "HEAD"]).trim();
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error(`${dir}: git rev-parse HEAD gave ${JSON.stringify(revision)}, not a revision`);
  return { revision, changes: git(["status", "--porcelain"]) !== "" };
}

/** Fails unless the options are those of make registry: SIDECARS=diagnostic, and PLUGINS=public only with it. */
export function checkOptions({ sidecars, plugins }) {
  if (sidecars !== undefined && sidecars !== "diagnostic") {
    throw new Error(`--sidecars must be diagnostic (make registry SIDECARS=diagnostic), not ${JSON.stringify(sidecars)}`);
  }
  if (plugins !== undefined && plugins !== "public") throw new Error(`--plugins must be public (make registry PLUGINS=public), not ${JSON.stringify(plugins)}`);
  if (plugins !== undefined && sidecars === undefined) {
    throw new Error("--plugins public lists the sidecar releases of --sidecars diagnostic: make registry SIDECARS=diagnostic PLUGINS=public");
  }
}

/** Fails when the plugin.json at file names another id than the declaration item of its repository. */
export function checkPluginId(item, manifest, file) {
  if (manifest.id !== item.id) throw new Error(`${file}: id is ${JSON.stringify(manifest.id)}, but ${DECLARATION} declares ${JSON.stringify(item.id)}`);
}

/** The declared plugin and sidecar repository folders, each once, in declaration order. folder resolves a declared folder. */
export function installFolders(declaration, folder) {
  return [...new Set([...declaration.plugins, ...declaration.sidecars].map((item) => folder(item.repository)))];
}

/** Runs `make install` of every declared repository (docs/spec/plugins.md#repositories). */
export function installWorkspace(root = ROOT) {
  const declaration = checkDeclaration(read(new URL(DECLARATION, root)));
  const commonDir = gitCommonDir(fileURLToPath(root));
  for (const dir of installFolders(declaration, (relative) => repositoryFolder(relative, commonDir))) {
    execFileSync("make", ["-C", dir, "install"], { stdio: ["ignore", "inherit", "inherit"] });
  }
}

function write(path, value) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * The names of the sidecars that the registry releases: every declared sidecar, because a connector plugin outside the
 * workspace uses a sidecar that no workspace plugin names. A dependency of a workspace plugin that is neither a declared
 * sidecar nor a workspace plugin is an error.
 */
export function sidecarReleases(declared, manifests, plugins) {
  for (const manifest of manifests) {
    // default: the plugin.json of a plugin that uses no sidecar has no dependencies.
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      if (plugins.has(name) || declared.includes(name)) continue;
      throw new Error(`${DECLARATION}: plugin ${manifest.id} uses ${name}, which no declared sidecar or plugin folder holds`);
    }
  }
  return [...declared];
}

/** Removes the entries, the releases and the revision record of an earlier run from a registry folder. */
function clearRegistry(out) {
  for (const name of ["plugins", "sidecars", "packs", "releases", REVISIONS]) rmSync(join(out, name), { recursive: true, force: true });
}

/**
 * Writes the registry folder anew and creates index.json. Earlier entries in the output folder are removed. sidecars "diagnostic"
 * releases the sidecars with DIAGNOSTIC_RELEASE and writes the revision record; root is the core checkout.
 */
export function buildWorkspaceRegistry(binary, out, { sidecars, root = ROOT } = {}) {
  const declaration = checkDeclaration(read(new URL(DECLARATION, root)));
  const commonDir = gitCommonDir(fileURLToPath(root));
  const folder = (relative) => repositoryFolder(relative, commonDir);
  // A sidecar name → its declaration item, its repository folder and its sidecar folder.
  const declared = new Map();
  for (const item of declaration.sidecars) {
    const repository = folder(item.repository);
    const sidecar = join(repository, item.folder);
    declared.set(read(pathToFileURL(join(sidecar, "package.json"))).name, { item, repository, sidecar });
  }
  const releases = join(out, "releases");
  clearRegistry(out);
  const plugins = new Set(declaration.plugins.map((item) => read(pathToFileURL(join(folder(item.repository), "package.json"))).name));
  const manifests = [];
  for (const item of declaration.plugins) {
    const dir = folder(item.repository);
    const manifest = read(pathToFileURL(join(dir, "plugin.json")));
    checkPluginId(item, manifest, join(dir, "plugin.json"));
    const pkg = read(pathToFileURL(join(dir, "package.json")));
    const pack = packPlugin(dir, releases);
    write(join(out, "plugins", `${manifest.id}.json`), pluginEntry(manifest, pkg, pack, new Set(declared.keys())));
    manifests.push(manifest);
  }
  // The declared repository → the revision of the sources that its first release builds, in declaration order.
  const revisions = new Map();
  for (const name of sidecarReleases([...declared.keys()], manifests, plugins)) {
    const { item, repository, sidecar } = declared.get(name);
    if (sidecars === "diagnostic" && !revisions.has(item.repository)) revisions.set(item.repository, sourceRevision(repository));
    const release = releaseSidecar(repository, releases, sidecars === "diagnostic" ? DIAGNOSTIC_RELEASE : []);
    const file = name.startsWith("@") ? name.slice(1).replace("/", "-") : name;
    write(join(out, "sidecars", `${file}.json`),
      sidecarEntry(read(pathToFileURL(join(sidecar, "package.json"))), read(pathToFileURL(join(sidecar, "sidecar.json"))), release));
  }
  for (const pack of declaration.packs) write(join(out, "packs", `${pack.name}.json`), pack);
  write(join(out, "revoked.json"), { plugins: [], sidecars: [] });
  const result = sok(binary, ["registry", "build", out]);
  // The record follows index.json, so a run that fails leaves none and PLUGINS=public refuses its folder.
  if (sidecars === "diagnostic") {
    write(join(out, REVISIONS), { sidecars: [...revisions].map(([repository, source]) => ({ repository, ...source })) });
  }
  return result;
}

/**
 * The registry files of --plugins public from the index of the public registry and the sidecar entries of --sidecars diagnostic.
 * The public plugins keep old versions whose sidecar ranges name sidecar versions that only the public registry lists, which the
 * index check refuses beside the diagnostic sidecars alone (docs/spec/installation.md#registry-index); each such version is left
 * out and returned in dropped. A left-out version that is not revoked and is newer than a listed version of its plugin is an
 * error, so the listed versions of a plugin are its newest versions that are not revoked. For every core version an installation
 * from this index therefore selects the version that the public registry selects, or, when the public registry selects a left-out
 * version, no version, which fails the installation with the plugin and the core version (docs/spec/installation.md#version-selection). The revoked entries of the listed plugin versions are kept; the public sidecars
 * and core releases are not listed, so their revoked entries are not.
 */
export function publicRegistryEntries(index, sidecars) {
  const releases = new Map(sidecars.map((entry) => [entry.name, entry.versions.map((item) => item.version)]));
  const revoked = (id, version) => index.revoked.plugins.some((item) => item.id === id && item.version === version);
  const dropped = [];
  const plugins = index.plugins.map((plugin) => {
    const left = [];
    const versions = plugin.versions.filter((item) => {
      const unmet = Object.entries(item.sidecars)
        .filter(([name, range]) => !(releases.get(name) ?? []).some((version) => satisfies(range, version)));
      for (const [sidecar, range] of unmet) dropped.push({ id: plugin.id, version: item.version, sidecar, range });
      if (unmet.length > 0) left.push({ item, unmet });
      return unmet.length === 0;
    });
    if (versions.length === 0) {
      throw new Error(`public registry: plugin ${plugin.id} has no version whose sidecar ranges the sidecar releases of ${DIAGNOSTIC_RUN} satisfy`);
    }
    for (const { item, unmet: [[sidecar, range]] } of left) {
      if (revoked(plugin.id, item.version)) continue;
      const older = versions.find((kept) => compareVersions(kept.version, item.version) < 0);
      if (older) {
        throw new Error(`public registry: plugin ${plugin.id} ${item.version} needs ${sidecar} ${range}, which no sidecar release of ${DIAGNOSTIC_RUN} `
          + `satisfies, and its older version ${older.version} is listed, so an installation would select ${older.version} where the public registry selects ${item.version}`);
      }
    }
    return { ...plugin, versions };
  });
  const listed = new Set(plugins.flatMap((plugin) => plugin.versions.map((item) => `${plugin.id} ${item.version}`)));
  return { plugins, packs: index.packs, revoked: { plugins: index.revoked.plugins.filter((item) => listed.has(`${item.id} ${item.version}`)), sidecars: [] }, dropped };
}

/**
 * Writes the registry folder of --plugins public anew and creates index.json: the plugins of the public index beside the sidecar
 * entries and releases that --sidecars diagnostic wrote into sidecarRegistry, whose revision record shows that run.
 */
export function buildPublicRegistry(binary, out, sidecarRegistry, index) {
  if (resolve(out) === resolve(sidecarRegistry)) {
    throw new Error(`--out ${out} is the folder of the sidecar releases; PLUGINS=public writes another folder`);
  }
  const record = join(sidecarRegistry, REVISIONS);
  if (!existsSync(record)) {
    throw new Error(`${record} is missing: --plugins public lists the sidecar releases that ${DIAGNOSTIC_RUN} writes; run ${DIAGNOSTIC_RUN} first`);
  }
  const folder = join(sidecarRegistry, "sidecars");
  const files = readdirSync(folder).filter((name) => name.endsWith(".json")).sort();
  const sidecars = files.map((name) => {
    const entry = read(pathToFileURL(join(folder, name)));
    for (const version of entry.versions) {
      for (const [platform, release] of Object.entries(version.releases)) {
        if (!existsSync(fileURLToPath(release.url))) {
          throw new Error(`${join(folder, name)}: release ${fileURLToPath(release.url)} of ${platform} is missing; run ${DIAGNOSTIC_RUN} first`);
        }
      }
    }
    return { name, entry };
  });
  const entries = publicRegistryEntries(index, sidecars.map((item) => item.entry));
  clearRegistry(out);
  for (const plugin of entries.plugins) write(join(out, "plugins", `${plugin.id}.json`), plugin);
  for (const { name, entry } of sidecars) write(join(out, "sidecars", name), entry);
  for (const pack of entries.packs) write(join(out, "packs", `${pack.name}.json`), pack);
  write(join(out, "revoked.json"), entries.revoked);
  return { ...sok(binary, ["registry", "build", out]), dropped: entries.dropped };
}

/** Reads a registry index from its address; an answer other than 200 is an error that names the address. */
export async function readIndex(url) {
  let response;
  try {
    // The bound of an index read (docs/spec/installation.md#fetching).
    response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  } catch (error) {
    throw new Error(`${url}: cannot connect: ${error.message}`, { cause: error });
  }
  if (response.status !== 200) throw new Error(`${url}: HTTP ${response.status}`);
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${url}: ${error.message}`, { cause: error });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { sok: { type: "string" }, out: { type: "string" }, sidecars: { type: "string" },
    plugins: { type: "string" }, "sidecar-registry": { type: "string" }, "public-index": { type: "string" },
    install: { type: "boolean", default: false } }, strict: true });
  if (values.install) {
    installWorkspace();
    process.exit(0);
  }
  for (const name of ["sok", "out"]) if (!values[name]) throw new Error(`--${name} is required`);
  checkOptions(values);
  if (values.plugins === "public") {
    for (const name of ["sidecar-registry", "public-index"]) if (!values[name]) throw new Error(`--${name} is required with --plugins public`);
    const result = buildPublicRegistry(values.sok, values.out, values["sidecar-registry"], await readIndex(values["public-index"]));
    for (const item of result.dropped) {
      console.log(`Public registry: left out ${item.id} ${item.version}, which needs ${item.sidecar} ${item.range}`);
    }
    console.log(`Public registry: ${result.index} (${result.plugins} plugins, ${result.sidecars} sidecars, ${result.packs} packs)`);
  } else {
    const result = buildWorkspaceRegistry(values.sok, values.out, { sidecars: values.sidecars });
    console.log(`Workspace registry: ${result.index} (${result.plugins} plugins, ${result.sidecars} sidecars, ${result.packs} packs)`);
  }
}
