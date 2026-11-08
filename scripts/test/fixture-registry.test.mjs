import assert from "node:assert/strict";
import test, { mock } from "node:test";

import fs, { chmodSync, existsSync, globSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { FIXTURES, STEP_TIMEOUT_MS, buildFixtureRegistry, fixtureSources, npmSidecarRelease, pluginEntry, pnpmPack, repositoryText,
  sidecarEntry, sidecarFileName } from "../fixture-registry.mjs";

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
