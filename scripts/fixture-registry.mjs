#!/usr/bin/env node
// The fixture registry (docs/spec/plugin-processes.md#verification-boundaries). Packs every fixture plugin of e2e/fixtures, a folder that
// holds plugin.json, and releases every fixture sidecar of e2e/fixtures/sidecars, a folder that holds sidecar.json, for the current
// platform; then writes the registry files with one pack `fixtures` of every fixture plugin and creates index.json with
// `sok registry build` (docs/spec/cli.md). The core window checks install plugins from this registry. It reads no path outside
// e2e/fixtures and no registry index, and it builds no plugin or sidecar repository.
//
// A registry check builds its own fixture registry with the same function: `versions` lists a fixture plugin in several versions,
// each packed from a copy of the fixture whose package.json names that version. withWrongHash, withRevoked and servedIndex derive the
// index variants that the check serves, serveRegistry serves them over https, and readIndex reads the fixture registry that a check
// application uses.
//
//   node scripts/fixture-registry.mjs --sok <sok executable> --out <registry folder> [--root <fixtures folder>]
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { constants, accessSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { releasePlatform } from "./platform/platform.js";
import { combineFailures, runCommand } from "./test-command.mjs";

/** The folder of the core fixtures. */
export const FIXTURES = fileURLToPath(new URL("../e2e/fixtures/", import.meta.url));
// The folder of the fixture sidecars under the fixtures.
const SIDECARS = "sidecars";
// The folders that fixtureSources does not search: installed packages and the build output of a fixture sidecar.
const SKIPPED_FOLDERS = new Set(["node_modules", "target"]);
// The one pack of the fixture registry.
const PACK = "fixtures";
// The folder of a registry that holds the copies of the fixture plugins that `versions` lists.
const COPIES = "copies";
/** The sha256 that no release has. */
export const WRONG_SHA256 = "0".repeat(64);
/** The limit of each command of a registry build: a pack or `sok registry build`. */
export const STEP_TIMEOUT_MS = 30000;

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
  return pluginEntryOf(manifest, pkg, [pluginVersion(manifest, pkg, pack, sidecars)]);
}

/** The registry entry of one plugin with the version entries versions; pkg gives the package fields. */
function pluginEntryOf(manifest, pkg, versions) {
  return {
    id: manifest.id, package: pkg.name, name: manifest.name, description: pkg.description, license: pkg.license,
    repository: repositoryText(pkg.repository), versions,
  };
}

/** One version entry of a plugin: the version and engines of pkg, the release of pack and the sidecar dependencies of manifest. */
function pluginVersion(manifest, pkg, pack, sidecars) {
  return {
    version: pkg.version, release: { url: pathToFileURL(pack.release).href, sha256: pack.sha256 },
    // default: the plugin.json of a plugin that uses no sidecar has no dependencies.
    engines: { soksak: pkg.engines?.soksak },
    // default: the plugin.json of a plugin without dependencies has no dependencies.
    sidecars: Object.fromEntries(Object.entries(manifest.dependencies ?? {}).filter(([name]) => sidecars.has(name))),
  };
}

/** The version after version: its patch number raised by one, so `0.0.40` gives `0.0.41`. */
export function nextPatch(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`${JSON.stringify(version)} is not a version major.minor.patch`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

/**
 * Copies the fixture plugin folder dir to copy with the package.json version `version` and, when engines is given, the package.json
 * engines.soksak `engines`; returns the package.json of the copy. A node_modules folder is not copied.
 */
export function versionedCopy(dir, copy, { version, engines }) {
  rmSync(copy, { recursive: true, force: true });
  cpSync(dir, copy, { recursive: true, filter: (source) => !SKIPPED_FOLDERS.has(relative(dir, source).split(/[\\/]/)[0]) });
  const pkg = read(join(copy, "package.json"));
  pkg.version = version;
  if (engines !== undefined) pkg.engines = { ...pkg.engines, soksak: engines };
  writeJson(join(copy, "package.json"), pkg);
  return pkg;
}

/** The version entry of version of the plugin id in index, or an error that names it. */
function indexVersion(index, id, version) {
  const plugin = index.plugins.find((item) => item.id === id);
  if (!plugin) throw new Error(`the registry index lists no plugin ${id}`);
  const entry = plugin.versions.find((item) => item.version === version);
  if (!entry) throw new Error(`the registry index lists no version ${version} of ${id}`);
  return entry;
}

/** A copy of the registry index whose release of version of the plugin id has WRONG_SHA256, a hash that no release has. */
export function withWrongHash(index, id, version) {
  const copy = structuredClone(index);
  indexVersion(copy, id, version).release.sha256 = WRONG_SHA256;
  return copy;
}

/** A copy of the registry index that revokes version of the plugin id for reason. */
export function withRevoked(index, id, version, reason) {
  const copy = structuredClone(index);
  indexVersion(copy, id, version);
  copy.revoked = { plugins: [...(copy.revoked?.plugins ?? []), { id, version, reason }], sidecars: copy.revoked?.sidecars ?? [] };
  return copy;
}

/**
 * A copy of the registry index whose release addresses inside the registry folder are served from base: the file address of
 * `<folder>/<path>` becomes `<base>/<path>`. Each sha256 stays, because the served file is the same.
 */
export function servedIndex(index, folder, base) {
  const prefix = pathToFileURL(join(resolve(folder), "/")).href;
  return JSON.parse(JSON.stringify(index).replaceAll(`"${prefix}`, `"${base}/`));
}

/**
 * The registry that a check application uses: the index at the file address `address`, as core.plugins reports it, and its folder,
 * as `{ folder, index }`. An address that is not a file address is an error.
 */
export function readIndex(address) {
  if (typeof address !== "string" || !address.startsWith("file:")) throw new Error(`the registry ${JSON.stringify(address)} is no file address`);
  const file = fileURLToPath(address);
  return { folder: join(file, ".."), index: read(file) };
}

/** The decoded path of a request target without its query. */
const requestPath = (target) => decodeURIComponent(target.split("?")[0]);

/**
 * Serves a registry folder over https on 127.0.0.1 with the certificate { cert, key }: each path of documents answers its JSON
 * document, and any other path answers the file of that path inside folder, or 404. Resolves with { base, close }; close stops the
 * server, and a second close waits for the same stop.
 */
export async function serveRegistry(folder, documents, { cert, key } = {}) {
  const root = resolve(folder);
  const server = createHttpsServer({ cert, key }, (request, response) => {
    const path = requestPath(request.url);
    if (Object.hasOwn(documents, path)) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(documents[path]));
      return;
    }
    const file = resolve(root, `.${path}`);
    const rest = relative(root, file);
    let body = null;
    if (rest !== "" && !rest.startsWith("..") && !isAbsolute(rest)) {
      try {
        if (statSync(file).isFile()) body = readFileSync(file);
      } catch {
        body = null;
      }
    }
    response.writeHead(body === null ? 404 : 200);
    response.end(body ?? undefined);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  let stopped = null;
  const close = () => stopped ??= new Promise((done) => {
    server.close(() => done());
    server.closeAllConnections();
  });
  return { base: `https://127.0.0.1:${server.address().port}`, close };
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

/**
 * Runs one command of a registry build through runCommand under timeoutMs and signal and resolves with its output. A command that
 * does not pass, because it failed, exceeded the limit or was cancelled, rejects with an error that names the step id and the status.
 */
export async function runStep(id, command, args, { cwd, signal, timeoutMs = STEP_TIMEOUT_MS } = {}) {
  const result = await runCommand({ id, command, args, cwd, timeoutMs, signal });
  if (result.status !== "pass") throw new Error(`${id}: ${result.status}: ${JSON.stringify(result.error ?? result.stderr)}`);
  return result.stdout;
}

/**
 * Writes the pnpm pack file of the plugin folder dir into out (docs/spec/installation.md#plugin-release) and resolves with it and its
 * sha256. signal and timeoutMs bound the pack.
 */
export async function pnpmPack(dir, out, { signal, timeoutMs } = {}) {
  mkdirSync(out, { recursive: true });
  const { filename } = JSON.parse(await runStep(`pack ${dir}`, "pnpm", ["pack", "--json", "--pack-destination", resolve(out)],
    { cwd: dir, signal, timeoutMs }));
  return { release: filename, sha256: sha256(filename) };
}

/**
 * Writes the release of the fixture sidecar folder dir for platform into out: the npm pack file of the folder, which keeps the execute
 * bit, named `<file name>-<version>-<platform>.tgz` (docs/spec/installation.md#sidecar-release). Resolves with it, its sha256 and
 * platform. signal and timeoutMs bound the pack.
 */
export async function npmSidecarRelease(dir, out, { platform = releasePlatform(), signal, timeoutMs } = {}) {
  const { executable } = read(join(dir, "sidecar.json"));
  if (!isExecutableFile(join(dir, executable))) {
    throw new Error(`pack sidecar ${dir}: sidecar.json executable ${executable} is not an executable file; build the sidecar first`);
  }
  mkdirSync(out, { recursive: true });
  const [{ filename }] = JSON.parse(await runStep(`pack sidecar ${dir}`, "npm", ["pack", "--json", "--pack-destination", resolve(out)],
    { cwd: dir, signal, timeoutMs }));
  const pkg = read(join(dir, "package.json"));
  const release = join(resolve(out), `${sidecarFileName(pkg.name)}-${pkg.version}-${platform}.tgz`);
  renameSync(join(resolve(out), filename), release);
  return { release, sha256: sha256(release), platform };
}

/** Whether path is a regular file that the current user may execute. */
function isExecutableFile(path) {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Runs `sok registry build` of the folder under signal and timeoutMs and resolves with its JSON result. */
export async function registryBuild(binary, folder, { signal, timeoutMs } = {}) {
  return JSON.parse(await runStep(`registry build ${folder}`, binary, ["registry", "build", folder], { signal, timeoutMs }));
}

/**
 * The sources of the fixture registry under root: plugins, every folder that holds plugin.json, and sidecars, every folder under
 * root/sidecars that holds sidecar.json; each sorted. A node_modules folder and a target folder, the build output of a fixture
 * sidecar, are not searched.
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
    for (const entry of entries) if (entry.isDirectory() && !SKIPPED_FOLDERS.has(entry.name)) visit(join(dir, entry.name));
  };
  visit(resolve(root));
  return { plugins: plugins.sort(), sidecars: sidecars.sort() };
}

/** The ids of the fixture plugins under root in the order of fixtureSources: the plugins of the pack `fixtures`. */
export function fixturePluginIds(root = FIXTURES) {
  return fixtureSources(root).plugins.map((dir) => read(join(dir, "plugin.json")).id);
}

/**
 * Writes the fixture registry folder out anew from the fixtures under root and creates index.json; resolves with the result of the
 * registry build. pnpmPack writes a plugin release, npmSidecarRelease writes a sidecar release, and registryBuild runs the `sok registry
 * build` of the executable `binary`; each receives { signal, timeoutMs }, so a cancelled signal or a step over the limit ends the
 * build. versions maps a fixture plugin id to the
 * version entries `{ version, engines }` that its registry entry lists in place of the version of the fixture: each is packed from
 * a copy of the fixture in out/copies whose package.json names version and, when engines is given, engines.soksak `engines`.
 */
export async function buildFixtureRegistry(binary, out, { root = FIXTURES, signal, timeoutMs, versions = {} } = {}) {
  const bound = { signal, timeoutMs };
  for (const [id, listed] of Object.entries(versions)) {
    if (!Array.isArray(listed) || listed.length === 0) throw new Error(`versions of ${id} list no version`);
  }
  for (const name of ["plugins", "sidecars", "packs", "releases", COPIES, "revoked.json", "index.json"]) rmSync(join(out, name), { recursive: true, force: true });
  for (const name of ["plugins", "sidecars", "packs"]) mkdirSync(join(out, name), { recursive: true });
  const releases = join(out, "releases");
  const sources = fixtureSources(root);
  const sidecars = new Set();
  for (const dir of sources.sidecars) {
    const pkg = read(join(dir, "package.json"));
    sidecars.add(pkg.name);
    writeJson(join(out, "sidecars", `${sidecarFileName(pkg.name)}.json`), sidecarEntry(pkg, read(join(dir, "sidecar.json")), await npmSidecarRelease(dir, releases, bound)));
  }
  const ids = [];
  for (const dir of sources.plugins) {
    const manifest = read(join(dir, "plugin.json"));
    const pkg = read(join(dir, "package.json"));
    const listed = versions[manifest.id];
    let entry;
    if (listed === undefined) {
      entry = pluginEntry(manifest, pkg, await pnpmPack(dir, releases, bound), sidecars);
    } else {
      const entries = [];
      for (const item of listed) {
        const copy = join(out, COPIES, `${manifest.id}-${item.version}`);
        const copied = versionedCopy(dir, copy, item);
        entries.push(pluginVersion(manifest, copied, await pnpmPack(copy, releases, bound), sidecars));
      }
      entry = pluginEntryOf(manifest, pkg, entries);
    }
    writeJson(join(out, "plugins", `${manifest.id}.json`), entry);
    ids.push(manifest.id);
  }
  const unknown = Object.keys(versions).filter((id) => !ids.includes(id));
  if (unknown.length > 0) throw new Error(`versions name no fixture plugin: ${unknown.join(", ")}`);
  writeJson(join(out, "packs", `${PACK}.json`), { name: PACK, description: "Every fixture plugin of the core fixtures.", plugins: ids });
  writeJson(join(out, "revoked.json"), { plugins: [], sidecars: [] });
  return registryBuild(binary, out, bound);
}

const removeFolder = (folder) => rmSync(folder, { recursive: true, force: true });

/**
 * Resolves with a new registry folder that holds the fixture registry: every plugin of e2e/fixtures packed, the pack fixtures and the
 * index that the `sok registry build` of the executable `sok` writes. buildFixtureRegistry writes it from the fixtures under `root`
 * under `signal`, each of its commands within the step limit. A failed build removes the folder; when the removal also fails, the
 * build rejects with an AggregateError of both. The caller removes the folder.
 */
export async function fixtureRegistry({ sok, signal, root }) {
  const folder = mkdtempSync(join(tmpdir(), "soksak-fixture-registry-"));
  try {
    await buildFixtureRegistry(sok, folder, { root, signal });
  } catch (error) {
    let cleanupError = null;
    try {
      removeFolder(folder);
    } catch (cleanup) {
      cleanupError = cleanup;
    }
    throw combineFailures(error, cleanupError);
  }
  return folder;
}

/**
 * The command line: builds the registry of `--sok` into `--out` from the fixtures under `--root` (e2e/fixtures by default) and
 * resolves with the result of the build. SIGTERM, SIGINT or SIGHUP of the process aborts the signal of the build, so a run
 * that ends the build (scripts/test-app.mjs interrupts its step with SIGTERM, and make passes it on) ends the running pack instead of
 * leaving it behind.
 */
export async function main(argv) {
  const { values } = parseArgs({ args: argv, options: { sok: { type: "string" }, out: { type: "string" }, root: { type: "string" } }, strict: true });
  for (const name of ["sok", "out"]) if (!values[name]) throw new Error(`--${name} is required`);
  const interrupt = new AbortController();
  const handlers = ["SIGTERM", "SIGINT", "SIGHUP"].map((name) => [name, () => interrupt.abort(name)]);
  for (const [name, handler] of handlers) process.once(name, handler);
  try {
    return await buildFixtureRegistry(values.sok, values.out, { root: values.root, signal: interrupt.signal });
  } finally {
    for (const [name, handler] of handlers) process.removeListener(name, handler);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await main(process.argv.slice(2));
  console.log(`Fixture registry: ${result.index} (${result.plugins} plugins, ${result.sidecars} sidecars, ${result.packs} packs)`);
}
