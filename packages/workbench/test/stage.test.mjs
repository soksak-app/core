// 스테이징이 진단 모듈을 진단 빌드에만 넣는지 검사한다.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const STAGE = fileURLToPath(new URL("../stage.mjs", import.meta.url));
const OBSERVE = fileURLToPath(new URL("../observe.js", import.meta.url));

/** 플러그인이 없는 가짜 애플리케이션. */
function fixtureApp(t) {
  const app = mkdtempSync(join(tmpdir(), "soksak-stage-"));
  t.after(() => rmSync(app, { recursive: true, force: true }));
  mkdirSync(join(app, "runtime"));
  writeFileSync(join(app, "runtime/index.js"), "export const host = null;\n");
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "fixture-app", private: true }));
  writeFileSync(join(app, "environment.json"), JSON.stringify({
    runtime: "runtime",
    plugins: [],
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

/** diagnostics.json 을 가진 플러그인 하나를 둔 가짜 애플리케이션. files 는 플러그인이 배포하는 목록이다. */
function diagnosticApp(t, files = ["plugin.json", "ui/probe.js"]) {
  const app = fixtureApp(t);
  const plugin = join(app, "node_modules/@fixture/probe");
  mkdirSync(join(plugin, "ui"), { recursive: true });
  writeFileSync(join(plugin, "package.json"), JSON.stringify({ name: "@fixture/probe", files }));
  writeFileSync(join(plugin, "plugin.json"), JSON.stringify({
    id: "probe", name: "Probe", mark: "p", icon: "<path/>",
    surface: { module: "ui/probe.js", composition: { kind: "dom" } },
  }));
  writeFileSync(join(plugin, "ui/probe.js"), "export function mount() {}\n");
  writeFileSync(join(plugin, "diagnostics.json"), JSON.stringify(DIAGNOSTICS));
  writeFileSync(join(plugin, "ui/probe-diagnostics.js"), "export function attach() {}\n");
  const environment = JSON.parse(readFileSync(join(app, "environment.json"), "utf8"));
  environment.plugins = ["@fixture/probe"];
  environment.workspace.grid.cards[0].tabs = [{ plugin: "probe", title: "p" }];
  writeFileSync(join(app, "environment.json"), JSON.stringify(environment));
  return app;
}

const DIAGNOSTICS = {
  module: "ui/probe-diagnostics.js",
  exposes: { commands: [{
    name: "probe.inject", description: "Injects.", params: { type: "object", properties: {} }, result: { type: "null" },
  }] },
};

test("plugin diagnostics are staged only with --diagnostics", (t) => {
  const app = diagnosticApp(t);
  stage(app);
  assert.deepEqual(JSON.parse(readFileSync(join(app, "out/diagnostic-plugins.json"), "utf8")), {});
  assert.equal(existsSync(join(app, "out/modules/@fixture/probe/ui/probe-diagnostics.js")), false);
  assert.equal(existsSync(join(app, "out/modules/@fixture/probe/diagnostics.json")), false);
  assert.equal(existsSync(join(app, "out/modules/@fixture/probe/ui/probe.js")), true);

  stage(app, "--diagnostics");
  assert.deepEqual(JSON.parse(readFileSync(join(app, "out/diagnostic-plugins.json"), "utf8")), { "@fixture/probe": DIAGNOSTICS });
  assert.equal(existsSync(join(app, "out/modules/@fixture/probe/ui/probe-diagnostics.js")), true);
});

test("a plugin that publishes its diagnostic declarations or module is rejected", (t) => {
  for (const listed of ["diagnostics.json", "ui"]) {
    const app = diagnosticApp(t, ["plugin.json", "ui/probe.js", listed]);
    assert.throws(() => execFileSync(process.execPath, [STAGE, "out"], { cwd: app, stdio: "pipe" }),
      /is diagnostic and must not be listed in files/);
  }
});

/** 섹션 하나를 가진 플러그인을 둔 가짜 애플리케이션. files 는 플러그인이 배포하는 목록이다. */
function sectionApp(t, files, extra = {}) {
  const app = fixtureApp(t);
  const plugin = join(app, "node_modules/@fixture/side");
  mkdirSync(join(plugin, "ui"), { recursive: true });
  writeFileSync(join(plugin, "package.json"), JSON.stringify({ name: "@fixture/side", files }));
  writeFileSync(join(plugin, "plugin.json"), JSON.stringify({
    id: "side", name: "Side", sections: [{ id: "side.list", name: "List", module: "ui/list.js" }], ...extra,
  }));
  writeFileSync(join(plugin, "ui/list.js"), "export function mount() {}\n");
  const environment = JSON.parse(readFileSync(join(app, "environment.json"), "utf8"));
  environment.plugins = ["@fixture/side"];
  writeFileSync(join(app, "environment.json"), JSON.stringify(environment));
  return app;
}

test("a section module is staged and a section module missing from files is rejected", (t) => {
  const app = sectionApp(t, ["plugin.json", "ui"]);
  stage(app);
  assert.equal(existsSync(join(app, "out/modules/@fixture/side/ui/list.js")), true);
  const missing = sectionApp(t, ["plugin.json"]);
  assert.throws(() => execFileSync(process.execPath, [STAGE, "out"], { cwd: missing, stdio: "pipe" }),
    /side\.list module ui\/list\.js must be listed in files/);
});

test("a state module missing from files is rejected", (t) => {
  const missing = sectionApp(t, ["plugin.json", "ui/list.js"], { state: { module: "ui/state.js" } });
  assert.throws(() => execFileSync(process.execPath, [STAGE, "out"], { cwd: missing, stdio: "pipe" }),
    /side state module ui\/state\.js must be listed in files/);
});
