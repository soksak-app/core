// The window-check run of a plugin repository against the published core application (docs/spec/plugins.md#window-checks-of-a-plugin):
//   sok-test-app [--app <host>] [--pack <command> | --index <index>] [--check-timeout <seconds>] [<file, folder or glob>...]
// run from the root of the plugin repository (`pnpm exec sok-test-app`). The core version is the version of this installed
// @soksak/window-check, the core release that the plugin repository names. For each application of the run (`--app`, or requiredApps
// of app.mjs, so SOKSAK_APP selects one) the run downloads the published application zip `soksak-<version>-<platform>-<host>.zip`
// into build/app-cache/<version>/ of the repository once and extracts its application there. The release platform, the application
// and its executables, the extraction, the quit keys, the lock wait and the process list are the platform operations of platform/platform.mjs;
// a platform that does not implement one fails the step that calls it, before any download. Each run makes a new configuration
// root under build/test-app/ and builds a registry folder in it: the release of the repository that the pack command writes
// (`make pack OUT={out}` by default; `{out}` is the release folder), the `pnpm pack` release of the start probe that this package
// ships (fixtures/start-probe) and of each fixture plugin under e2e/fixtures (a folder that holds plugin.json), and the entry of each
// sidecar that these plugins name, copied from the public registry index; `sok registry build` of the first bundle writes its
// index.json. The `sok` of each bundle sets that index and installs every plugin of the folder into the configuration of its
// application. With `--index`, a file URL or a path of a built registry index such as the one that `make build` of the registry
// writes, the run builds no registry folder and installs no plugin: the `sok` of each bundle sets that index, and the first run of
// each application installs the starter pack that its environment.json names from it; `--index` takes no `--pack`.
// The run starts the applications, runs the checks with node:test, one file at a time, with SOKSAK_REGISTRY_INDEX set to the file
// URL that `registry use` recorded, and quits each application through the quit item of its application menu, the last one
// through the quit key, as a person does. The checks are the given paths, or else the test files under e2e/ outside e2e/fixtures/;
// every check drives the application with the input that its host emulates inside the application.
// It fails when a step fails, when an application ends with another status than 0 or when a process of the root or of a bundle
// remains; each failure names its step. Every download and command is bounded by a time limit and ends at an interrupt. A passed
// run removes its root; a failed run keeps it with the output of the applications.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { closeSync, cpSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync,
  writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { APP_NAMES, requiredApps } from "./app.mjs";
import { untilFolderState } from "./folder-wait.mjs";
import { signalGroup } from "./process-group.mjs";
import { applicationBundle, applicationExecutables, extractApplication, listProcesses, quitKeys, releasePlatform, runPlatform,
  waitForLockRelease } from "./platform/platform.mjs";
import { START_PROBE } from "./start.mjs";

/** The release files of core. */
export const RELEASES = "https://github.com/soksak-app/core/releases/download";
/** The public registry index, which lists the sidecar releases that the plugins of the run name. */
export const PUBLIC_INDEX = "https://soksak-app.github.io/registry/index.json";
/** The pack command of a plugin repository (docs/spec/plugins.md#repositories); `{out}` is the folder of the release it writes. */
export const DEFAULT_PACK = "make pack OUT={out}";
/** The folder of the start probe that the package ships and that every run installs. */
export const START_PROBE_FOLDER = fileURLToPath(new URL("./fixtures/start-probe/", import.meta.url));

/** The time limits of the steps, in milliseconds. */
export const LIMITS = Object.freeze({
  download: 600_000, extract: 120_000, pack: 300_000, index: 30_000, registry: 60_000, install: 120_000,
  start: 60_000, quit: 60_000, command: 30_000, checks: 3_600_000, test: 600_000,
});

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** The core version of the run: the version of this installed @soksak/window-check. */
export const coreVersion = () => readJson(new URL("./package.json", import.meta.url)).version;

/** The published application zip of `host` for `version` on the release platform of `platform` and `arch`, as core names its release files. */
export function applicationZip(version, host, { platform = runPlatform(), arch = process.arch } = {}) {
  const name = `soksak-${version}-${releasePlatform({ platform, arch })}-${host}.zip`;
  return { name, url: `${RELEASES}/v${version}/${name}` };
}

/** The file name of a sidecar release: `scope-name` for `@scope/name` (docs/spec/installation.md#sidecar-release). */
export const sidecarFileName = (name) => (name.startsWith("@") ? name.slice(1).replace("/", "-") : name);

/** The pnpm pack file name of the package `name` at `version`. */
export const packFileName = (name, version) => `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;

/** The address of the package.json repository, a string or `{ url }`, without the git+ prefix and the .git suffix. */
export function repositoryAddress(repository) {
  const url = typeof repository === "string" ? repository : repository?.url;
  if (typeof url !== "string" || url === "") throw new Error("package.json repository has no url");
  return url.replace(/^git\+/, "").replace(/\.git$/, "");
}

/**
 * The registry entry of one plugin release (docs/spec/installation.md#registry-index): `manifest` is its plugin.json, `pkg` its
 * package.json and `release` its pack file. `sidecars` holds the package names of the sidecars of the registry; the index lists only
 * the dependencies on sidecars.
 */
export function pluginEntry(manifest, pkg, release, sidecars) {
  return {
    id: manifest.id, package: pkg.name, name: manifest.name, description: pkg.description, license: pkg.license,
    repository: repositoryAddress(pkg.repository),
    versions: [{
      version: pkg.version, release: { url: pathToFileURL(release).href, sha256: sha256(release) },
      engines: { soksak: pkg.engines?.soksak },
      sidecars: Object.fromEntries(Object.entries(manifest.dependencies ?? {}).filter(([name]) => sidecars.has(name))),
    }],
  };
}

/** The plugin folders of the run: the repository `root`, which holds plugin.json, and each folder under e2e/fixtures that holds one. */
export function pluginFolders(root) {
  if (!existsSync(join(root, "plugin.json"))) throw new Error(`${root} holds no plugin.json; the run checks the plugin of a plugin repository`);
  const folders = [root];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.name === "node_modules") continue;
      const folder = join(dir, entry.name);
      if (existsSync(join(folder, "plugin.json"))) folders.push(folder);
      else visit(folder);
    }
  };
  const fixtures = join(root, "e2e", "fixtures");
  if (existsSync(fixtures)) visit(fixtures);
  return folders;
}

/**
 * The entries of the public registry index `index` of the sidecars that the plugins of the run name in their dependencies. A
 * dependency on a package of the run needs no entry; a dependency that is neither a package of the run nor a sidecar of the index
 * is an error that names it.
 */
export function sidecarEntries(index, plugins) {
  const packages = new Set(plugins.map(({ pkg }) => pkg.name));
  const listed = new Map((index?.sidecars ?? []).map((entry) => [entry.name, entry]));
  const entries = new Map();
  for (const { manifest } of plugins) {
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      if (packages.has(name)) continue;
      const entry = listed.get(name);
      if (entry === undefined) throw new Error(`plugin ${manifest.id} depends on ${name}, which is no plugin of the run and no sidecar of ${PUBLIC_INDEX}`);
      entries.set(name, entry);
    }
  }
  return [...entries.values()];
}

/** Whether node:test takes the file name `name` for a test file (its default patterns). */
const isTestFile = (name, inTestFolder) => /\.(c|m)?js$/.test(name)
  && (inTestFolder || /(^|[.\-_])test\.(c|m)?js$/.test(name) || /^test-/.test(name) || /^test\.(c|m)?js$/.test(name));

/**
 * The checks of the run in the repository `root`, as paths relative to it: the test files under e2e/ outside e2e/fixtures/, in name
 * order. node_modules is never searched. A run without checks is an error.
 */
export function checkFiles(root) {
  const base = join(root, "e2e");
  const files = [];
  const visit = (dir, inTestFolder) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        if (dir === base && entry.name === "fixtures") continue;
        visit(path, inTestFolder || entry.name === "test");
      } else if (entry.isFile() && isTestFile(entry.name, inTestFolder)) {
        files.push(relative(root, path));
      }
    }
  };
  if (existsSync(base)) visit(base, false);
  if (files.length === 0) throw new Error(`no test file under ${relative(root, base)}/`);
  return files;
}

/** The argument vector of the pack command `command` with `{out}` replaced by the release folder `out`. */
export function packArgv(command, out) {
  const argv = command.trim().split(/\s+/).filter(Boolean);
  if (argv.length === 0) throw new Error("--pack names no command");
  if (!argv.some((word) => word.includes("{out}"))) throw new Error(`--pack ${JSON.stringify(command)} names no {out}, the folder of the release it writes`);
  return argv.map((word) => word.replaceAll("{out}", out));
}

/**
 * The environment of the checks: the configuration root, the run folder, the application executable of each host, the file URL of
 * the registry index `index` that the configurations use and, for a run of one application, SOKSAK_APP, so requiredApps of the
 * checks names the same applications.
 */
export function checkEnv(root, executables, index) {
  const hosts = [...executables.keys()];
  return {
    ...(hosts.length < APP_NAMES.length ? { SOKSAK_APP: hosts.join(",") } : {}),
    SOKSAK_CONFIG_ROOT: root,
    SOKSAK_RUN_FOLDER: join(root, "run"),
    ...(index === undefined ? {} : { SOKSAK_REGISTRY_INDEX: index }),
    ...Object.fromEntries([...executables].map(([host, { application }]) => [`SOKSAK_BINARY_${host.toUpperCase()}`, application])),
  };
}

/**
 * The options of `sok-test-app`: `{ apps, pack, index, checkTimeout, checks }`; `checks` is undefined when no path is given.
 * `index` is the path of the registry index that `--index` names as a file URL or a path, or undefined; with it `pack` is undefined.
 */
export function parseTestAppOptions(argv, env = process.env) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
    pack: { type: "string" }, index: { type: "string" }, "check-timeout": { type: "string" },
    app: { type: "string" } } });
  let checkTimeout = LIMITS.checks;
  if (values["check-timeout"] !== undefined) {
    if (!/^[1-9]\d*$/.test(values["check-timeout"])) throw new Error(`--check-timeout ${values["check-timeout"]} is not a positive number of seconds`);
    checkTimeout = Number(values["check-timeout"]) * 1000;
  }
  let index;
  if (values.index !== undefined) {
    if (values.index === "") throw new Error("--index names no index");
    if (values.pack !== undefined) throw new Error("--index installs from a built registry index; it takes no --pack");
    if (values.index.startsWith("file:")) index = fileURLToPath(values.index);
    else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(values.index)) throw new Error(`--index ${values.index} is no file URL and no path`);
    else index = values.index;
  }
  const pack = index === undefined ? values.pack ?? DEFAULT_PACK : undefined;
  if (pack !== undefined) packArgv(pack, "{out}");
  const apps = values.app === undefined ? requiredApps(env) : requiredApps({ SOKSAK_APP: values.app });
  return { apps, pack, index, checkTimeout, checks: positionals.length ? positionals : undefined };
}

/** Prefixes the error of `work` with the name of its step. */
export async function step(name, work) {
  try {
    return await work();
  } catch (error) {
    throw new Error(`${name}: ${error.message}`, { cause: error });
  }
}

const describeEnd = (code, signal) => (code === null ? `signal ${signal}` : `status ${code}`);

/**
 * Runs `file` to its end, with its output on this output, or with `capture` its standard output as the result. It ends the program
 * and rejects after `timeout` milliseconds or at an abort of `signal`; another status than 0 rejects with the command. The program
 * runs in a process group of its own, so its end ends every process that it started.
 */
export async function run(file, args, { cwd, env, signal, timeout, capture = false }) {
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error(`${file}: a command runs with a time limit`);
  const child = spawn(file, args, { cwd, env: { ...process.env, ...env }, stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit", detached: true });
  let out = "";
  let err = "";
  if (capture) {
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
  }
  const command = [file, ...args].join(" ");
  const exited = once(child, "exit");
  let timer;
  let abort;
  // The signal that ends the group: a program at its limit is stopped where it waits, and an interrupted program runs its own cleanup.
  let end = null;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => { end = "SIGKILL"; reject(new Error(`${command} did not end in ${timeout / 1000}s`)); }, timeout);
    abort = () => { end = "SIGTERM"; reject(new Error(`${command} was interrupted by ${signal.reason}`)); };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
  try {
    const [code, ended] = await Promise.race([
      exited,
      once(child, "error").then(([error]) => { throw new Error(`cannot start ${file}: ${error.message}`); }),
      limit,
    ]);
    if (code !== 0) throw new Error(`${command} ended with ${describeEnd(code, ended)}${err.trim() ? `: ${err.trim()}` : ""}`);
    return out;
  } catch (error) {
    if (end !== null && child.exitCode === null && child.signalCode === null) await endGroup(child, end, exited);
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

/**
 * Sends `signal` to the process group of `child` and waits for the exit of `child`; the processes of the group that remain after
 * that exit get SIGKILL, because the program that started them ended without them. A group that runs nothing is no error
 * (signalGroup of process-group.mjs).
 */
async function endGroup(child, signal, exited) {
  signalGroup(child.pid, signal);
  await exited;
  signalGroup(child.pid, "SIGKILL");
}


/** The response of `url`, bounded by `timeout` and `signal`; another status than 2xx is an error that names the address. */
async function fetchBounded(url, { timeout, signal, fetchImpl = fetch }) {
  const bound = AbortSignal.any([AbortSignal.timeout(timeout), ...(signal ? [signal] : [])]);
  const response = await fetchImpl(url, { signal: bound });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return { response, bound };
}

/** Downloads `url` into `file` through a temporary file beside it, so an interrupted download leaves no file. */
export async function download(url, file, { timeout = LIMITS.download, signal, fetchImpl } = {}) {
  const { response, bound } = await fetchBounded(url, { timeout, signal, fetchImpl });
  mkdirSync(dirname(file), { recursive: true });
  const partial = `${file}.partial`;
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial), { signal: bound });
  } catch (error) {
    rmSync(partial, { force: true });
    throw error;
  }
  renameSync(partial, file);
}

/** The JSON document at `url`, bounded by `timeout` and `signal`. */
export async function fetchJson(url, { timeout = LIMITS.index, signal, fetchImpl } = {}) {
  const { response } = await fetchBounded(url, { timeout, signal, fetchImpl });
  return response.json();
}

/**
 * The application of `host` for `version` in the cache folder `cache`: the zip of the release platform is downloaded and extracted
 * once by the platform operations of `platform`. `run(file, args)` runs the extraction program, `extract(zip, folder)` replaces the
 * extraction and `fetchImpl` the download in a test. A platform without an operation of the application rejects before the download.
 */
export async function cachedBundle(cache, version, host, { platform = runPlatform(), arch = process.arch, signal, fetchImpl,
  write = () => {}, run: runProgram = (file, args) => run(file, args, { signal, timeout: LIMITS.extract }),
  extract = (zip, folder) => extractApplication(zip, folder, { platform, run: runProgram }) } = {}) {
  const folder = join(cache, version, host);
  const bundle = await applicationBundle(folder, { platform });
  if (existsSync(bundle)) return bundle;
  const { name, url } = applicationZip(version, host, { platform, arch });
  const zip = join(cache, version, name);
  const extracting = `${folder}.partial`;
  const extracted = await applicationBundle(extracting, { platform });
  if (!existsSync(zip)) {
    write(`downloading ${url}`);
    await download(url, zip, { signal, fetchImpl });
  }
  rmSync(extracting, { recursive: true, force: true });
  await extract(zip, extracting);
  if (!existsSync(extracted)) throw new Error(`${zip} holds no ${relative(extracting, extracted)}`);
  renameSync(extracting, folder);
  return bundle;
}

/**
 * Builds the registry folder `folder` of the repository `root`: the pack command writes the release of the repository, `pnpm pack`
 * the release of each fixture plugin, the entry of each sidecar that a plugin names is copied from the public index, and
 * `sok registry build` writes index.json. Resolves with the index path and the plugin ids.
 */
export async function buildRegistry({ root, folder, sok, pack = DEFAULT_PACK, pnpm = "pnpm", signal, fetchImpl, indexUrl = PUBLIC_INDEX }) {
  const releases = join(folder, "releases");
  mkdirSync(releases, { recursive: true });
  // The start probe is packed from a copy inside the registry folder, so the pack reads no workspace of the installed package.
  const probe = join(folder, "start-probe");
  cpSync(START_PROBE_FOLDER, probe, { recursive: true });
  const plugins = [...pluginFolders(root), probe].map((dir) => ({ dir, manifest: readJson(join(dir, "plugin.json")), pkg: readJson(join(dir, "package.json")) }));
  const seen = new Map();
  for (const { dir, manifest } of plugins) {
    if (seen.has(manifest.id)) {
      const where = (path) => (path === probe ? `the start probe of @soksak/window-check` : relative(root, path) || ".");
      throw new Error(`registry: the plugin id ${manifest.id} of ${where(dir)} is also the id of ${where(seen.get(manifest.id))}`);
    }
    seen.set(manifest.id, dir);
  }
  for (const { dir, manifest } of plugins) {
    if (dir === root) {
      const [file, ...args] = packArgv(pack, releases);
      await step(`pack ${manifest.id}`, () => run(file, args, { cwd: root, signal, timeout: LIMITS.pack }));
    } else {
      await step(`pack ${manifest.id}`, () => run(pnpm, ["pack", "--pack-destination", releases], { cwd: dir, signal, timeout: LIMITS.pack }));
    }
  }
  const named = plugins.some(({ manifest }) => Object.keys(manifest.dependencies ?? {}).length > 0);
  const index = named ? await step("public registry index", () => fetchJson(indexUrl, { signal, fetchImpl })) : { sidecars: [] };
  const sidecars = sidecarEntries(index, plugins);
  for (const entry of sidecars) writeJson(join(folder, "sidecars", `${sidecarFileName(entry.name)}.json`), entry);
  const sidecarNames = new Set(sidecars.map((entry) => entry.name));
  for (const { manifest, pkg } of plugins) {
    const release = join(releases, packFileName(pkg.name, pkg.version));
    if (!existsSync(release)) throw new Error(`pack ${manifest.id}: the pack wrote no ${relative(folder, release)}`);
    writeJson(join(folder, "plugins", `${manifest.id}.json`), pluginEntry(manifest, pkg, release, sidecarNames));
  }
  writeJson(join(folder, "revoked.json"), { plugins: [], sidecars: [] });
  const built = await step("registry build", async () => JSON.parse(await run(sok, ["registry", "build", folder],
    { cwd: root, signal, timeout: LIMITS.registry, capture: true })));
  return { index: built.index, ids: plugins.map(({ manifest }) => manifest.id) };
}

/**
 * Sets the registry of the run in the configuration of each application with the `sok` of its bundle (`executables`) and resolves
 * with the file URL that `registry use` recorded. Without `index` the registry is the check registry that buildRegistry writes into
 * `folder`, and every plugin of it is installed. With `index`, the path of a built registry index, the run builds nothing and
 * installs nothing: the first run of each application installs the starter pack that its environment.json names from that index
 * (docs/spec/installation.md#first-run). A missing or unreadable index fails the step that names it.
 */
export async function installRegistry({ root, folder, executables, configDir, index, pack = DEFAULT_PACK, pnpm, signal, fetchImpl }) {
  const hosts = [...executables.keys()];
  let registry;
  if (index === undefined) {
    registry = await buildRegistry({ root, folder, sok: executables.get(hosts[0]).sok, pack, pnpm, signal, fetchImpl });
  } else {
    const path = resolve(root, index);
    await step(`registry index ${path}`, () => {
      try {
        JSON.parse(readFileSync(path, "utf8"));
      } catch (error) {
        throw new Error(`cannot read it: ${error.message}`);
      }
    });
    registry = { index: path, ids: [] };
  }
  let recorded;
  for (const host of hosts) {
    const { sok } = executables.get(host);
    const config = ["--config-dir", configDir(host)];
    const used = await step(`registry ${host}`, async () => JSON.parse(await run(sok, ["registry", "use", registry.index, ...config],
      { cwd: root, signal, timeout: LIMITS.command, capture: true })).index);
    recorded ??= used;
    for (const id of registry.ids) {
      await step(`install ${id} ${host}`, () => run(sok, ["plugin", "install", id, ...config], { cwd: root, signal, timeout: LIMITS.install }));
    }
  }
  return recorded;
}

/** Starts the application and resolves with its process once its configuration folder holds endpoint.json. */
async function start(application, configDir, out, root) {
  mkdirSync(configDir, { recursive: true });
  const stream = openSync(out, "a");
  const child = spawn(application, ["--config-dir", configDir], { cwd: root, stdio: ["ignore", stream, stream] });
  closeSync(stream);
  const ended = new AbortController();
  child.once("error", (error) => ended.abort(new Error(`cannot start ${application}: ${error.message}`)));
  child.once("exit", (code, signal) => ended.abort(new Error(`${application} ended with ${describeEnd(code, signal)} before it wrote endpoint.json`)));
  const endpoint = join(configDir, "endpoint.json");
  // The folder wait has no time limit; the run bounds its start step with its own limit, which it gives the wait as an abort.
  const limit = AbortSignal.timeout(LIMITS.start);
  try {
    await untilFolderState(configDir, () => (existsSync(endpoint) ? true : undefined), { signal: AbortSignal.any([ended.signal, limit]) });
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (limit.aborted && !ended.signal.aborted) throw new Error(`${application} wrote no endpoint.json in ${LIMITS.start / 1000}s`);
    throw error;
  }
  return child;
}

/**
 * Quits the application of `configDir` as a person does, with the `sok` of its application: `menu` selects the item of the
 * application menu whose key equivalent is the quit key of `platform`, `key` sends that key down and up. Resolves when the process
 * exited with status 0 and the lock of the configuration folder is free.
 */
async function quit(child, sok, configDir, by, root, platform) {
  const config = ["--config-dir", configDir];
  const command = (args) => run(sok, [...args, ...config], { cwd: root, timeout: LIMITS.command, capture: true });
  const exited = child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve([child.exitCode, child.signalCode]) : once(child, "exit");
  const keys = await quitKeys({ platform });
  if (by === "menu") {
    const { menus } = JSON.parse(await command(["status", "host.menu"]));
    const menu = menus.find((entry) => entry.items.some((item) => item.key === keys.menu));
    if (menu === undefined) throw new Error(`the application menu has no item with the key equivalent ${keys.menu}`);
    const { title } = menu.items.find((item) => item.key === keys.menu);
    await command(["host.menu.select", "--menu", menu.title, "--title", title]);
  } else {
    const { key, text, modifiers } = keys.key;
    for (const phase of ["down", "up"]) {
      await command(["input", "key", "--key", key, "--text", text, "--modifiers", modifiers.join(","), "--phase", phase]);
    }
  }
  let timer;
  const [code, signal] = await Promise.race([exited, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the application did not exit in ${LIMITS.quit / 1000}s after its quit`)), LIMITS.quit);
  })]).finally(() => clearTimeout(timer));
  if (code !== 0) throw new Error(`the application ended with ${describeEnd(code, signal)}`);
  const lock = join(configDir, "process.lock");
  if (existsSync(lock)) {
    await waitForLockRelease(lock, LIMITS.quit / 1000, { platform,
      run: (file, args) => run(file, args, { cwd: root, timeout: LIMITS.quit + LIMITS.command }) });
  }
}

/** The processes `{pid, command}` other than this one whose command line names one of the paths, as `<pid> <command>`. */
export function remainingProcesses(processes, paths, self = process.pid) {
  return processes.filter(({ pid, command }) => pid !== self && paths.some((path) => command.includes(path)))
    .map(({ pid, command }) => `${pid} ${command}`);
}

/**
 * Runs the window checks of the plugin repository `root` (`sok-test-app`). Resolves with the failures, each
 * `<step>: <reason>`; an empty list is a passed run.
 */
export async function testApp({ root, apps = requiredApps(process.env), pack = DEFAULT_PACK, index, checks,
  checkTimeout = LIMITS.checks, signal, platform = runPlatform(), write = (line) => process.stdout.write(`test-app: ${line}\n`) }) {
  const version = coreVersion();
  const hosts = apps;
  let selected;
  try {
    selected = checks ?? checkFiles(root);
  } catch (error) {
    return [`checks: ${error.message}`];
  }
  const cache = join(root, "build", "app-cache");
  const base = join(root, "build", "test-app");
  mkdirSync(base, { recursive: true });
  const configRoot = mkdtempSync(join(base, `${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}-`));
  write(`core ${version}, applications ${hosts.join(", ")}, root ${relative(root, configRoot)}`);
  const failures = [];
  const children = new Map();
  const bundles = new Map();
  const executables = new Map();
  const configDir = (host) => join(configRoot, `soksak-check-${host}`);
  try {
    for (const host of hosts) {
      await step(`application ${host}`, async () => {
        const bundle = await cachedBundle(cache, version, host, { platform, signal, write });
        bundles.set(host, bundle);
        executables.set(host, await applicationExecutables(bundle, host, { platform }));
      });
    }
    const registry = await installRegistry({ root, folder: join(configRoot, "registry"), executables, configDir, index, pack, signal });
    for (const host of hosts) {
      write(`starting ${host}`);
      children.set(host, await step(`start ${host}`, () => start(executables.get(host).application, configDir(host), join(configRoot, `${host}.out`), root)));
    }
    try {
      await step("window checks", () => run(process.execPath,
        ["--test", "--test-concurrency=1", `--test-timeout=${LIMITS.test}`, ...selected],
        { cwd: root, signal, timeout: checkTimeout, env: checkEnv(configRoot, executables, registry) }));
    } catch (error) {
      failures.push(error.message);
    }
  } catch (error) {
    failures.push(error.message);
  } finally {
    const started = [...children.keys()];
    for (const [position, host] of started.entries()) {
      try {
        await step(`quit ${host}`, () => quit(children.get(host), executables.get(host).sok, configDir(host),
          position === started.length - 1 ? "key" : "menu", root, platform));
      } catch (error) {
        failures.push(error.message);
        children.get(host).kill("SIGKILL");
      }
    }
    try {
      const processes = await listProcesses({ platform,
        run: (file, args) => run(file, args, { cwd: root, timeout: LIMITS.command, capture: true }) });
      const left = remainingProcesses(processes, [configRoot, ...bundles.values()]);
      if (left.length > 0) failures.push(`remaining processes: ${left.length} processes remain: ${left.join("; ")}`);
    } catch (error) {
      failures.push(`remaining processes: ${error.message}`);
    }
  }
  if (failures.length > 0) {
    for (const failure of failures) write(`failed ${failure}`);
    write(`the root ${relative(root, configRoot)} is kept`);
    return failures;
  }
  rmSync(configRoot, { recursive: true, force: true });
  write("passed");
  return failures;
}

/** Runs `sok-test-app` with the arguments `argv` in the repository `root`; resolves with the exit status. */
export async function testAppCommand(argv, { root = resolve(process.cwd()) } = {}) {
  const options = parseTestAppOptions(argv);
  const interrupt = new AbortController();
  const handlers = ["SIGINT", "SIGTERM", "SIGHUP"].map((name) => {
    const handler = () => interrupt.abort(name);
    process.once(name, handler);
    return [name, handler];
  });
  try {
    const failures = await testApp({ root, ...options, signal: interrupt.signal });
    return failures.length === 0 ? 0 : 1;
  } finally {
    for (const [name, handler] of handlers) process.removeListener(name, handler);
  }
}
