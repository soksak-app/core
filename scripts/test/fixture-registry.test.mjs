import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { EventEmitter } from "node:events";

import fs, { chmodSync, existsSync, globSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createServer as createHttpServer } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";

import { FIXTURES, STEP_TIMEOUT_MS, WRONG_SHA256, buildFixtureRegistry, fixturePluginIds, fixtureSources, main, nextPatch, npmSidecarRelease, pluginEntry,
  pnpmPack, readIndex, repositoryText, servedIndex, serveRegistry, sidecarEntry, sidecarFileName, withRevoked, withWrongHash } from "../fixture-registry.mjs";

const SHA = "a".repeat(64);
const MODULE = fileURLToPath(new URL("../fixture-registry.mjs", import.meta.url));
const inside = (root, path) => {
  const rest = relative(root, resolve(path));
  return !rest.startsWith("..") && !isAbsolute(rest);
};

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

test("the sources of the fixture registry are exactly the plugin folders and fake sidecar folders of e2e/fixtures", { timeout: 5000 }, () => {
  const folders = (pattern) => globSync(pattern, { cwd: FIXTURES, exclude: (name) => name === "node_modules" || name === "target" })
    .map((file) => join(FIXTURES, dirname(file))).sort();
  const plugins = folders("**/plugin.json");
  assert.ok(plugins.length > 0, "e2e/fixtures holds no plugin folder");
  assert.deepEqual(fixtureSources(), { plugins, sidecars: folders("sidecars/**/sidecar.json") });
});

test("the fixture registry packs every fixture plugin into the pack fixtures and reads no path outside e2e/fixtures and no index", { timeout: 5000 }, async (t) => {
  const { plugins, sidecars } = fixtureSources();
  const out = mkdtempSync(join(tmpdir(), "fixture-registry-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  // Every read of the file system and every fetch of the build is recorded; node:fs named imports follow the mocked methods.
  const reads = [];
  for (const name of ["readFileSync", "readdirSync", "statSync", "lstatSync", "existsSync", "openSync", "cpSync", "copyFileSync"]) {
    const original = fs[name];
    mock.method(fs, name, (path, ...rest) => { reads.push(`${name} ${path}`); return original.call(fs, path, ...rest); });
  }
  mock.method(globalThis, "fetch", (url) => { reads.push(`fetch ${url}`); throw new Error("the fixture registry fetched an address"); });
  syncBuiltinESMExports();
  const packed = [];
  const released = [];
  let built;
  try {
    built = await buildFixtureRegistry("/bin/sok", out, {
      pack: async (dir, releases) => { packed.push(dir); return { release: join(releases, `${packed.length}.tgz`), sha256: SHA }; },
      release: async (dir, releases) => { released.push(dir); return { release: join(releases, "s.tgz"), sha256: SHA, platform: "darwin-arm64" }; },
      build: async (binary, folder) => ({ binary, folder }),
    });
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.deepEqual(built, { binary: "/bin/sok", folder: out });
  assert.deepEqual(packed, plugins);
  assert.deepEqual(released, sidecars);
  assert.ok(reads.some((read) => read.startsWith("readFileSync ")) && reads.some((read) => read.startsWith("readdirSync ")), "the reads were not recorded");
  assert.deepEqual(reads.filter((read) => !inside(FIXTURES, read.replace(/^\S+ /, ""))), []);
  const ids = plugins.map((dir) => JSON.parse(readFileSync(join(dir, "plugin.json"), "utf8")).id);
  assert.deepEqual(JSON.parse(readFileSync(join(out, "packs", "fixtures.json"), "utf8")),
    { name: "fixtures", description: "Every fake plugin of the core fixtures.", plugins: ids });
  assert.deepEqual(fixturePluginIds(), ids, "fixturePluginIds names the plugins of the pack fixtures in its order");
  assert.deepEqual(fs.readdirSync(join(out, "plugins")).sort(), ids.map((id) => `${id}.json`).sort());
  assert.deepEqual(JSON.parse(readFileSync(join(out, "revoked.json"), "utf8")), { plugins: [], sidecars: [] });
  // The module imports only Node.js built-ins, the platform selector and the command supervision and names no address, so it reads no registry index or
  // plugin repository.
  const source = readFileSync(MODULE, "utf8");
  assert.deepEqual([...source.matchAll(/^import .* from "([^"]+)";$/gm)].map(([, from]) => from).filter((from) => !from.startsWith("node:")),
    ["./platform/platform.js", "./test-command.mjs"]);
  assert.doesNotMatch(source, /https?:\/\/|\bfetch\(|target\/registry|workspace-registry/);
});

test("a fake sidecar of the fixtures is released with npm pack under its platform name and listed as the sidecar of its plugin", { timeout: 60000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "fixture-registry-root-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sidecar = join(root, "sidecars", "worker");
  mkdirSync(join(sidecar, "bin"), { recursive: true });
  writeFileSync(join(sidecar, "package.json"), JSON.stringify({ name: "@sok-check/worker", version: "0.0.1", license: "MIT",
    repository: "git+https://example.invalid/core.git", files: ["sidecar.json", "bin"] }));
  writeFileSync(join(sidecar, "sidecar.json"), JSON.stringify({ protocol: 1, executable: "bin/worker" }));
  writeFileSync(join(sidecar, "bin", "worker"), "#!/bin/sh\n");
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
  const builds = [];
  const signal = new AbortController().signal;
  await buildFixtureRegistry("/bin/sok", out, { root, signal, pack: pnpmPack,
    release: (dir, releases, options) => npmSidecarRelease(dir, releases, { ...options, platform: "linux-x64" }),
    build: async (binary, folder, options) => builds.push([binary, folder, options]) });
  assert.deepEqual(builds, [["/bin/sok", out, { signal, timeoutMs: undefined }]]);
  const entry = JSON.parse(readFileSync(join(out, "sidecars", "sok-check-worker.json"), "utf8"));
  const release = entry.versions[0].releases["linux-x64"];
  assert.equal(fileURLToPath(release.url), join(resolve(out), "releases", "sok-check-worker-0.0.1-linux-x64.tgz"));
  assert.match(release.sha256, /^[0-9a-f]{64}$/);
  assert.equal(entry.versions[0].protocol, 1);
  assert.deepEqual(JSON.parse(readFileSync(join(out, "plugins", "user.json"), "utf8")).versions[0].sidecars, { "@sok-check/worker": "^0.0.1" });
});

test("a fake sidecar whose declared executable is not built is not released", { timeout: 5000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "fixture-registry-unbuilt-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sidecar = join(root, "sidecars", "worker");
  mkdirSync(sidecar, { recursive: true });
  writeFileSync(join(sidecar, "package.json"), JSON.stringify({ name: "@sok-check/worker", version: "0.0.1", license: "MIT",
    repository: "git+https://example.invalid/core.git", files: ["sidecar.json", "bin"] }));
  writeFileSync(join(sidecar, "sidecar.json"), JSON.stringify({ protocol: 1, executable: "bin/worker" }));
  const out = join(root, "releases");
  await assert.rejects(npmSidecarRelease(sidecar, out, { platform: "linux-x64" }),
    new RegExp(`pack sidecar ${sidecar}: sidecar.json executable bin/worker is not an executable file; build the sidecar first`));
  mkdirSync(join(sidecar, "bin"));
  writeFileSync(join(sidecar, "bin", "worker"), "#!/bin/sh\n");
  await assert.rejects(npmSidecarRelease(sidecar, out, { platform: "linux-x64" }), /bin\/worker is not an executable file/);
  assert.equal(existsSync(out) ? readdirSync(out).length : 0, 0, "a release was written");
});

test("a build folder of a fake sidecar holds no fixture source", { timeout: 5000 }, (t) => {
  const root = mkdtempSync(join(tmpdir(), "fixture-registry-target-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sidecar = join(root, "sidecars", "worker");
  mkdirSync(join(sidecar, "target", "release", "copy"), { recursive: true });
  writeFileSync(join(sidecar, "sidecar.json"), "{}");
  writeFileSync(join(sidecar, "target", "release", "copy", "sidecar.json"), "{}");
  assert.deepEqual(fixtureSources(root), { plugins: [], sidecars: [sidecar] });
});

/** A fixtures root of one plugin and a folder that puts first on PATH a pnpm that sleeps; the test restores PATH. */
function slowPackFixture(t) {
  const work = mkdtempSync(join(tmpdir(), "fixture-registry-slow-"));
  const plugin = join(work, "fixtures", "probe");
  mkdirSync(plugin, { recursive: true });
  writeFileSync(join(plugin, "plugin.json"), JSON.stringify({ id: "probe", name: "Probe" }));
  writeFileSync(join(plugin, "package.json"), JSON.stringify({ name: "@sok-check/probe", version: "0.0.1", repository: "https://example.invalid/core" }));
  mkdirSync(join(work, "bin"));
  writeFileSync(join(work, "bin", "pnpm"), "#!/bin/sh\nexec sleep 30\n");
  chmodSync(join(work, "bin", "pnpm"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${join(work, "bin")}:${path}`;
  t.after(() => {
    process.env.PATH = path;
    rmSync(work, { recursive: true, force: true });
  });
  return { root: join(work, "fixtures"), plugin, out: join(work, "registry") };
}

test("a pack that exceeds the step limit fails the fixture registry build with the step that timed out", { timeout: 20000 }, async (t) => {
  const fixture = slowPackFixture(t);
  const builds = [];
  const started = performance.now();
  await assert.rejects(buildFixtureRegistry("/bin/sok", fixture.out, { root: fixture.root, timeoutMs: 300, build: async () => builds.push("build") }),
    (error) => error.message.startsWith(`pack ${fixture.plugin}: timeout: `));
  assert.ok(performance.now() - started < 10000, "the build did not stop at the step limit");
  assert.deepEqual(builds, []);
});

test("an aborted signal stops the fixture registry build in its running step", { timeout: 20000 }, async (t) => {
  const fixture = slowPackFixture(t);
  const controller = new AbortController();
  const builds = [];
  const started = performance.now();
  const build = buildFixtureRegistry("/bin/sok", fixture.out, { root: fixture.root, signal: controller.signal, build: async () => builds.push("build") });
  setTimeout(() => controller.abort(), 300);
  await assert.rejects(build, (error) => error.message.startsWith(`pack ${fixture.plugin}: cancelled: `));
  assert.ok(performance.now() - started < 10000, "the build did not stop at the abort");
  assert.deepEqual(builds, []);
});

test("the fixture registry bounds each step at 30000 ms", { timeout: 1000 }, () => {
  assert.equal(STEP_TIMEOUT_MS, 30000);
});

test("the command line ends its build when the process receives SIGTERM and removes its signal handlers", { timeout: 5000 }, async () => {
  const signals = new EventEmitter();
  let seen;
  const running = main(["--sok", "/bin/sok", "--out", "/run/fixture-registry"], { signals, build: (sok, out, { signal }) => {
    seen = [sok, out];
    return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new Error(`cancelled by ${signal.reason}`)), { once: true }));
  } });
  signals.emit("SIGTERM");
  await assert.rejects(running, /cancelled by SIGTERM/);
  assert.deepEqual(seen, ["/bin/sok", "/run/fixture-registry"]);
  assert.deepEqual(["SIGTERM", "SIGINT", "SIGHUP"].map((name) => signals.listenerCount(name)), [0, 0, 0]);
  await assert.rejects(main(["--sok", "/bin/sok"], { signals, build: async () => {} }), /--out is required/);
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
  const packed = [];
  const pack = async (dir, releases, options) => {
    packed.push(dir);
    return pnpmPack(dir, releases, options);
  };
  const build = async () => null;
  await buildFixtureRegistry("/bin/sok", out, { root: fixtures, pack, build,
    versions: { probe: [{ version: "0.0.40", engines: ">=0.0.1 <99.0.0" }, { version: "0.0.41", engines: ">=99.0.0" }] } });
  assert.deepEqual(packed, [other, join(out, "copies", "probe-0.0.40"), join(out, "copies", "probe-0.0.41")]);
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
  await assert.rejects(buildFixtureRegistry("/bin/sok", out, { root: fixtures, pack, build, versions: { missing: [{ version: "0.0.1" }] } }),
    /versions name no fixture plugin: missing/);
  await assert.rejects(buildFixtureRegistry("/bin/sok", out, { root: fixtures, pack, build, versions: { probe: [] } }), /versions of probe list no version/);
});

test("serveRegistry answers its documents and the files inside the registry folder and nothing else", { timeout: 5000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "fixture-registry-serve-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const folder = join(root, "registry");
  mkdirSync(join(folder, "releases"), { recursive: true });
  writeFileSync(join(folder, "releases", "a b.tgz"), "release");
  writeFileSync(join(root, "outside.txt"), "outside");
  const server = await serveRegistry(folder, { "/good/index.json": { plugins: [] } }, { createServer: createHttpServer, protocol: "http:" });
  t.after(server.close);
  assert.match(server.base, /^http:\/\/127\.0\.0\.1:\d+$/);
  const get = async (path) => {
    const response = await fetch(`${server.base}${path}`);
    return [response.status, await response.text()];
  };
  assert.deepEqual(await get("/good/index.json"), [200, "{\"plugins\":[]}"]);
  assert.deepEqual(await get("/releases/a%20b.tgz"), [200, "release"]);
  assert.equal((await get("/releases/none.tgz"))[0], 404);
  assert.equal((await get("/releases"))[0], 404);
  assert.equal((await get("/%2E%2E/outside.txt"))[0], 404);
  await Promise.all([server.close(), server.close()]);
  await assert.rejects(fetch(`${server.base}/good/index.json`));
});
