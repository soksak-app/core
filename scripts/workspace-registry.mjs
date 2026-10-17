#!/usr/bin/env node
// The workspace registry (docs/spec/plugins.md#repositories). Packs the plugin repositories that scripts/workspace-registry.json declares as folders
// relative to the core checkout, builds every declared sidecar from its repository and releases them
// for the current platform, then writes the registry files from the result and creates index.json with `sok registry build`
// (docs/spec/cli.md). Builds and window checks install plugins from this registry. It uses no network.
//
//   node scripts/workspace-registry.mjs --sok <sok executable> --out <registry folder> [--diagnostics]
//
// --diagnostics packs the plugins as diagnostic packages. Diagnostic builds and window checks install from this registry.
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = new URL("../", import.meta.url);
const DECLARATION = "scripts/workspace-registry.json";

const read = (url) => JSON.parse(readFileSync(url, "utf8"));

const folderText = (value) => typeof value === "string" && value !== "" && !value.startsWith("/");

/**
 * Checks the declarations of scripts/workspace-registry.json. plugins are plugin repository folders, sidecars are
 * {repository, folder} (folder is the folder in the repository that holds sidecar.json), and packs are registry pack entries.
 * Folders are paths relative to the core checkout.
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

/** The git common directory of the checkout that holds root. Every worktree of a repository has the same common directory. */
function gitCommonDir(root) {
  return execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: fileURLToPath(root), encoding: "utf8", stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

/** The address of the package.json repository. It is a string or { url }. */
export function repositoryText(repository) {
  const url = typeof repository === "string" ? repository : repository?.url;
  if (typeof url !== "string" || url === "") throw new Error("package.json repository has no url");
  return url;
}

/**
 * The registry entry of one plugin. pack is the output of `sok plugin pack`, and sidecars is the set of the package names of
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

/** The registry entry of one sidecar. release is the output of `sok sidecar release`. */
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

/** `make build` of the sidecar repository writes the executable that sidecar.json points to. */
function buildSidecar(repository) {
  execFileSync("make", ["-C", repository, "build"], { stdio: ["ignore", "inherit", "inherit"] });
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

/** Writes the registry folder anew and creates index.json. Earlier entries in the output folder are removed. */
export function buildWorkspaceRegistry(binary, out, diagnostics, root = ROOT) {
  const declaration = checkDeclaration(read(new URL(DECLARATION, root)));
  const commonDir = gitCommonDir(root);
  const folder = (relative) => repositoryFolder(relative, commonDir);
  // A sidecar name → its declared repository and sidecar folder.
  const declared = new Map();
  for (const item of declaration.sidecars) {
    const repository = folder(item.repository);
    const sidecar = join(repository, item.folder);
    declared.set(read(pathToFileURL(join(sidecar, "package.json"))).name, { repository, sidecar });
  }
  const releases = join(out, "releases");
  for (const name of ["plugins", "sidecars", "packs", "releases"]) rmSync(join(out, name), { recursive: true, force: true });
  const plugins = new Set(declaration.plugins.map((relative) => read(pathToFileURL(join(folder(relative), "package.json"))).name));
  const manifests = [];
  for (const relative of declaration.plugins) {
    const dir = folder(relative);
    const manifest = read(pathToFileURL(join(dir, "plugin.json")));
    const pkg = read(pathToFileURL(join(dir, "package.json")));
    const pack = sok(binary, ["plugin", "pack", dir, releases, ...(diagnostics ? ["--diagnostics"] : [])]);
    write(join(out, "plugins", `${manifest.id}.json`), pluginEntry(manifest, pkg, pack, new Set(declared.keys())));
    manifests.push(manifest);
  }
  const built = new Set();
  for (const name of sidecarReleases([...declared.keys()], manifests, plugins)) {
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
  const { values } = parseArgs({ options: { sok: { type: "string" }, out: { type: "string" }, diagnostics: { type: "boolean", default: false } }, strict: true });
  for (const name of ["sok", "out"]) if (!values[name]) throw new Error(`--${name} is required`);
  const result = buildWorkspaceRegistry(values.sok, values.out, values.diagnostics);
  console.log(`Workspace registry: ${result.index} (${result.plugins} plugins, ${result.sidecars} sidecars, ${result.packs} packs)`);
}
