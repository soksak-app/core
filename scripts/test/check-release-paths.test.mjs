import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { auditFrontend } from "../check-release.mjs";

const script = fileURLToPath(new URL("../check-release.mjs", import.meta.url));

function run(args) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout: 4000 });
  assert.ifError(result.error);
  return result;
}

function check(args) {
  const result = run(args);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  return result.stderr;
}

const bytes = (text) => Buffer.from(text, "utf8");
const sources = {
  published: [{ path: "index.html", bytes: bytes("<main>작업</main>") }, { path: "card.js", bytes: bytes("export const card = 1;") }],
  releaseModule: bytes("// 진단 빌드가 아니다.\nexport {};\n"),
  plugins: [{ package: "@fixture/probe", entries: ["probe.trace"], module: bytes("export function attachProbe() {}\n") }],
};
const [page, card, release] = ["<main>작업</main>", "export const card = 1;", "// 진단 빌드가 아니다.\nexport {};\n"];

/** 실행 파일처럼 NUL 로 구분한 바이트를 latin1 문자열로 만든다. */
const executable = (...parts) => Buffer.concat(parts.flatMap((part) => [bytes("\0"), bytes(part)])).toString("latin1");

function audit(text) {
  const errors = [];
  auditFrontend(errors, "app", text, sources);
  return errors;
}

/** 애플리케이션 실행 파일과 추가 실행 파일을 가진 가짜 번들 두 개를 만든다. */
function bundles(t, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "soksak-release-bundles-"));
  t.after(() => rmSync(dir, { recursive: true }));
  const paths = {};
  for (const app of ["wailsv3", "tauriv2"]) {
    const executables = join(dir, `${app}.app/Contents/MacOS`);
    mkdirSync(executables, { recursive: true });
    writeFileSync(join(executables, `soksak-${app}`), "\0application\0");
    writeFileSync(join(executables, "soksak-fixture-sidecar"), extra[app] ?? "\0clean sidecar\0");
    paths[app] = { bundle: join(dir, `${app}.app`), executables };
  }
  return { paths, args: ["--wailsv3-bundle", paths.wailsv3.bundle, "--tauriv2-bundle", paths.tauriv2.bundle] };
}

test("frontend audit accepts an executable that embeds every published file and the release module", () => {
  assert.deepEqual(audit(executable(page, card, release)), []);
});

test("frontend audit rejects an executable whose frontend is not readable", () => {
  assert.deepEqual(audit(executable(release, "<compressed>")), ["app: does not embed a readable frontend; missing index.html, card.js"]);
  assert.deepEqual(audit(executable(page, card)), ["app: does not embed a readable frontend; missing release page diagnostics module"]);
});

test("frontend audit rejects plugin diagnostic entries and modules", () => {
  assert.deepEqual(audit(executable(page, card, release, '"probe.trace"', "export function attachProbe() {}\n")), [
    "app: contains the diagnostic entry probe.trace",
    "app: contains the diagnostic module of @fixture/probe",
  ]);
});

test("release CLI inspects the supplied bundles instead of default release paths", { timeout: 5000 }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "soksak-release-paths-"));
  t.after(() => rmSync(dir, { recursive: true }));
  const wails = join(dir, "isolated-wails.app");
  const tauri = join(dir, "isolated-tauri.app");
  const stderr = check(["--wailsv3-bundle", wails, "--tauriv2-bundle", tauri]);
  assert.ok(stderr.includes(join(wails, "Contents/MacOS/soksak-wailsv3") + ": missing"), stderr);
  assert.ok(stderr.includes(join(tauri, "Contents/MacOS/soksak-tauriv2") + ": missing"), stderr);
});

test("release CLI inspects every executable in the bundle", { timeout: 5000 }, (t) => {
  const { paths, args } = bundles(t, { tauriv2: "\0sp_diag_probe\0" });
  const stderr = check(args);
  assert.ok(stderr.includes(`${join(paths.tauriv2.executables, "soksak-fixture-sidecar")}: contains a sidecar diagnostic symbol`), stderr);
  assert.ok(stderr.includes(`${join(paths.wailsv3.executables, "soksak-wailsv3")}: does not embed a readable frontend`), stderr);
});

for (const [name, args, message] of [
  ["missing paths", [], /required release bundle options/],
  ["unknown option", ["--unknown"], /unknown release option/],
  ["missing value", ["--wailsv3-bundle"], /requires a bundle path/],
  ["empty value", ["--wailsv3-bundle", ""], /requires a bundle path/],
  ["option as value", ["--wailsv3-bundle", "--tauriv2-bundle"], /requires a bundle path/],
  ["duplicate option", ["--wailsv3-bundle", "a", "--wailsv3-bundle", "b"], /duplicate release option/],
]) {
  test(`release CLI rejects ${name}`, { timeout: 5000 }, () => {
    assert.match(check(args), message);
  });
}
