// 스테이징이 진단 모듈을 진단 빌드에만 넣고, host 가 없는 애플리케이션에는 설치된 플러그인을 host 처럼 쓰는지 검사한다.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const STAGE = fileURLToPath(new URL("../stage.mjs", import.meta.url));
const OBSERVE = fileURLToPath(new URL("../observe.js", import.meta.url));
const RELEASE_DIAGNOSTICS = fileURLToPath(new URL("../release-diagnostics.js", import.meta.url));

/** 플러그인이 없는 가짜 애플리케이션. */
function fixtureApp(t) {
  const app = mkdtempSync(join(tmpdir(), "soksak-stage-"));
  t.after(() => rmSync(app, { recursive: true, force: true }));
  mkdirSync(join(app, "runtime"));
  writeFileSync(join(app, "runtime/index.js"), "export const host = null;\n");
  writeFileSync(join(app, "runtime/start.js"), "export default { workspace: { common: {}, projects: [] }, controls: null };\n");
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "fixture-app", private: true }));
  writeFileSync(join(app, "environment.json"), JSON.stringify({
    runtime: "runtime",
    workspace: { focus: "main", grid: { xs: [0, 1], ys: [0, 1], cards: [{ id: "main", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [{ plugin: "x", title: "x" }] }] } },
    sidebars: { sets: [], links: [] },
  }));
  return app;
}

const stage = (app, ...flags) => execFileSync(process.execPath, [STAGE, "out", ...flags], { cwd: app, encoding: "utf8" });

test("a staged frontend without --diagnostics has an empty diagnostics module and no diagnostic code", (t) => {
  const app = fixtureApp(t);
  stage(app);
  const module = readFileSync(join(app, "out/diagnostics.js"), "utf8");
  assert.equal(module, readFileSync(RELEASE_DIAGNOSTICS, "utf8"));
  assert.doesNotMatch(module, /diagnostics\.\w+|registry|import/);
  assert.equal(existsSync(join(app, "out/observe.js")), false);
  assert.equal(existsSync(join(app, "out/transcript.js")), false);
  assert.doesNotMatch(readFileSync(join(app, "out/host.js"), "utf8"), /diagnostics\.\w+|transcript/i);
});

test("a staged frontend with --diagnostics has the page diagnostic methods", (t) => {
  const app = fixtureApp(t);
  assert.match(stage(app, "--diagnostics"), /with diagnostics/);
  assert.equal(readFileSync(join(app, "out/diagnostics.js"), "utf8"), readFileSync(OBSERVE, "utf8"));
  assert.equal(existsSync(join(app, "out/transcript.js")), true);
});

test("unknown staging arguments are rejected", (t) => {
  const app = fixtureApp(t);
  assert.throws(() => execFileSync(process.execPath, [STAGE, "out", "--release"], { cwd: app, stdio: "pipe" }), /usage/);
});

/** 켜진 플러그인 둘과 꺼진 플러그인 하나를 설치한 설정 디렉터리. probe 는 진단 선언을 담는다. */
function installedConfiguration(t) {
  const configuration = mkdtempSync(join(tmpdir(), "soksak-installed-"));
  t.after(() => rmSync(configuration, { recursive: true, force: true }));
  const write = (path, text) => {
    mkdirSync(join(configuration, path, ".."), { recursive: true });
    writeFileSync(join(configuration, path), text);
  };
  const folder = (id, version) => join(configuration, "plugins", id, version);
  write("plugins/installed.json", JSON.stringify({ format: 1, plugins: {
    probe: { package: "@fixture/probe", version: "0.1.0", path: folder("probe", "0.1.0"), enabled: true, sidecars: {} },
    alpha: { package: "plugin-alpha", version: "1.0.0", path: folder("alpha", "1.0.0"), enabled: true, sidecars: {} },
    off: { package: "plugin-off", version: "1.0.0", path: folder("off", "1.0.0"), enabled: false, sidecars: {} },
  }, sidecars: {} }));
  write("plugins/probe/0.1.0/plugin.json", JSON.stringify(MANIFESTS.probe));
  write("plugins/probe/0.1.0/ui/probe.js", "export function mount() {}\n");
  write("plugins/probe/0.1.0/diagnostics.json", JSON.stringify(DIAGNOSTICS));
  write("plugins/alpha/1.0.0/plugin.json", JSON.stringify(MANIFESTS.alpha));
  write("plugins/off/1.0.0/plugin.json", "{}");
  return configuration;
}

const MANIFESTS = {
  probe: { id: "probe", name: "Probe", description: "검사용 표면.", mark: "P", icon: "<path/>",
    surface: { module: "ui/probe.js", composition: { kind: "dom" } } },
  alpha: { id: "alpha", name: "Alpha", description: "검사용 섹션.", sections: [{ id: "alpha.list", name: "List", module: "ui/list.js" }] },
};

const DIAGNOSTICS = {
  module: "ui/probe-diagnostics.js",
  exposes: { commands: [{
    name: "probe.inject", description: "Injects.", params: { type: "object", properties: {} }, result: { type: "null" },
  }] },
};

test("an application without a host stages the enabled installed plugins as a host would serve them", (t) => {
  const app = fixtureApp(t);
  const configuration = installedConfiguration(t);
  stage(app, "--installed", configuration);
  assert.deepEqual(JSON.parse(readFileSync(join(app, "out/installed-plugins.json"), "utf8")), { plugins: [
    { id: "alpha", package: "plugin-alpha", version: "1.0.0", manifest: MANIFESTS.alpha },
    { id: "probe", package: "@fixture/probe", version: "0.1.0", manifest: MANIFESTS.probe },
  ] });
  assert.equal(readFileSync(join(app, "out/modules/@fixture/probe/ui/probe.js"), "utf8"), "export function mount() {}\n");
  assert.equal(existsSync(join(app, "out/modules/plugin-off")), false);
  stage(app, "--installed", configuration, "--diagnostics");
  assert.deepEqual(JSON.parse(readFileSync(join(app, "out/installed-plugins.json"), "utf8")).plugins[1].diagnostics, DIAGNOSTICS);
  assert.throws(() => execFileSync(process.execPath, [STAGE, "out", "--installed", join(configuration, "missing")], { cwd: app, stdio: "pipe" }),
    /installed\.json does not exist; install plugins with sok first/);
});

test("a native application stages no plugin and no installed plugin document", (t) => {
  const app = fixtureApp(t);
  stage(app, "--diagnostics");
  assert.equal(existsSync(join(app, "out/installed-plugins.json")), false);
  assert.equal(existsSync(join(app, "out/diagnostic-plugins.json")), false);
  assert.throws(() => execFileSync(process.execPath, [STAGE, "out", "--executables", "bin"], { cwd: app, stdio: "pipe" }), /usage/);
});
