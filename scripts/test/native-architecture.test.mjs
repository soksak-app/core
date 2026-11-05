// Checks that the native library of native/darwin builds every part for the architecture of the release platform
// darwin-arm64: each clang call and the ZXing configure name it, so a make that runs as a translated process builds no
// part for another architecture, and ZXing is configured in a new build folder whenever it is built.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const nativeDarwin = join(root, "native/darwin");
const processIdentity = join(nativeDarwin, "process-identity");
const makefiles = [join(nativeDarwin, "Makefile"), join(processIdentity, "Makefile")];

function folder(t) {
  const directory = mkdtempSync(join(tmpdir(), "soksak-native-architecture-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

// The commands that make prints for the arguments without running them, one command per line: a line that ends with a
// backslash continues on the next line.
function dryRun(directory, args) {
  const result = spawnSync("make", ["-n", "-C", directory, ...args], { cwd: root, encoding: "utf8", timeout: 5000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  return result.stdout.replace(/\\\n\s*/g, " ").split("\n").map((line) => line.trim().replace(/^@/, ""));
}

const commit = () => readFileSync(makefiles[0], "utf8").match(/^ZXING_COMMIT\s*:=\s*(\S+)/m)[1];

test("every clang call of the native Makefiles reads the flags that name the architecture", { timeout: 1000 }, () => {
  for (const makefile of makefiles) {
    const recipes = readFileSync(makefile, "utf8").split("\n").filter((line) => /^\t@?clang\b/.test(line));
    assert.ok(recipes.length > 0, `${makefile} has no clang call`);
    assert.deepEqual(recipes.filter((line) => !line.includes("$(CFLAGS)")), [], `${makefile} has a clang call without $(CFLAGS)`);
  }
});

test("the library build compiles every object and configures ZXing for arm64 in a new build folder", { timeout: 10000 }, (t) => {
  const build = folder(t);
  const commands = dryRun(nativeDarwin, [`BUILD=${build}`, `${build}/libsoksak-darwin.a`]);
  const compiles = commands.filter((line) => /^clang\b/.test(line));
  assert.ok(compiles.length > 0, commands.join("\n"));
  assert.deepEqual(compiles.filter((line) => !/(^|\s)-arch arm64(\s|$)/.test(line)), [], "a clang call of the library names no arm64");
  const configure = commands.findIndex((line) => /^cmake -S\b/.test(line));
  assert.ok(configure >= 0, commands.join("\n"));
  assert.match(commands[configure], /(^|\s)-DCMAKE_OSX_ARCHITECTURES=arm64(\s|$)/);
  const removal = commands.findIndex((line) => line === `rm -rf ${build}/zxing-cpp-build ${build}/zxing-cpp-install`);
  assert.ok(removal >= 0 && removal < configure, `the ZXing configure does not start from a new build folder:\n${commands.join("\n")}`);
  const identity = folder(t);
  const identityCompiles = dryRun(processIdentity, [`BUILD=${identity}/build`, `LIBDIR=${identity}/lib`, "build"])
    .filter((line) => /^clang\b/.test(line));
  assert.ok(identityCompiles.length > 0);
  assert.deepEqual(identityCompiles.filter((line) => !/(^|\s)-arch arm64(\s|$)/.test(line)), [], "a clang call of process identity names no arm64");
});

test("a ZXing library older than the Makefile is built again", { timeout: 10000 }, (t) => {
  const build = folder(t);
  const releaseFile = join(build, `zxing-cpp-${commit()}.tar.gz`);
  const license = join(build, `zxing-cpp-${commit()}`, "LICENSE");
  const library = join(build, "zxing-cpp-install", "lib", "libZXing.a");
  for (const file of [releaseFile, license, library]) {
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "");
  }
  // Each file is newer than the file it is made from and older than the Makefile.
  const makefileTime = statSync(makefiles[0]).mtime.getTime() / 1000;
  [releaseFile, license, library].forEach((file, index) => utimesSync(file, makefileTime - 30 + index, makefileTime - 30 + index));
  const commands = dryRun(nativeDarwin, [`BUILD=${build}`, "OFFLINE=1", library]);
  assert.ok(commands.some((line) => /^cmake -S\b/.test(line)), `the ZXing library older than the Makefile is not built again:\n${commands.join("\n")}`);
});
