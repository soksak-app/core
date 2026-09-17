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
