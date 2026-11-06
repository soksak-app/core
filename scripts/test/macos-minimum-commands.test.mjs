// Checks that every Go and Rust command of the make targets compiles and links for the one macOS minimum that `MACOS_MINIMUM`
// of the Makefile declares, and that the native library reads that declaration (docs/spec/hosts.md#nativedarwin). `make -n`
// expands each target with every other target taken as up to date, so the check reads the commands that the target itself runs,
// and a minimum given on the command line replaces the declared one, so a command that writes a version of its own is found.
// A Go command needs MACOSX_DEPLOYMENT_TARGET and CGO_CFLAGS for its cgo compile and -extldflags for its external link; a Rust
// command needs MACOSX_DEPLOYMENT_TARGET, which rustc reads for its link and the cc crate for its compile.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
const RUST_COMMAND = /(?:^|[\s;&|(])cargo (build|test|check|clippy|bench|run|doc)\b/;

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
  return {
    go: !windows && (go !== null || goRunner || languages),
    // The Go case of the language test cases is a package without cgo, which the Go linker links itself.
    goLink: !windows && ((go !== null && go[1] !== "vet") || goRunner),
    rust: RUST_COMMAND.test(line) || rustRunner || languages,
  };
}

/** The missing settings of a command line for the minimum `version`. */
function missing(line, version) {
  const uses = toolchains(line);
  const absent = [];
  const deployment = `MACOSX_DEPLOYMENT_TARGET=${version} `;
  if ((uses.go || uses.rust) && !line.includes(deployment)) absent.push(deployment.trim());
  if (uses.go && !new RegExp(`CGO_CFLAGS="[^"]*-mmacosx-version-min=${version.replace(".", "\\.")}[ "]`).test(line)) {
    absent.push(`CGO_CFLAGS with -mmacosx-version-min=${version}`);
  }
  if (uses.goLink && !line.includes(`-extldflags=-mmacosx-version-min=${version}`)) absent.push(`-extldflags=-mmacosx-version-min=${version}`);
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

test("the native library compiles, configures and declares in its pkg-config file the macOS minimum of the Makefile", { timeout: 60000 }, () => {
  const expand = (variables) => {
    const result = spawnSync("make", ["-n", "-B", "-C", "native/darwin", ...variables, "build"], { cwd: root, encoding: "utf8", timeout: 30000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.replace(/\\\n/g, " ").split("\n");
  };
  for (const [variables, version] of [[[], macosMinimum(root)], [[`MACOS_MINIMUM=${PROBE}`], PROBE]]) {
    const lines = expand(variables);
    const clang = lines.filter((line) => /^clang /.test(line));
    const cmake = lines.filter((line) => /^cmake -S /.test(line));
    assert.ok(clang.length > 0 && cmake.length === 1, lines.join("\n"));
    for (const line of clang) assert.ok(line.includes(` -mmacosx-version-min=${version} `), `${line}\n  does not compile for ${version}`);
    assert.ok(cmake[0].includes(`-DCMAKE_OSX_DEPLOYMENT_TARGET=${version} `), `${cmake[0]}\n  does not configure ZXing for ${version}`);
    const pkgconfig = lines.filter((line) => line.includes("soksak-darwin.pc"));
    assert.ok(pkgconfig.some((line) => line.includes(`-mmacosx-version-min=${version}`)), `the pkg-config file does not declare ${version}:\n${pkgconfig.join("\n")}`);
  }
});
