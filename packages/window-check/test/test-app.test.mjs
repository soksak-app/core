import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { APP_NAMES } from "../app.mjs";
import { START_PROBE } from "../start.mjs";
import { applicationZip, buildRegistry, bundleExecutables, cachedBundle, checkEnv, checkFiles, coreVersion, DEFAULT_PACK, download,
  packArgv, packFileName, parseTestAppOptions, PUBLIC_INDEX, remainingProcesses, run, sidecarEntries, step } from "../test-app.mjs";

const folder = (t, prefix = "window-check-test-app-") => {
  const path = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
};
const writeJson = (path, value) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
};
/** An executable node script at `path`. */
const script = (path, body) => {
  writeFileSync(path, `#!${process.execPath}\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
};

test("the run uses the published application zip of the core release of this package", () => {
  assert.equal(coreVersion(), JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
  assert.deepEqual(applicationZip("0.0.41", "mygo"), { name: "soksak-0.0.41-darwin-arm64-mygo.zip",
    url: "https://github.com/soksak-app/core/releases/download/v0.0.41/soksak-0.0.41-darwin-arm64-mygo.zip" });
  assert.deepEqual(bundleExecutables("/c/soksak.app", "tauriv2"),
    { application: "/c/soksak.app/Contents/MacOS/sok-tauriv2", sok: "/c/soksak.app/Contents/MacOS/sok" });
});

test("the options select the applications, the pack command, the checks and their time limit", () => {
  assert.deepEqual(parseTestAppOptions([], {}), { apps: [...APP_NAMES], pack: DEFAULT_PACK, checkTimeout: 3_600_000, real: false, checks: undefined });
  assert.deepEqual(parseTestAppOptions(["--app", "mygo", "--real"], {}).apps, ["mygo"]);
  assert.deepEqual(parseTestAppOptions([], { SOKSAK_APP: "wailsv3" }).apps, ["wailsv3"]);
  assert.deepEqual(parseTestAppOptions(["--pack", "pnpm pack --pack-destination {out}", "--check-timeout", "60", "e2e/a.test.mjs"], {}),
    { apps: [...APP_NAMES], pack: "pnpm pack --pack-destination {out}", checkTimeout: 60_000, real: false, checks: ["e2e/a.test.mjs"] });
  assert.throws(() => parseTestAppOptions(["--app", "other"], {}), /unknown SOKSAK_APP: other/);
  assert.throws(() => parseTestAppOptions(["--real", "e2e/a.test.mjs"], {}), /--real selects the checks under e2e\/real\/; it takes no paths/);
  assert.throws(() => parseTestAppOptions(["--check-timeout", "0"], {}), /--check-timeout 0 is not a positive number of seconds/);
  assert.throws(() => parseTestAppOptions(["--pack", "make pack"], {}), /names no \{out\}/);
  assert.deepEqual(packArgv(DEFAULT_PACK, "/r"), ["make", "pack", "OUT=/r"]);
});

test("the checks are the test files under e2e/ outside e2e/real/ and e2e/fixtures/, or with --real those under e2e/real/", (t) => {
  const root = folder(t);
  for (const file of ["e2e/a.test.mjs", "e2e/start.mjs", "e2e/test/helper.mjs", "e2e/real/b.test.mjs", "e2e/fixtures/p/test.mjs",
    "e2e/node_modules/x/c.test.mjs", "e2e/bench/test-d.mjs"]) {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), "");
  }
  assert.deepEqual(checkFiles(root), ["e2e/a.test.mjs", "e2e/bench/test-d.mjs", "e2e/test/helper.mjs"]);
  assert.deepEqual(checkFiles(root, { real: true }), ["e2e/real/b.test.mjs"]);
  assert.throws(() => checkFiles(folder(t)), /no test file under e2e\//);
});

test("the checks get the configuration root, the run folder and the executable of each application", () => {
  const all = new Map(APP_NAMES.map((host) => [host, bundleExecutables(`/c/${host}/soksak.app`, host)]));
  assert.deepEqual(checkEnv("/root", all), { SOKSAK_CONFIG_ROOT: "/root", SOKSAK_RUN_FOLDER: "/root/run",
    SOKSAK_BINARY_WAILSV3: "/c/wailsv3/soksak.app/Contents/MacOS/sok-wailsv3", SOKSAK_BINARY_TAURIV2: "/c/tauriv2/soksak.app/Contents/MacOS/sok-tauriv2",
    SOKSAK_BINARY_MYGO: "/c/mygo/soksak.app/Contents/MacOS/sok-mygo" });
  const one = new Map([["mygo", bundleExecutables("/c/soksak.app", "mygo")]]);
  assert.equal(checkEnv("/root", one).SOKSAK_APP, "mygo");
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
  assert.equal(await run(process.execPath, ["-e", "process.stdout.write('out')"], { ...options, capture: true }), "out");
  await assert.rejects(run(process.execPath, ["-e", "process.stderr.write('bad'); process.exit(3)"], { ...options, capture: true }),
    /ended with status 3: bad/);
  await assert.rejects(run(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { ...options, timeout: 200 }), /did not end in 0\.2s/);
  const interrupt = new AbortController();
  setTimeout(() => interrupt.abort("SIGINT"), 100);
  await assert.rejects(run(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { ...options, signal: interrupt.signal }),
    /was interrupted by SIGINT/);
  await assert.rejects(run(process.execPath, [], { cwd: tmpdir() }), /a command runs with a time limit/);
  await assert.rejects(step("pack checked", () => { throw new Error("no make"); }), /^Error: pack checked: no make$/);
});

test("a download writes its file whole or leaves none", async (t) => {
  const dir = folder(t);
  const file = join(dir, "a.zip");
  await download("https://example.invalid/a.zip", file, { fetchImpl: async () => new Response("zip") });
  assert.equal(readFileSync(file, "utf8"), "zip");
  await assert.rejects(download("https://example.invalid/b.zip", join(dir, "b.zip"), { fetchImpl: async () => new Response("", { status: 404 }) }),
    /b\.zip: HTTP 404/);
  const broken = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("part")); controller.error(new Error("reset")); } });
  await assert.rejects(download("https://example.invalid/c.zip", join(dir, "c.zip"), { fetchImpl: async () => new Response(broken) }), /reset/);
  assert.equal(existsSync(join(dir, "c.zip")), false);
  assert.equal(existsSync(join(dir, "c.zip.partial")), false);
  await assert.rejects(download("https://example.invalid/d.zip", join(dir, "d.zip"), { timeout: 50,
    fetchImpl: (url, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))) }), /timeout|aborted/i);
});

test("the bundle of an application is downloaded and extracted once into the cache", async (t) => {
  const cache = folder(t);
  const fetched = [];
  const extract = async (zip, into) => { mkdirSync(join(into, "soksak.app"), { recursive: true }); };
  const fetchImpl = async (url) => { fetched.push(url); return new Response("zip"); };
  const bundle = await cachedBundle(cache, "0.0.41", "mygo", { fetchImpl, extract });
  assert.equal(bundle, join(cache, "0.0.41", "mygo", "soksak.app"));
  assert.equal(await cachedBundle(cache, "0.0.41", "mygo", { fetchImpl, extract }), bundle);
  assert.deepEqual(fetched, [applicationZip("0.0.41", "mygo").url]);
  await assert.rejects(cachedBundle(cache, "0.0.41", "wailsv3", { fetchImpl, extract: async () => {} }), /soksak-0\.0\.41-darwin-arm64-wailsv3\.zip holds no soksak\.app/);
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

/** A fake pack and `sok`: the pack writes the release file that `pnpm pack` names into the destination, `sok` answers its index. */
function tools(dir) {
  const pack = `const { readFileSync, writeFileSync } = require("node:fs");
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const out = process.argv.at(-1);
writeFileSync(out + "/" + pkg.name.replace(/^@/, "").replace("/", "-") + "-" + pkg.version + ".tgz", pkg.name);`;
  return {
    pack: `${script(join(dir, "pack"), pack)} {out}`,
    pnpm: script(join(dir, "pnpm"), pack),
    sok: script(join(dir, "sok"), `require("node:fs").writeFileSync(process.argv[4] + "/index.json", "{}");
process.stdout.write(JSON.stringify({ index: process.argv[4] + "/index.json", args: process.argv.slice(2) }));`),
  };
}

test("the check registry holds the release of the repository, the start probe, the fixture plugins and the sidecars they name", async (t) => {
  const root = repository(t);
  const registry = join(folder(t), "registry");
  const { pack, pnpm, sok } = tools(folder(t));
  const index = { plugins: [], sidecars: [{ name: "@scope/sidecar-a", repository: "r", versions: [] }, { name: "@scope/other", versions: [] }] };
  const built = await buildRegistry({ root, folder: registry, sok, pack, pnpm, fetchImpl: async (url) => {
    assert.equal(url, PUBLIC_INDEX);
    return Response.json(index);
  } });
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
  const offline = async () => { throw new Error("offline"); };
  await assert.rejects(buildRegistry({ root: repository(t), folder: join(folder(t), "r"), sok, pack, pnpm, fetchImpl: offline }),
    /public registry index: offline/);
  await assert.rejects(buildRegistry({ root: repository(t), folder: join(folder(t), "r"), sok, pack: `${process.execPath} -e process.exit(4) {out}`, pnpm }),
    /pack checked: .* ended with status 4/);
  await assert.rejects(buildRegistry({ root: repository(t, { id: START_PROBE, dependencies: {} }), folder: join(folder(t), "r"), sok, pack, pnpm }),
    /the plugin id startprobe of the start probe of @soksak\/window-check is also the id of \./);
  await assert.rejects(buildRegistry({ root: folder(t), folder: join(folder(t), "r"), sok, pack, pnpm }), /holds no plugin\.json/);
});

test("the remaining processes are those whose command line names a path of the run, except this one", () => {
  const listing = ` 10 /c/soksak.app/Contents/MacOS/sok-mygo --config-dir /root/x\n ${process.pid} node /root/x\n 11 /usr/bin/other\n`;
  assert.deepEqual(remainingProcesses(listing, ["/root", "/c/soksak.app"]), ["10 /c/soksak.app/Contents/MacOS/sok-mygo --config-dir /root/x"]);
});

test("the run modules name no real plugin", () => {
  for (const file of ["../test-app.mjs", "../soksak-test-app.mjs", "../catalog.mjs"]) {
    assert.doesNotMatch(readFileSync(new URL(file, import.meta.url), "utf8"), /["'](layoutprobe|terminal|term|browser|files|editor|hwp)["'.]/);
  }
});
