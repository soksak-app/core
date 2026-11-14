import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { APP_NAMES } from "../app.mjs";
import { START_PROBE } from "../start.mjs";
import { applicationZip, buildRegistry, cachedBundle, checkEnv, checkFiles, coreVersion, DEFAULT_PACK, download,
  installRegistry, packArgv, packFileName, parseTestAppOptions, PUBLIC_INDEX, remainingProcesses, run, sidecarEntries, step } from "../test-app.mjs";

const folder = (t, prefix = "window-check-test-app-") => {
  const path = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
};
const writeJson = (path, value) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
};
// The tracked programs of the run tests: the commands that the run starts, and the pack command and the `sok` of the registry tests.
const program = (name) => fileURLToPath(new URL(`../fixtures/test-app/${name}`, import.meta.url));
/** A copy of the tracked program `name` at `path`, with its mode, so that its log lands beside the copy. */
const copyProgram = (path, name) => {
  copyFileSync(program(name), path);
  return path;
};

/**
 * A server on a local address with the handlers of `routes`, `{ [path]: (request, response) => void }`, and the paths that it was asked
 * for. A path without a handler answers 404. It ends with the test.
 */
async function serve(t, routes) {
  const requested = [];
  const server = createServer((request, response) => {
    requested.push(request.url);
    if (routes[request.url]) routes[request.url](request, response);
    else response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return { url: `http://127.0.0.1:${server.address().port}`, requested };
}

test("the run uses the published application zip of the core release of this package for the platform that runs it", () => {
  assert.equal(coreVersion(), JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
  assert.deepEqual(applicationZip("0.0.41", "mygo", { platform: "darwin", arch: "arm64" }), { name: "soksak-0.0.41-darwin-arm64-mygo.zip",
    url: "https://github.com/soksak-app/core/releases/download/v0.0.41/soksak-0.0.41-darwin-arm64-mygo.zip" });
  assert.equal(applicationZip("0.0.41", "wailsv3", { platform: "linux", arch: "x64" }).name, "soksak-0.0.41-linux-x64-wailsv3.zip");
});

test("the options select the applications, the pack command, the checks and their time limit", () => {
  assert.deepEqual(parseTestAppOptions([], {}),
    { apps: [...APP_NAMES], pack: DEFAULT_PACK, index: undefined, checkTimeout: 3_600_000, checks: undefined });
  assert.deepEqual(parseTestAppOptions(["--app", "mygo"], {}).apps, ["mygo"]);
  assert.deepEqual(parseTestAppOptions([], { SOKSAK_APP: "wailsv3" }).apps, ["wailsv3"]);
  assert.deepEqual(parseTestAppOptions(["--pack", "pnpm pack --pack-destination {out}", "--check-timeout", "60", "e2e/a.test.mjs"], {}),
    { apps: [...APP_NAMES], pack: "pnpm pack --pack-destination {out}", index: undefined, checkTimeout: 60_000, checks: ["e2e/a.test.mjs"] });
  assert.throws(() => parseTestAppOptions(["--app", "other"], {}), /unknown SOKSAK_APP: other/);
  // Every check runs with the input that the host emulates inside the application, so no option selects checks of real input.
  assert.throws(() => parseTestAppOptions(["--real"], {}), /Unknown option '--real'/);
  assert.throws(() => parseTestAppOptions(["--check-timeout", "0"], {}), /--check-timeout 0 is not a positive number of seconds/);
  assert.throws(() => parseTestAppOptions(["--pack", "make pack"], {}), /names no \{out\}/);
  assert.deepEqual(packArgv(DEFAULT_PACK, "/r"), ["make", "pack", "OUT=/r"]);
});

test("--index names the registry index of the run, as a file URL or a path, and takes no --pack", () => {
  assert.deepEqual(parseTestAppOptions(["--index", "file:///r/build/index.json", "environment/a.test.mjs"], {}),
    { apps: [...APP_NAMES], pack: undefined, index: "/r/build/index.json", checkTimeout: 3_600_000, checks: ["environment/a.test.mjs"] });
  assert.equal(parseTestAppOptions(["--index", "build/index.json"], {}).index, "build/index.json");
  assert.throws(() => parseTestAppOptions(["--index", "https://example.invalid/index.json"], {}),
    /--index https:\/\/example\.invalid\/index\.json is no file URL and no path/);
  assert.throws(() => parseTestAppOptions(["--index", ""], {}), /--index names no index/);
  assert.throws(() => parseTestAppOptions(["--index", "build/index.json", "--pack", DEFAULT_PACK], {}),
    /--index installs from a built registry index; it takes no --pack/);
});

test("the checks are the test files under e2e/ outside e2e/fixtures/", (t) => {
  const root = folder(t);
  for (const file of ["e2e/a.test.mjs", "e2e/start.mjs", "e2e/test/helper.mjs", "e2e/person/b.test.mjs", "e2e/fixtures/p/test.mjs",
    "e2e/node_modules/x/c.test.mjs", "e2e/bench/test-d.mjs"]) {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), "");
  }
  assert.deepEqual(checkFiles(root), ["e2e/a.test.mjs", "e2e/bench/test-d.mjs", "e2e/person/b.test.mjs", "e2e/test/helper.mjs"]);
  assert.throws(() => checkFiles(folder(t)), /no test file under e2e\//);
});

test("the checks get the configuration root, the run folder and the executable of each application", () => {
  const executables = (bundle, host) => ({ application: `${bundle}/Contents/MacOS/sok-${host}`, sok: `${bundle}/Contents/MacOS/sok` });
  const all = new Map(APP_NAMES.map((host) => [host, executables(`/c/${host}/soksak.app`, host)]));
  assert.deepEqual(checkEnv("/root", all), { SOKSAK_CONFIG_ROOT: "/root", SOKSAK_RUN_FOLDER: "/root/run",
    SOKSAK_BINARY_WAILSV3: "/c/wailsv3/soksak.app/Contents/MacOS/sok-wailsv3", SOKSAK_BINARY_TAURIV2: "/c/tauriv2/soksak.app/Contents/MacOS/sok-tauriv2",
    SOKSAK_BINARY_MYGO: "/c/mygo/soksak.app/Contents/MacOS/sok-mygo" });
  const one = new Map([["mygo", executables("/c/soksak.app", "mygo")]]);
  assert.equal(checkEnv("/root", one).SOKSAK_APP, "mygo");
  assert.equal(checkEnv("/root", one, "file:///root/registry/index.json").SOKSAK_REGISTRY_INDEX, "file:///root/registry/index.json");
});

test("the sidecar entries of the run are copied from the public index; a dependency found nowhere is an error", () => {
  const index = { plugins: [], sidecars: [{ name: "@scope/sidecar-a", versions: [] }, { name: "@scope/sidecar-b", versions: [] }] };
  const plugins = [
    { manifest: { id: "checked", dependencies: { "@scope/sidecar-a": "^1.0.0", "@scope/fixture": "*" } }, pkg: { name: "@scope/checked" } },
    { manifest: { id: "fixture", dependencies: { "@scope/sidecar-a": "^1.0.0" } }, pkg: { name: "@scope/fixture" } },
  ];
  assert.deepEqual(sidecarEntries(index, plugins), [{ name: "@scope/sidecar-a", versions: [] }]);
  assert.throws(() => sidecarEntries(index, [{ manifest: { id: "checked", dependencies: { "@scope/missing": "*" } }, pkg: { name: "x" } }]),
    new RegExp(`plugin checked depends on @scope/missing, which is no plugin of the run and no sidecar of ${PUBLIC_INDEX.replaceAll(".", "\\.")}`));
});

test("a command ends at its time limit, at an interrupt and with its status, and a step names itself", async () => {
  const options = { cwd: tmpdir(), timeout: 5000 };
  assert.equal(await run(process.execPath, [program("command-probe.mjs"), "out"], { ...options, capture: true }), "out");
  await assert.rejects(run(process.execPath, [program("command-probe.mjs"), "fail3"], { ...options, capture: true }),
    /ended with status 3: bad/);
  await assert.rejects(run(process.execPath, [program("command-probe.mjs"), "wait"], { ...options, timeout: 200 }), /did not end in 0\.2s/);
  const interrupt = new AbortController();
  setTimeout(() => interrupt.abort("SIGINT"), 100);
  await assert.rejects(run(process.execPath, [program("command-probe.mjs"), "wait"], { ...options, signal: interrupt.signal }),
    /was interrupted by SIGINT/);
  await assert.rejects(run(process.execPath, [], { cwd: tmpdir() }), /a command runs with a time limit/);
  await assert.rejects(step("pack checked", () => { throw new Error("no make"); }), /^Error: pack checked: no make$/);
});

/**
 * The arguments of a program whose child ignores SIGTERM and writes its process id to `marker` once it waits, and the process id
 * that the child wrote, which `started` resolves with.
 */
function programWithChild(t, marker) {
  const started = new Promise((resolve) => {
    const read = () => { try { const pid = Number(readFileSync(marker, "utf8")); if (pid > 0) { watcher.close(); resolve(pid); } } catch {} };
    const watcher = watch(join(marker, ".."), read);
    read();
  });
  t.after(() => { try { process.kill(Number(readFileSync(marker, "utf8")), "SIGKILL"); } catch {} });
  return { args: [program("parent-with-child.mjs"), marker], started };
}

/**
 * Whether the process `pid` still runs, from its ps(1) state: a process that SIGKILL ended is absent, a zombie (Z) or exiting (E),
 * because the system ends it after the signal returns.
 */
const alive = (pid) => {
  const result = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
  const state = result.stdout.trim();
  return state !== "" && !state.startsWith("Z") && !state.slice(1).includes("E");
};

test("a command at its limit ends with every process it started", { timeout: 30000 }, async (t) => {
  const { args, started } = programWithChild(t, join(folder(t), "child"));
  // The limit is the real 5 s of the run; the test waits on the rejection of the run, not on a clock of its own.
  const outcome = run(process.execPath, args, { cwd: tmpdir(), timeout: 5000 });
  const child = await started;
  await assert.rejects(outcome, /did not end in 5s/);
  assert.equal(alive(child), false, `the child ${child} of the command still runs`);
});

test("an interrupted command ends with every process it started, also one that ignores SIGTERM", { timeout: 30000 }, async (t) => {
  const { args, started } = programWithChild(t, join(folder(t), "child"));
  const interrupt = new AbortController();
  const outcome = run(process.execPath, args, { cwd: tmpdir(), timeout: 60000, signal: interrupt.signal });
  const child = await started;
  interrupt.abort("SIGINT");
  await assert.rejects(outcome, /was interrupted by SIGINT/);
  assert.equal(alive(child), false, `the child ${child} of the command still runs`);
});

test("a download writes its file whole or leaves none", async (t) => {
  const dir = folder(t);
  const file = join(dir, "a.zip");
  const host = await serve(t, {
    "/a.zip": (request, response) => response.end("zip"),
    // The server ends the connection after a part of the body, as a network that resets does.
    "/c.zip": (request, response) => { response.write("part"); setTimeout(() => response.destroy(), 20); },
    // The server never answers.
    "/d.zip": () => {},
  });
  await download(`${host.url}/a.zip`, file);
  assert.equal(readFileSync(file, "utf8"), "zip");
  await assert.rejects(download(`${host.url}/b.zip`, join(dir, "b.zip")), /b\.zip: HTTP 404/);
  await assert.rejects(download(`${host.url}/c.zip`, join(dir, "c.zip")), /terminated|reset|aborted/i);
  assert.equal(existsSync(join(dir, "c.zip")), false);
  assert.equal(existsSync(join(dir, "c.zip.partial")), false);
  await assert.rejects(download(`${host.url}/d.zip`, join(dir, "d.zip"), { timeout: 50 }), /timeout|aborted/i);
});

test("on a platform that declares no application artifact the run fails by the operation before any download", async (t) => {
  const host = await serve(t, {});
  for (const platform of ["linux", "win32"]) {
    const cache = folder(t);
    await assert.rejects(cachedBundle(cache, "0.0.41", "mygo", { platform, arch: "x64", releases: host.url }),
      new RegExp(`^PlatformOperationNotImplemented: applicationBundle is not implemented on ${platform}$`));
    assert.deepEqual(host.requested, []);
    assert.deepEqual(readdirSync(cache), []);
  }
});

/** A plugin repository with one fixture plugin under e2e/fixtures; `manifest` changes the plugin.json of the repository. */
function repository(t, manifest = {}) {
  const root = folder(t);
  const pkg = (name) => ({ name, version: "1.0.0", description: "d", license: "MIT", repository: "git+https://example.invalid/r.git", engines: { soksak: "*" } });
  writeJson(join(root, "plugin.json"), { id: "checked", name: "Checked", dependencies: { "@scope/sidecar-a": "^1.0.0" }, ...manifest });
  writeJson(join(root, "package.json"), pkg("@scope/checked"));
  writeJson(join(root, "e2e", "fixtures", "probe", "fixture", "plugin.json"), { id: "fixture", name: "Fixture" });
  writeJson(join(root, "e2e", "fixtures", "probe", "fixture", "package.json"), pkg("@scope/fixture"));
  return root;
}

/** The pack command, `pnpm` and `sok` of the registry tests in `dir`, as copies of the tracked programs; `sok` logs beside its copy. */
function tools(dir) {
  const pack = copyProgram(join(dir, "pack"), "pack.mjs");
  return { pack: `${pack} {out}`, pnpm: copyProgram(join(dir, "pnpm"), "pack.mjs"), sok: copyProgram(join(dir, "sok"), "sok.mjs") };
}

/** A server that answers the public registry index of a run with `index`. */
const indexHost = async (t, index) => {
  const host = await serve(t, { "/index.json": (request, response) => response.setHeader("content-type", "application/json").end(JSON.stringify(index)) });
  return { ...host, indexUrl: `${host.url}/index.json` };
};

test("the check registry holds the release of the repository, the start probe, the fixture plugins and the sidecars they name", async (t) => {
  const root = repository(t);
  const registry = join(folder(t), "registry");
  const { pack, pnpm, sok } = tools(folder(t));
  const index = { plugins: [], sidecars: [{ name: "@scope/sidecar-a", repository: "r", versions: [] }, { name: "@scope/other", versions: [] }] };
  const host = await indexHost(t, index);
  const built = await buildRegistry({ root, folder: registry, sok, pack, pnpm, indexUrl: host.indexUrl });
  assert.deepEqual(host.requested, ["/index.json"]);
  assert.deepEqual(built, { index: join(registry, "index.json"), ids: ["checked", "fixture", START_PROBE] });
  const entry = JSON.parse(readFileSync(join(registry, "plugins", "checked.json"), "utf8"));
  const release = join(registry, "releases", packFileName("@scope/checked", "1.0.0"));
  assert.equal(entry.repository, "https://example.invalid/r");
  assert.deepEqual(entry.versions[0].release.url, pathToFileURL(release).href);
  assert.deepEqual(entry.versions[0].sidecars, { "@scope/sidecar-a": "^1.0.0" });
  assert.ok(existsSync(join(registry, "plugins", `${START_PROBE}.json`)));
  assert.deepEqual(JSON.parse(readFileSync(join(registry, "sidecars", "scope-sidecar-a.json"), "utf8")), index.sidecars[0]);
  assert.equal(existsSync(join(registry, "sidecars", "scope-other.json")), false);
  assert.deepEqual(JSON.parse(readFileSync(join(registry, "revoked.json"), "utf8")), { plugins: [], sidecars: [] });
});

test("a check registry fails at the step that fails, and a plugin id of the repository that the start probe has is refused", async (t) => {
  const { pack, pnpm, sok } = tools(folder(t));
  // The port of a server that ended refuses the connection, as an address without a network does.
  const ended = createServer();
  await new Promise((resolve) => ended.listen(0, "127.0.0.1", resolve));
  const { port } = ended.address();
  await new Promise((resolve) => ended.close(resolve));
  await assert.rejects(buildRegistry({ root: repository(t), folder: join(folder(t), "r"), sok, pack, pnpm, indexUrl: `http://127.0.0.1:${port}/index.json` }),
    /public registry index: /);
  await assert.rejects(buildRegistry({ root: repository(t), folder: join(folder(t), "r"), sok, pack: `${process.execPath} ${program("command-probe.mjs")} fail4 {out}`, pnpm }),
    /pack checked: .* ended with status 4/);
  await assert.rejects(buildRegistry({ root: repository(t, { id: START_PROBE, dependencies: {} }), folder: join(folder(t), "r"), sok, pack, pnpm }),
    /the plugin id startprobe of the start probe of @soksak\/window-check is also the id of \./);
  await assert.rejects(buildRegistry({ root: folder(t), folder: join(folder(t), "r"), sok, pack, pnpm }), /holds no plugin\.json/);
});

test("with --index the run builds no registry and sets that index in each application, whose first run installs its starter pack", async (t) => {
  const root = folder(t);
  const tooling = folder(t);
  const { sok } = tools(tooling);
  const config = folder(t);
  const executables = new Map(["mygo", "wailsv3"].map((host) => [host, { application: join(tooling, `sok-${host}`), sok }]));
  const configDir = (host) => join(config, host);
  const index = join(folder(t), "build", "index.json");
  writeJson(index, { format: 1, plugins: [], sidecars: [], packs: [] });
  const failing = `${process.execPath} ${program("command-probe.mjs")} fail4 {out}`;
  const host = await indexHost(t, { plugins: [], sidecars: [] });
  const recorded = await installRegistry({ root, folder: join(config, "registry"), executables, configDir, index, pack: failing,
    indexUrl: host.indexUrl });
  assert.deepEqual(host.requested, [], "the run fetched the public index");
  assert.equal(recorded, pathToFileURL(index).href);
  assert.equal(existsSync(join(config, "registry")), false);
  const calls = readFileSync(`${sok}.log`, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(calls, ["mygo", "wailsv3"].map((host) => ["registry", "use", index, "--config-dir", configDir(host)]));
  const missing = join(root, "none.json");
  await assert.rejects(installRegistry({ root, folder: join(config, "registry"), executables, configDir, index: missing }),
    new RegExp(`^Error: registry index ${missing.replaceAll(".", "\\.")}: cannot read it: .*ENOENT`));
  const broken = join(root, "broken.json");
  writeFileSync(broken, "{");
  await assert.rejects(installRegistry({ root, folder: join(config, "registry"), executables, configDir, index: broken }),
    new RegExp(`^Error: registry index ${broken.replaceAll(".", "\\.")}: cannot read it: `));
});

test("without --index the run installs every plugin of the check registry into each application", async (t) => {
  const root = repository(t, { dependencies: {} });
  const tooling = folder(t);
  const { pack, pnpm, sok } = tools(tooling);
  const config = folder(t);
  const executables = new Map([["mygo", { application: join(tooling, "sok-mygo"), sok }]]);
  const configDir = (host) => join(config, host);
  const registry = join(config, "registry");
  const host = await indexHost(t, { plugins: [], sidecars: [] });
  const recorded = await installRegistry({ root, folder: registry, executables, configDir, pack, pnpm, indexUrl: host.indexUrl });
  assert.equal(recorded, pathToFileURL(join(registry, "index.json")).href);
  const calls = readFileSync(`${sok}.log`, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(calls.slice(1), [["registry", "use", join(registry, "index.json"), "--config-dir", configDir("mygo")],
    ...["checked", "fixture", START_PROBE].map((id) => ["plugin", "install", id, "--config-dir", configDir("mygo")])]);
});

test("the remaining processes are those whose command line names a path of the run, except this one", () => {
  const processes = [{ pid: 10, command: "/c/soksak.app/Contents/MacOS/sok-mygo --config-dir /root/x" }, { pid: process.pid, command: "node /root/x" },
    { pid: 11, command: "/usr/bin/other" }];
  assert.deepEqual(remainingProcesses(processes, ["/root", "/c/soksak.app"]), ["10 /c/soksak.app/Contents/MacOS/sok-mygo --config-dir /root/x"]);
});

test("the run modules name no real plugin", () => {
  for (const file of ["../test-app.mjs", "../sok-test-app.mjs", "../catalog.mjs", "../platform/platform.mjs", "../platform/darwin.mjs"]) {
    assert.doesNotMatch(readFileSync(new URL(file, import.meta.url), "utf8"), /["'](layoutprobe|terminal|term|browser|files|editor|hwp)["'.]/);
  }
});

test("the run module names no macOS program, bundle layout or quit key of its own", () => {
  const source = readFileSync(new URL("../test-app.mjs", import.meta.url), "utf8");
  for (const word of [/"darwin-arm64"/, /"Contents"/, /"MacOS"/, /"ditto"/, /"lockf"/, /"ps"/, /"cmd\+q"/, /"command"\]/]) {
    assert.doesNotMatch(source, word);
  }
});
