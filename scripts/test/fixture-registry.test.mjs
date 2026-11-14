import assert from "node:assert/strict";
import test from "node:test";

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, globSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, watch,
  writeFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { processRuns } from "@soksak/window-check/process-group.mjs";
import { releasePlatform } from "../platform/platform.js";
import { FIXTURES, STEP_TIMEOUT_MS, WRONG_SHA256, buildFixtureRegistry, fixturePluginIds, fixtureRegistry, fixtureSources, main, nextPatch, npmSidecarRelease, pluginEntry,
  readIndex, repositoryText, servedIndex, serveRegistry, sidecarEntry, sidecarFileName, withRevoked, withWrongHash } from "../fixture-registry.mjs";

const SHA = "a".repeat(64);
const MODULE = fileURLToPath(new URL("../fixture-registry.mjs", import.meta.url));
// The tracked inputs of the pack and release tests: the executable of a sidecar fixture and the prepack script of a slow plugin fixture.
const SIDECAR_WORKER = fileURLToPath(new URL("./fixtures/fixture-registry/sidecar/bin/worker", import.meta.url));
const SIDECAR_NPM_MANIFEST = fileURLToPath(new URL("./fixtures/fixture-registry/sidecar/package-manifest.json", import.meta.url));
const SIDECAR_DECLARATION = fileURLToPath(new URL("./fixtures/fixture-registry/sidecar/sidecar-manifest.json", import.meta.url));
const HOLD_PACK = fileURLToPath(new URL("./fixtures/fixture-registry/hold.mjs", import.meta.url));
/** The sok that `make build-sok` builds. The registry build runs it, so a missing build is an error that names the file and the command. */
const SOK = fileURLToPath(new URL("../../target/debug/sok", import.meta.url));
function requireSok() {
  if (!existsSync(SOK)) throw new Error(`${SOK} is not built; run make build-sok`);
  return SOK;
}

/** A fixtures folder in a disposable folder that holds copies of the tracked fixture plugins `ids`, without their node_modules. */
function copiedFixtures(t, ids) {
  const work = mkdtempSync(join(tmpdir(), "fixture-registry-copies-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const fixtures = join(work, "fixtures");
  const sources = fixtureSources().plugins.filter((dir) => ids.includes(JSON.parse(readFileSync(join(dir, "plugin.json"), "utf8")).id));
  assert.equal(sources.length, ids.length, `e2e/fixtures lacks a plugin of ${ids.join(", ")}`);
  for (const dir of sources) cpSync(dir, join(fixtures, basename(dir)), { recursive: true, filter: (source) => !source.split("/").includes("node_modules") });
  return { work, fixtures, out: join(work, "registry") };
}

/** A disposable folder that holds the registry folder `registry` with one release, and next to it a file that is outside the registry. */
function registryToServe(t) {
  const root = mkdtempSync(join(tmpdir(), "fixture-registry-serve-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const folder = join(root, "registry");
  mkdirSync(join(folder, "releases"), { recursive: true });
  writeFileSync(join(folder, "releases", "a b.tgz"), "release");
  writeFileSync(join(root, "outside.txt"), "outside");
  return { root, folder };
}

test("registry entries carry the declarations of package.json and the file URL and hash of each release", { timeout: 1000 }, () => {
  const pkg = {
    name: "@scope/plugin-probe", version: "0.0.1", description: "Probe plugin.", license: "MIT",
    repository: { type: "git", url: "git+https://example.invalid/probe.git", directory: "plugins/probe" },
    engines: { soksak: "^0.0.1" },
  };
  const manifest = { id: "probe", name: "검사", dependencies: { "@scope/sidecar-worker": "^0.0.1" } };
  assert.deepEqual(pluginEntry(manifest, pkg, { release: "/releases/a b/probe-0.0.1.tgz", sha256: SHA }, new Set(["@scope/sidecar-worker"])), {
    id: "probe", package: "@scope/plugin-probe", name: "검사", description: "Probe plugin.", license: "MIT",
    repository: "git+https://example.invalid/probe.git",
    versions: [{ version: "0.0.1", release: { url: "file:///releases/a%20b/probe-0.0.1.tgz", sha256: SHA },
      engines: { soksak: "^0.0.1" }, sidecars: { "@scope/sidecar-worker": "^0.0.1" } }],
  });
  assert.deepEqual(pluginEntry({ id: "plain", name: "P" }, pkg, { release: "/r/p.tgz", sha256: SHA }, new Set()).versions[0].sidecars, {});
  // A dependency on a plugin is not a sidecar of the entry; the index lists only sidecar dependencies.
  const contributor = { id: "contributor", name: "C", dependencies: { "@scope/plugin-provider": ">=1.0.0", "@scope/sidecar-worker": "^0.0.1" } };
  assert.deepEqual(pluginEntry(contributor, pkg, { release: "/r/c.tgz", sha256: SHA }, new Set(["@scope/sidecar-worker"])).versions[0].sidecars,
    { "@scope/sidecar-worker": "^0.0.1" });
  assert.deepEqual(sidecarEntry({ name: "@scope/sidecar-worker", version: "0.0.1", repository: "https://example.invalid/w" },
    { executable: "build/worker", protocol: 1 }, { platform: "darwin-arm64", release: "/r/w.tar.gz", sha256: SHA }), {
    name: "@scope/sidecar-worker", repository: "https://example.invalid/w",
    versions: [{ version: "0.0.1", protocol: 1, releases: { "darwin-arm64": { url: "file:///r/w.tar.gz", sha256: SHA } } }],
  });
  assert.throws(() => repositoryText({ type: "git" }), /package.json repository has no url/);
  assert.equal(sidecarFileName("@scope/sidecar-worker"), "scope-sidecar-worker");
  assert.equal(sidecarFileName("worker"), "worker");
});

test("the sources of the fixture registry are exactly the plugin folders and sidecar fixture folders of e2e/fixtures",{ timeout: 5000 }, () => {
  const folders = (pattern) => globSync(pattern, { cwd: FIXTURES, exclude: (name) => name === "node_modules" || name === "target" })
    .map((file) => join(FIXTURES, dirname(file))).sort();
  const plugins = folders("**/plugin.json");
  assert.ok(plugins.length > 0, "e2e/fixtures holds no plugin folder");
  assert.deepEqual(fixtureSources(), { plugins, sidecars: folders("sidecars/**/sidecar.json") });
});

test("the package.json of each fixture plugin has the description of 1 to 200 characters that a registry entry requires", { timeout: 5000 }, () => {
  // docs/spec/installation.md#registry-index: the registry entry takes its description from package.json, and sok registry build
  // rejects one outside 1 to 200 Unicode code points.
  const outside = fixtureSources().plugins.map((dir) => [relative(FIXTURES, dir), JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).description])
    .filter(([, description]) => typeof description !== "string" || [...description].length < 1 || [...description].length > 200);
  assert.deepEqual(outside, []);
});

test("the fixture registry packs every fixture plugin of its root into the pack fixtures and lists exactly those plugins", { timeout: 60000 }, async (t) => {
  const { fixtures, out } = copiedFixtures(t, ["layoutprobe", "probeplain"]);
  const { plugins, sidecars } = fixtureSources(fixtures);
  const built = await buildFixtureRegistry(requireSok(), out, { root: fixtures });
  // The registry build of sok reads each release, compares its hash and reads its plugin.json, so a release that was not packed fails it.
  assert.deepEqual([built.plugins, built.sidecars, built.packs], [plugins.length, sidecars.length, 1]);
  assert.equal(readFileSync(built.index, "utf8"), readFileSync(join(out, "index.json"), "utf8"));
  const ids = plugins.map((dir) => JSON.parse(readFileSync(join(dir, "plugin.json"), "utf8")).id);
  assert.deepEqual(JSON.parse(readFileSync(join(out, "packs", "fixtures.json"), "utf8")),
    { name: "fixtures", description: "Every fixture plugin of the core fixtures.", plugins: ids });
  assert.deepEqual(JSON.parse(readFileSync(join(out, "index.json"), "utf8")).plugins.map((plugin) => plugin.id), [...ids].sort(),
    "the index lists a plugin that is not in the root, or lacks one that is");
  assert.deepEqual(fixturePluginIds(fixtures), ids, "fixturePluginIds names the plugins of the pack fixtures in its order");
  assert.deepEqual(readdirSync(join(out, "plugins")).sort(), ids.map((id) => `${id}.json`).sort());
  assert.deepEqual(JSON.parse(readFileSync(join(out, "revoked.json"), "utf8")), { plugins: [], sidecars: [] });
  // The pack of every plugin of e2e/fixtures is the pack of the registry that the window checks install from.
  const declared = globSync("**/plugin.json", { cwd: FIXTURES, exclude: (name) => name === "node_modules" || name === "target" })
    .map((file) => JSON.parse(readFileSync(join(FIXTURES, file), "utf8")).id);
  assert.deepEqual([...fixturePluginIds()].sort(), declared.sort());
  // The module imports only Node.js built-ins, the platform selector and the command supervision and names no address, so it reads no registry index or
  // plugin repository.
  const source = readFileSync(MODULE, "utf8");
  assert.deepEqual([...source.matchAll(/^import .* from "([^"]+)";$/gm)].map(([, from]) => from).filter((from) => !from.startsWith("node:")),
    ["./platform/platform.js", "./test-command.mjs"]);
  // The loopback address of serveRegistry is the address that the module serves, not an address that it reads a registry from.
  assert.doesNotMatch(source, /https?:\/\/(?!127\.0\.0\.1)|\bfetch\(|target\/registry|workspace-registry/);
});

test("a sidecar fixture of the fixtures is released with npm pack under its platform name and listed as the sidecar of its plugin", { timeout: 60000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "fixture-registry-root-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sidecar = join(root, "sidecars", "worker");
  mkdirSync(join(sidecar, "bin"), { recursive: true });
  copyFileSync(SIDECAR_NPM_MANIFEST, join(sidecar, "package.json"));
  copyFileSync(SIDECAR_DECLARATION, join(sidecar, "sidecar.json"));
  copyFileSync(SIDECAR_WORKER, join(sidecar, "bin", "worker"));
  chmodSync(join(sidecar, "bin", "worker"), 0o755);
  const plugin = join(root, "probe", "user");
  mkdirSync(plugin, { recursive: true });
  writeFileSync(join(plugin, "package.json"), JSON.stringify({ name: "@sok-check/user", version: "0.0.1", description: "User.", license: "MIT",
    repository: "git+https://example.invalid/core.git", engines: { soksak: "*" }, files: ["plugin.json"] }));
  writeFileSync(join(plugin, "plugin.json"), JSON.stringify({ id: "user", name: "User", dependencies: { "@sok-check/worker": "^0.0.1" } }));
  mkdirSync(join(root, "probe", "node_modules", "skipped"), { recursive: true });
  writeFileSync(join(root, "probe", "node_modules", "skipped", "plugin.json"), "{}");
  assert.deepEqual(fixtureSources(root), { plugins: [plugin], sidecars: [sidecar] });
  const out = join(root, "registry");
  const built = await buildFixtureRegistry(requireSok(), out, { root });
  assert.deepEqual([built.plugins, built.sidecars, built.packs], [1, 1, 1]);
  const entry = JSON.parse(readFileSync(join(out, "sidecars", "sok-check-worker.json"), "utf8"));
  const platform = releasePlatform();
  const release = entry.versions[0].releases[platform];
  assert.equal(fileURLToPath(release.url), join(resolve(out), "releases", `sok-check-worker-0.0.1-${platform}.tgz`));
  assert.match(release.sha256, /^[0-9a-f]{64}$/);
  assert.equal(entry.versions[0].protocol, 1);
  assert.deepEqual(JSON.parse(readFileSync(join(out, "plugins", "user.json"), "utf8")).versions[0].sidecars, { "@sok-check/worker": "^0.0.1" });
});

test("a sidecar fixture whose declared executable is not built is not released", { timeout: 5000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "fixture-registry-unbuilt-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sidecar = join(root, "sidecars", "worker");
  mkdirSync(sidecar, { recursive: true });
  copyFileSync(SIDECAR_NPM_MANIFEST, join(sidecar, "package.json"));
  copyFileSync(SIDECAR_DECLARATION, join(sidecar, "sidecar.json"));
  const out = join(root, "releases");
  await assert.rejects(npmSidecarRelease(sidecar, out, { platform: "linux-x64" }),
    new RegExp(`pack sidecar ${sidecar}: sidecar.json executable bin/worker is not an executable file; build the sidecar first`));
  mkdirSync(join(sidecar, "bin"));
  copyFileSync(SIDECAR_WORKER, join(sidecar, "bin", "worker"));
  chmodSync(join(sidecar, "bin", "worker"), 0o644);
  await assert.rejects(npmSidecarRelease(sidecar, out, { platform: "linux-x64" }), /bin\/worker is not an executable file/);
  assert.equal(existsSync(out) ? readdirSync(out).length : 0, 0, "a release was written");
});

test("a build folder of a sidecar fixture holds no fixture source",{ timeout: 5000 }, (t) => {
  const root = mkdtempSync(join(tmpdir(), "fixture-registry-target-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sidecar = join(root, "sidecars", "worker");
  mkdirSync(join(sidecar, "target", "release", "copy"), { recursive: true });
  writeFileSync(join(sidecar, "sidecar.json"), "{}");
  writeFileSync(join(sidecar, "target", "release", "copy", "sidecar.json"), "{}");
  assert.deepEqual(fixtureSources(root), { plugins: [], sidecars: [sidecar] });
});

/** A fixtures root of one plugin whose prepack script holds the real pnpm pack for 30 seconds, so the step limit or the end of the build ends the pack. */
function slowPackFixture(t) {
  const work = mkdtempSync(join(tmpdir(), "fixture-registry-slow-"));
  const plugin = join(work, "fixtures", "probe");
  mkdirSync(plugin, { recursive: true });
  writeFileSync(join(plugin, "plugin.json"), JSON.stringify({ id: "probe", name: "Probe" }));
  writeFileSync(join(plugin, "package.json"), JSON.stringify({ name: "@sok-check/probe", version: "0.0.1", repository: "https://example.invalid/core",
    scripts: { prepack: "node hold.mjs" } }));
  copyFileSync(HOLD_PACK, join(plugin, "hold.mjs"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  return { work, root: join(work, "fixtures"), plugin, out: join(work, "registry") };
}

/**
 * Resolves with the process id of the held pack when the prepack program of the slow fixture has written its file `held`. Call it
 * before the build starts: the watch of the plugin folder exists before the file does. The watch ends with the test, so a test that
 * fails before the file appears does not keep the test process alive.
 */
function packHeld(t, plugin) {
  let watcher;
  const held = new Promise((resolve) => {
    watcher = watch(plugin, (_, name) => {
      if (name !== "held") return;
      watcher.close();
      resolve(Number(readFileSync(join(plugin, "held"), "utf8")));
    });
  });
  t.after(() => watcher.close());
  return held;
}


test("a pack that exceeds the step limit fails the fixture registry build with the step that timed out", { timeout: 20000 }, async (t) => {
  const fixture = slowPackFixture(t);
  const started = performance.now();
  await assert.rejects(buildFixtureRegistry(requireSok(), fixture.out, { root: fixture.root, timeoutMs: 300 }),
    (error) => error.message.startsWith(`pack ${fixture.plugin}: timeout: `));
  assert.ok(performance.now() - started < 10000, "the build did not stop at the step limit");
  assert.equal(existsSync(join(fixture.out, "index.json")), false, "the registry build ran after the failed pack");
});

test("an aborted signal stops the fixture registry build in its running step", { timeout: 20000 }, async (t) => {
  const fixture = slowPackFixture(t);
  const controller = new AbortController();
  const held = packHeld(t, fixture.plugin);
  const started = performance.now();
  const build = buildFixtureRegistry(requireSok(), fixture.out, { root: fixture.root, signal: controller.signal });
  const pid = await held;
  controller.abort();
  await assert.rejects(build, (error) => error.message.startsWith(`pack ${fixture.plugin}: cancelled: `));
  assert.ok(performance.now() - started < 10000, "the build did not stop at the abort");
  assert.equal(processRuns(pid), false, "the held pack outlived the build");
  assert.equal(existsSync(join(fixture.out, "index.json")), false, "the registry build ran after the cancelled pack");
});

test("the fixture registry bounds each step at 30000 ms", { timeout: 1000 }, () => {
  assert.equal(STEP_TIMEOUT_MS, 30000);
});

test("the command line ends its build when the process receives SIGTERM and removes its signal handlers", { timeout: 20000 }, async (t) => {
  const fixture = slowPackFixture(t);
  const held = packHeld(t, fixture.plugin);
  const child = spawn(process.execPath, [MODULE, "--sok", requireSok(), "--out", fixture.out, "--root", fixture.root], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const ended = new Promise((resolve) => child.on("close", (code) => resolve(code)));
  const pid = await held;
  child.kill("SIGTERM");
  assert.equal(await ended, 1);
  assert.match(stderr, new RegExp(`pack ${fixture.plugin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: cancelled: `));
  assert.equal(processRuns(pid), false, "the held pack outlived the command line");
  const missing = spawnSync(process.execPath, [MODULE, "--sok", SOK], { encoding: "utf8" });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /--out is required/);
});

test("the command line returns the result of its build and leaves the signal handlers of the process as they were", { timeout: 60000 }, async (t) => {
  const { fixtures, out } = copiedFixtures(t, ["probeplain"]);
  const names = ["SIGTERM", "SIGINT", "SIGHUP"];
  const before = names.map((name) => process.listenerCount(name));
  const built = await main(["--sok", requireSok(), "--out", out, "--root", fixtures]);
  assert.deepEqual([built.plugins, built.sidecars, built.packs], [1, 0, 1]);
  assert.deepEqual(names.map((name) => process.listenerCount(name)), before);
});

test("the index variants of a registry check break a hash, revoke a version and serve the releases from an address", { timeout: 1000 }, () => {
  assert.equal(nextPatch("0.0.40"), "0.0.41");
  assert.equal(nextPatch("1.9.9"), "1.9.10");
  assert.throws(() => nextPatch("0.1"), /"0.1" is not a version major.minor.patch/);
  const index = {
    plugins: [{ id: "probe", versions: [
      { version: "0.0.40", release: { url: "file:///registry/a%20b/releases/probe-0.0.40.tgz", sha256: SHA } },
      { version: "0.0.41", release: { url: "file:///registry/a%20b/releases/probe-0.0.41.tgz", sha256: SHA } }] }],
    sidecars: [{ name: "@sok-check/worker", versions: [{ version: "0.0.1",
      releases: { "darwin-arm64": { url: "file:///registry/a%20b/releases/w.tgz", sha256: SHA } } }] }],
    packs: [], revoked: { plugins: [], sidecars: [] },
  };
  const original = structuredClone(index);
  assert.equal(WRONG_SHA256, "0".repeat(64));
  assert.deepEqual(withWrongHash(index, "probe", "0.0.41").plugins[0].versions.map((item) => item.release.sha256), [SHA, WRONG_SHA256]);
  assert.deepEqual(withRevoked(index, "probe", "0.0.40", "check").revoked,
    { plugins: [{ id: "probe", version: "0.0.40", reason: "check" }], sidecars: [] });
  assert.throws(() => withWrongHash(index, "other", "0.0.40"), /the registry index lists no plugin other/);
  assert.throws(() => withRevoked(index, "probe", "9.9.9", "check"), /the registry index lists no version 9.9.9 of probe/);
  const served = servedIndex(index, "/registry/a b", "base:");
  assert.deepEqual([served.plugins[0].versions[1].release, served.sidecars[0].versions[0].releases["darwin-arm64"]],
    [{ url: "base:/releases/probe-0.0.41.tgz", sha256: SHA }, { url: "base:/releases/w.tgz", sha256: SHA }]);
  assert.deepEqual(index, original, "a variant changed the index it was derived from");
});

test("readIndex reads the registry index of a file address and its folder", { timeout: 1000 }, (t) => {
  const folder = mkdtempSync(join(tmpdir(), "fixture-registry-index-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  writeFileSync(join(folder, "index.json"), JSON.stringify({ plugins: [] }));
  assert.deepEqual(readIndex(pathToFileURL(join(folder, "index.json")).href), { folder, index: { plugins: [] } });
  assert.throws(() => readIndex(null), /the registry null is no file address/);
  assert.throws(() => readIndex("base:/index.json"), /the registry "base:\/index.json" is no file address/);
});

test("a registry build lists a fixture plugin in the versions that a check names, each packed from a copy that names its version", { timeout: 60000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "fixture-registry-versions-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixtures = join(root, "fixtures");
  const plugin = join(fixtures, "probe");
  mkdirSync(join(plugin, "ui"), { recursive: true });
  mkdirSync(join(plugin, "node_modules", "skipped"), { recursive: true });
  const pkg = { name: "@sok-check/probe", version: "0.0.40", description: "Probe.", license: "MIT",
    repository: "git+https://example.invalid/core.git", engines: { soksak: "*" }, files: ["plugin.json", "ui"] };
  writeFileSync(join(plugin, "package.json"), JSON.stringify(pkg));
  writeFileSync(join(plugin, "plugin.json"), JSON.stringify({ id: "probe", name: "Probe" }));
  writeFileSync(join(plugin, "ui", "page.html"), "<p>probe</p>\n");
  const other = join(fixtures, "other");
  mkdirSync(other);
  writeFileSync(join(other, "package.json"), JSON.stringify({ ...pkg, name: "@sok-check/other" }));
  writeFileSync(join(other, "plugin.json"), JSON.stringify({ id: "other", name: "Other" }));
  const out = join(root, "registry");
  const sok = requireSok();
  await buildFixtureRegistry(sok, out, { root: fixtures,
    versions: { probe: [{ version: "0.0.40", engines: ">=0.0.1 <99.0.0" }, { version: "0.0.41", engines: ">=99.0.0" }] } });
  assert.deepEqual(readdirSync(join(out, "releases")).sort(), ["sok-check-other-0.0.40.tgz", "sok-check-probe-0.0.40.tgz", "sok-check-probe-0.0.41.tgz"],
    "the plugin without versions is packed from its folder, and the plugin with versions from one copy for each version");
  const entry = JSON.parse(readFileSync(join(out, "plugins", "probe.json"), "utf8"));
  assert.equal(entry.package, "@sok-check/probe");
  assert.deepEqual(entry.versions.map((item) => [item.version, item.engines.soksak]), [["0.0.40", ">=0.0.1 <99.0.0"], ["0.0.41", ">=99.0.0"]]);
  assert.deepEqual(entry.versions.map((item) => fileURLToPath(item.release.url)),
    ["0.0.40", "0.0.41"].map((version) => join(resolve(out), "releases", `sok-check-probe-${version}.tgz`)));
  assert.ok(existsSync(join(out, "copies", "probe-0.0.41", "ui", "page.html")), "the copy has no page");
  assert.ok(!existsSync(join(out, "copies", "probe-0.0.41", "node_modules")), "the copy holds node_modules");
  assert.deepEqual(JSON.parse(readFileSync(join(out, "copies", "probe-0.0.41", "package.json"), "utf8")),
    { ...pkg, version: "0.0.41", engines: { soksak: ">=99.0.0" } });
  assert.deepEqual(JSON.parse(readFileSync(join(plugin, "package.json"), "utf8")), pkg, "the fixture itself changed");
  assert.deepEqual(JSON.parse(readFileSync(join(out, "plugins", "other.json"), "utf8")).versions.map((item) => item.version), ["0.0.40"]);
  await assert.rejects(buildFixtureRegistry(sok, out, { root: fixtures, versions: { missing: [{ version: "0.0.1" }] } }),
    /versions name no fixture plugin: missing/);
  await assert.rejects(buildFixtureRegistry(sok, out, { root: fixtures, versions: { probe: [] } }), /versions of probe list no version/);
});

test("serveRegistry answers its documents and the files inside the registry folder and nothing else", { timeout: 20000 }, async (t) => {
  const { root, folder } = registryToServe(t);
  // A self-signed certificate of the loopback address, made by the real openssl as `make create-test-certificates` makes its certificates.
  const cert = join(root, "server.pem");
  const key = join(root, "server-key.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1",
    "-keyout", key, "-out", cert], { stdio: "pipe" });
  const server = await serveRegistry(folder, { "/good/index.json": { plugins: [] } }, { cert: readFileSync(cert), key: readFileSync(key) });
  t.after(server.close);
  assert.match(server.base, /^https:\/\/127\.0\.0\.1:\d+$/);
  const { port } = new URL(server.base);
  // The path goes to the server as it is written, so the encoded dot segments reach it without a client that resolves them.
  const get = (path) => new Promise((resolve, reject) => {
    httpsRequest({ host: "127.0.0.1", port, path, ca: readFileSync(cert) }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve([response.statusCode, Buffer.concat(chunks).toString()]));
    }).on("error", reject).end();
  });
  assert.deepEqual(await get("/good/index.json"), [200, "{\"plugins\":[]}"]);
  assert.deepEqual(await get("/releases/a%20b.tgz"), [200, "release"]);
  assert.equal((await get("/releases/none.tgz"))[0], 404);
  assert.equal((await get("/releases"))[0], 404);
  assert.equal((await get("/%2E%2E/outside.txt"))[0], 404);
  await Promise.all([server.close(), server.close()]);
  await assert.rejects(get("/good/index.json"));
});

/** The folders that fixtureRegistry creates in the temporary folder. */
const registryFolders = () => readdirSync(tmpdir()).filter((name) => name.startsWith("soksak-fixture-registry-")).sort();

test("a fixture registry is a new folder that the fixture registry build writes under the signal, and a failed build removes it", { timeout: 60000 }, async (t) => {
  const { fixtures } = copiedFixtures(t, ["probeplain"]);
  const folder = await fixtureRegistry({ sok: requireSok(), root: fixtures, signal: new AbortController().signal });
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  assert.equal(JSON.parse(readFileSync(join(folder, "index.json"), "utf8")).plugins[0].id, "probeplain");
  // A plugin folder without package.json fails the build at its read.
  const broken = mkdtempSync(join(tmpdir(), "fixture-registry-broken-"));
  t.after(() => rmSync(broken, { recursive: true, force: true }));
  mkdirSync(join(broken, "probe"));
  writeFileSync(join(broken, "probe", "plugin.json"), JSON.stringify({ id: "probe", name: "Probe" }));
  const before = registryFolders();
  await assert.rejects(fixtureRegistry({ sok: SOK, root: broken }), /ENOENT.*package\.json/);
  assert.deepEqual(registryFolders(), before, "the failed build left its folder");
});

test("a failed fixture registry build whose folder cannot be removed rejects with both failures", { timeout: 20000 }, async (t) => {
  const sok = requireSok();
  // The folder of the registry is in a folder that the test makes read-only while the pack is held, so the build is cancelled and the
  // removal of its folder, an entry of the read-only folder, fails with the permission error of the file system.
  const parent = mkdtempSync(join(tmpdir(), "fixture-registry-readonly-"));
  t.after(() => {
    chmodSync(parent, 0o755);
    rmSync(parent, { recursive: true, force: true });
  });
  const fixture = slowPackFixture(t);
  const held = packHeld(t, fixture.plugin);
  const controller = new AbortController();
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = parent;
  let registry;
  try {
    registry = fixtureRegistry({ sok, root: fixture.root, signal: controller.signal });
  } finally {
    // An unset TMPDIR is restored as unset: assigning undefined would set the variable to the text "undefined".
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  }
  await held;
  chmodSync(parent, 0o555);
  controller.abort();
  await assert.rejects(registry, (error) => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.errors[0].message, /: cancelled: /);
    assert.match(error.errors[1].code, /^(EACCES|EPERM)$/);
    return true;
  });
});
