// The process identity library builds from a checkout without its build folder, as CI does. The checkout holds the Makefile of the
// repository, which declares the macOS minimum that the package reads when it builds alone. The compiler and the archiver are
// replaced by fakes that write the file of their -o or second argument and record their arguments, so the order of the folders and
// files of the Makefile is checked on any system; the compile against the macOS frameworks is the native build of the package.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPOSITORY = fileURLToPath(new URL("../../", import.meta.url));
const PACKAGE = "native/darwin/process-identity";

/** A fake command `name` in `bin` that appends its arguments to `log` and creates the file at its argument number `output`. */
function fake(bin, log, name, output) {
  const path = join(bin, name);
  writeFileSync(path, `#!/bin/sh\nprintf '%s %s\\n' '${name}' "$*" >> '${log}'\n${output}\n`);
  chmodSync(path, 0o755);
}

test("make build creates its build folder in a clean checkout", { timeout: 60000 }, (t) => {
  const checkout = mkdtempSync(join(tmpdir(), "soksak-process-identity-"));
  t.after(() => rmSync(checkout, { recursive: true, force: true }));
  cpSync(join(REPOSITORY, "Makefile"), join(checkout, "Makefile"));
  const root = join(checkout, PACKAGE);
  cpSync(join(REPOSITORY, PACKAGE), root, { recursive: true, filter: (path) => !/\/(build|lib)$/.test(path) });
  const bin = join(checkout, "bin");
  mkdirSync(bin);
  const log = join(checkout, "commands.log");
  // clang writes the file after -o; ar rcs writes the static library of its second argument.
  fake(bin, log, "clang", 'while [ "$#" -gt 0 ]; do if [ "$1" = -o ]; then : > "$2"; exit 0; fi; shift; done; exit 1');
  fake(bin, log, "ar", ': > "$2"');
  const result = spawnSync("make", ["build"], { cwd: root, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.ok(existsSync(join(root, "build", "process_identity.o")));
  assert.ok(existsSync(join(root, "lib", "libsoksak-process-identity.a")));
  assert.ok(existsSync(join(root, "lib", "pkgconfig", "soksak-process-identity.pc")));
  const commands = readFileSync(log, "utf8").trim().split("\n");
  assert.deepEqual(commands.map((line) => line.split(" ")[0]), ["clang", "ar"], commands.join("\n"));
  assert.match(commands[0], / -c src\/process_identity\.m -o \S+\/native\/darwin\/process-identity\/build\/process_identity\.o$/);
});
