// Checks that every Go and Rust command of the make targets compiles and links for the one macOS minimum that `MACOS_MINIMUM`
// of the Makefile declares, and that the native library reads that declaration (docs/spec/hosts.md#nativedarwin). `make -n`
// expands each target with every other target taken as up to date, so the check reads the commands that the target itself runs,
// and a minimum given on the command line replaces the declared one, so a command that writes a version of its own is found.
// Go's selected CGO0 profile needs its public internal-linker -macos minimum;
// a cgo profile needs CGO_CFLAGS and -extldflags. Mixed host runs need both.
// Rust reads MACOSX_DEPLOYMENT_TARGET for its link and its cc crate compiles.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { macosMinimum } from "../macos-minimum.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
// A version that no file declares, so a command that carries it takes it from the variable.
const PROBE = "99.7";

/** The targets of the rules of the Makefile, in the order of the file. */
function makeTargets() {
  const names = [];
  for (const line of readFileSync(join(root, "Makefile"), "utf8").split("\n")) {
    const match = /^([A-Za-z0-9][A-Za-z0-9_.-]*):(?![=])/.exec(line);
    if (match && !names.includes(match[1])) names.push(match[1]);
  }
  return names;
}

/**
 * The commands that `make -n` prints for `target`, each continued line joined. `-i` keeps a recipe line that make runs under -n,
 * a line that calls $(MAKE), from ending the expansion when it fails.
 */
function commandsOf(target, targets, variables) {
  const others = targets.filter((name) => name !== target).flatMap((name) => ["-o", name]);
  const result = spawnSync("make", ["-n", "-i", ...others, ...variables, target], { cwd: root, encoding: "utf8", timeout: 30000 });
  assert.ifError(result.error);
  return result.stdout.replace(/\\\n/g, " ").split("\n");
}

const GO_COMMAND = /(?:^|[\s;&|(])go(?: -C \S+)? (build|test|run|vet)\b/;
const RUST_COMMAND = /(?:^|[\s;&|(])(?:\S*\/)?cargo (build|test|check|clippy|bench|run|doc)\b/;

/** The toolchains that a command line runs, and whether its Go programs link: a go command or a runner script of the repository. */
function toolchains(line) {
  // A line that prints the name of a step runs no command.
  if (/^\s*echo /.test(line)) return { go: false, goLink: false, rust: false };
  const go = GO_COMMAND.exec(line);
  const goRunner = /scripts\/(?:go-tests\.mjs|benchmarks\.mjs go )/.test(line) || (/scripts\/test-hosts\.mjs/.test(line) && !/--host tauriv2/.test(line));
  const rustRunner = /scripts\/(?:rust-tests\.mjs|benchmarks\.mjs cargo )/.test(line)
    || (/scripts\/test-hosts\.mjs/.test(line) && !/--host (?:wailsv3|mygo)/.test(line));
  const languages = /scripts\/language-test-adapters\.mjs/.test(line);
  // A cross compile for Windows builds no cgo package, so it compiles and links nothing for macOS.
  const windows = /\bGOOS=windows\b/.test(line);
  const hostRunner = /scripts\/test-hosts\.mjs/.test(line);
  const mygo = hostRunner && /--host(?:=|\s+)mygo\b/.test(line);
  const wails = hostRunner && /--host(?:=|\s+)wailsv3\b/.test(line);
  const mixed = hostRunner && !/--host(?:=|\s+)(?:wailsv3|mygo|tauriv2)\b/.test(line);
  const cgoFree = /\bCGO_ENABLED=0\b/.test(line) || mygo;
  const linksGo = !windows && ((go !== null && go[1] !== "vet") || goRunner);
  return {
    go: !windows && (go !== null || goRunner || languages),
    // The Go case of the language test cases is a package without cgo, which the Go linker links itself.
    goLink: linksGo,
    goInternal: linksGo && (mixed || cgoFree && !wails),
    goCgo: !windows && !languages && (go !== null || goRunner) && (mixed || wails || !cgoFree),
    rust: RUST_COMMAND.test(line) || rustRunner || languages,
  };
}

/** The missing settings of a command line for the minimum `version`. */
function missing(line, version) {
  const uses = toolchains(line);
  const absent = [];
  const deployment = `MACOSX_DEPLOYMENT_TARGET=${version} `;
  if ((uses.go || uses.rust) && !line.includes(deployment)) absent.push(deployment.trim());
  if (uses.goCgo && !new RegExp(`CGO_CFLAGS="[^"]*-mmacosx-version-min=${version.replace(".", "\\.")}[ "]`).test(line)) {
    absent.push(`CGO_CFLAGS with -mmacosx-version-min=${version}`);
  }
  if (uses.goLink && uses.goCgo && !line.includes(`-extldflags=-mmacosx-version-min=${version}`)) absent.push(`-extldflags=-mmacosx-version-min=${version}`);
  if (uses.goInternal && !new RegExp(`(?:^|[\\s'"=])-macos=${version.replace(".", "\\.")}(?=$|[\\s'"])`).test(line)) absent.push(`-macos=${version}`);
  return { uses, absent };
}

test("every Go and Rust command of a make target compiles and links for the declared macOS minimum", { timeout: 300000 }, () => {
  const targets = makeTargets();
  const failures = [];
  const seen = new Set();
  for (const target of targets) {
    for (const line of commandsOf(target, targets, [`MACOS_MINIMUM=${PROBE}`])) {
      const { uses, absent } = missing(line, PROBE);
      if (uses.go) seen.add(`${target} go`);
      if (uses.rust) seen.add(`${target} rust`);
      if (absent.length > 0) failures.push(`${target}: ${line.trim()}\n    lacks ${absent.join(", ")}`);
    }
  }
  // The expansion reads the commands: the application builds, the host contract run and the language cases run Go and Rust.
  for (const entry of ["build-wailsv3 go", "build-mygo go", "build-tauriv2 rust", "test-hosts go", "test-hosts rust", "test-mygo go", "repeat-go go", "repeat-rust rust", "test-language rust"]) {
    assert.ok(seen.has(entry), `the expansion found no command of ${entry}: ${[...seen].join(", ")}`);
  }
  assert.deepEqual(failures, [], `commands that do not apply MACOS_MINIMUM=${PROBE}:\n${failures.join("\n")}`);
});

test("CGO0 minimum verification requires the exact internal flag rather than cgo settings or an arbitrary generic flag", () => {
  const command = `CGO_ENABLED=0 MACOSX_DEPLOYMENT_TARGET=${PROBE} go build -ldflags`;
  assert.deepEqual(missing(`${command} "-macos=${PROBE}" ./src`, PROBE).absent, []);
  for (const flags of ["-s -w", "-macos=13.0", `-extldflags=-mmacosx-version-min=${PROBE}`]) {
    assert.ok(missing(`${command} "${flags}" ./src`, PROBE).absent.includes(`-macos=${PROBE}`), flags);
  }
  const mygo = `MACOSX_DEPLOYMENT_TARGET=${PROBE} node scripts/test-hosts.mjs --host mygo`;
  assert.deepEqual(missing(`${mygo} --go-ldflags="-macos=${PROBE}"`, PROBE).absent, []);
  assert.ok(missing(`${mygo} --go-ldflags="-macos=13.0"`, PROBE).absent.includes(`-macos=${PROBE}`));
});

test("mixed host minimum verification requires both internal and external linker profiles", () => {
  const command = `MACOSX_DEPLOYMENT_TARGET=${PROBE} CGO_CFLAGS="-mmacosx-version-min=${PROBE}" node scripts/test-hosts.mjs`;
  const internal = `--go-ldflags="-macos=${PROBE}"`;
  const external = `--cgo-ldflags="-extldflags=-mmacosx-version-min=${PROBE}"`;
  assert.deepEqual(missing(`${command} ${internal} ${external}`, PROBE).absent, []);
  assert.ok(missing(`${command} ${external}`, PROBE).absent.includes(`-macos=${PROBE}`));
  assert.ok(missing(`${command} ${internal}`, PROBE).absent.includes(`-extldflags=-mmacosx-version-min=${PROBE}`));
});

test("portable repeat-go forwards the explicitly selected internal macOS minimum", { timeout: 30000 }, () => {
  const lines = commandsOf("repeat-go", makeTargets(), [`MACOS_MINIMUM=${PROBE}`, "GO_LDFLAGS=$(GO_INTERNAL_LINK)", "PACKAGE=./packages/host/mygo/tests", "COUNT=1"]);
  const command = lines.find((line) => line.includes("node scripts/go-tests.mjs"));
  assert.ok(command, "repeat-go declares no maintained Go runner command");
  assert.match(command, /--ldflags=['"]-macos=99\.7['"]/);
});

test("the native library compiles and declares in its pkg-config file the macOS minimum of the Makefile", { timeout: 60000 }, () => {
  const expand = (variables) => {
    const result = spawnSync("make", ["-n", "-B", "-C", "native/darwin", ...variables, "build"], { cwd: root, encoding: "utf8", timeout: 30000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.replace(/\\\n/g, " ").split("\n");
  };
  for (const [variables, version] of [[[], macosMinimum(root)], [[`MACOS_MINIMUM=${PROBE}`], PROBE]]) {
    const lines = expand(variables);
    const clang = lines.filter((line) => /^clang /.test(line));
    assert.ok(clang.length > 0, lines.join("\n"));
    for (const line of clang) assert.ok(line.includes(` -mmacosx-version-min=${version} `), `${line}\n  does not compile for ${version}`);
    const pkgconfig = lines.filter((line) => line.includes("soksak-darwin.pc"));
    assert.ok(pkgconfig.some((line) => line.includes(`-mmacosx-version-min=${version}`)), `the pkg-config file does not declare ${version}:\n${pkgconfig.join("\n")}`);
  }
});

/** The clang lines and the pkg-config lines that `make -n -B build` prints in `folder`, which must succeed. */
function processIdentityBuild(folder, variables) {
  const result = spawnSync("make", ["-n", "-B", "-C", folder, ...variables, "build"], { cwd: root, encoding: "utf8", timeout: 30000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.replace(/\\\n/g, " ").split("\n");
  const clang = lines.filter((line) => /^clang /.test(line));
  assert.ok(clang.length > 0, lines.join("\n"));
  return { clang, pkgconfig: lines.filter((line) => line.includes("Cflags:")) };
}

function assertBuildsFor({ clang, pkgconfig }, version) {
  for (const line of clang) assert.ok(line.includes(` -mmacosx-version-min=${version}`), `${line}\n  does not compile for ${version}`);
  assert.ok(pkgconfig.length === 1 && pkgconfig[0].includes(`-mmacosx-version-min=${version}`), `the pkg-config file does not declare ${version}:\n${pkgconfig.join("\n")}`);
}

/** A copy of the process identity package in `<folder>/native/darwin/process-identity` below a Makefile of the repository with `makefile`. */
function processIdentityCopy(t, makefile) {
  const folder = mkdtempSync(join(tmpdir(), "soksak-process-identity-minimum-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const copy = join(folder, "native/darwin/process-identity");
  for (const part of ["Makefile", "include", "src"]) cpSync(join(root, "native/darwin/process-identity", part), join(copy, part), { recursive: true });
  writeFileSync(join(folder, "Makefile"), makefile);
  return copy;
}

test("the process identity package compiles and declares the macOS minimum that its caller passes, and alone the one of the Makefile of the repository", { timeout: 60000 }, (t) => {
  assertBuildsFor(processIdentityBuild("native/darwin/process-identity", []), macosMinimum(root));
  assertBuildsFor(processIdentityBuild("native/darwin/process-identity", [`MACOS_MINIMUM=${PROBE}`]), PROBE);
  // Alone, below a Makefile of the repository that declares another version, the package reads that version.
  assertBuildsFor(processIdentityBuild(processIdentityCopy(t, "MACOS_MINIMUM = 98.6\n"), []), "98.6");
  const undeclared = processIdentityCopy(t, "# no minimum\n");
  const result = spawnSync("make", ["-n", "-C", undeclared, "build"], { cwd: root, encoding: "utf8", timeout: 30000 });
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /Makefile declares no MACOS_MINIMUM = <macOS version>/, result.stderr);
});

test("the native library passes its macOS minimum to the build of the process identity package", { timeout: 60000 }, () => {
  // `make -n` runs the recipe line of $(MAKE), so the expansion holds the commands of the package build.
  const library = join(root, "native/darwin/process-identity/lib/libsoksak-process-identity.a");
  const result = spawnSync("make", ["-n", "-B", "-C", "native/darwin", `MACOS_MINIMUM=${PROBE}`, library], { cwd: root, encoding: "utf8", timeout: 30000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.replace(/\\\n/g, " ").split("\n");
  const clang = lines.filter((line) => /^clang /.test(line) && line.includes("process_identity"));
  assert.ok(clang.length > 0, lines.join("\n"));
  assertBuildsFor({ clang, pkgconfig: lines.filter((line) => line.includes("Cflags:")) }, PROBE);
});
