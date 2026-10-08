import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { auditDiagnostics, auditFrontend, auditMinimum, diagnosticRelease, machoMinimum } from "../check-release.mjs";

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
  pageModule: bytes("// 진단 빌드가 아니다.\nexport {};\n"),
  pageModuleName: "release page diagnostics module",
};
const [page, card, release] = ["<main>작업</main>", "export const card = 1;", "// 진단 빌드가 아니다.\nexport {};\n"];

/** 실행 파일처럼 NUL 로 구분한 바이트를 latin1 문자열로 만든다. */
const executable = (...parts) => Buffer.concat(parts.flatMap((part) => [bytes("\0"), bytes(part)])).toString("latin1");

function audit(text) {
  const errors = [];
  auditFrontend(errors, "app", text, sources);
  return errors;
}

/** A thin 64-bit Mach-O header with one LC_BUILD_VERSION (or LC_VERSION_MIN_MACOSX) command for the version. */
function macho(version, cmd = 0x32) {
  const [major, minor = 0, patch = 0] = version.split(".").map(Number);
  const bytes = Buffer.alloc(32 + 24);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(1, 16);
  bytes.writeUInt32LE(24, 20);
  bytes.writeUInt32LE(cmd, 32);
  bytes.writeUInt32LE(24, 36);
  const encoded = (major << 16) | (minor << 8) | patch;
  if (cmd === 0x32) bytes.writeUInt32LE(1, 40);
  bytes.writeUInt32LE(encoded, cmd === 0x32 ? 44 : 40);
  return bytes;
}

test("machoMinimum reads the minimum macOS version of an executable", () => {
  assert.equal(machoMinimum(macho("14.4")), "14.4");
  assert.equal(machoMinimum(macho("13.0")), "13.0");
  assert.equal(machoMinimum(macho("11.2.1", 0x24)), "11.2.1");
  assert.throws(() => machoMinimum(Buffer.from("\0application\0")), /not a 64-bit Mach-O executable/);
});

test("minimum audit requires the declared minimum in Info.plist and the application, and no newer executable", () => {
  const audit = (plist, executables) => {
    const errors = [];
    auditMinimum(errors, "app.app", "14.4", plist, executables);
    return errors;
  };
  const plist = (version) => `<plist><dict><key>LSMinimumSystemVersion</key>\n\t<string>${version}</string></dict></plist>`;
  assert.deepEqual(audit(plist("14.4"), [{ path: "app", application: true, minimum: "14.4" }, { path: "sok", application: false, minimum: "11.0" }]), []);
  assert.deepEqual(audit(plist("14.0"), [{ path: "app", application: true, minimum: "14.0" }, { path: "sok", application: false, minimum: "14.10" }]), [
    "app.app/Contents/Info.plist: LSMinimumSystemVersion is 14.0, not the macOS minimum 14.4",
    "app: built for macOS 14.0, not the macOS minimum 14.4",
    "sok: built for macOS 14.10, newer than the macOS minimum 14.4",
  ]);
  assert.deepEqual(audit("<plist><dict></dict></plist>", []), ["app.app/Contents/Info.plist: LSMinimumSystemVersion is missing, not the macOS minimum 14.4"]);
});

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
  return { paths, args: ["--macos-minimum", "14.4", "--wailsv3-bundle", paths.wailsv3.bundle, "--tauriv2-bundle", paths.tauriv2.bundle] };
}

test("frontend audit accepts an executable that embeds every published file and the release module", () => {
  assert.deepEqual(audit(executable(page, card, release)), []);
});

test("frontend audit rejects an executable whose frontend is not readable", () => {
  assert.deepEqual(audit(executable(release, "<compressed>")), ["app: does not embed a readable frontend; missing index.html, card.js"]);
  assert.deepEqual(audit(executable(page, card)), ["app: does not embed a readable frontend; missing release page diagnostics module"]);
});

test("release CLI inspects the supplied bundles instead of default release paths", { timeout: 5000 }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "soksak-release-paths-"));
  t.after(() => rmSync(dir, { recursive: true }));
  const wails = join(dir, "isolated-wails.app");
  const tauri = join(dir, "isolated-tauri.app");
  const stderr = check(["--macos-minimum", "14.4", "--wailsv3-bundle", wails, "--tauriv2-bundle", tauri]);
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
  ["missing paths", [], /required release options/],
  ["missing minimum", ["--wailsv3-bundle", "a", "--tauriv2-bundle", "b"], /required release options/],
  ["invalid minimum", ["--macos-minimum", "fourteen"], /requires a macOS version/],
  ["duplicate minimum", ["--macos-minimum", "14.4", "--macos-minimum", "14.4"], /duplicate release option/],
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

// While the version is 0.0.x, a release is a diagnostic build, so its executables carry the diagnostic methods; a later
// version series carries none (AGENTS.md, F124).
test("a 0.0.x release requires the diagnostic methods and a later release refuses them", () => {
  assert.equal(diagnosticRelease("0.0.8"), true);
  assert.equal(diagnosticRelease("0.1.0"), false);
  const audited = (text, required) => {
    const errors = [];
    auditDiagnostics(errors, "app", text, required);
    return errors;
  };
  const diagnostic = executable("diagnostics.capture.still", "sp_capture_start");
  const plain = executable("host.window", "page");
  assert.deepEqual(audited(diagnostic, true), []);
  assert.deepEqual(audited(plain, true), ["app: lacks the diagnostic methods that a 0.0.x release carries"]);
  assert.deepEqual(audited(plain, false), []);
  assert.match(audited(diagnostic, false).join("\n"), /app: contains a diagnostic method/);
});
