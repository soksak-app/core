// Verifies that every recipe of the Makefile finds cargo under GNU Make 3.81, which runs a recipe line without shell
// characters itself and looks its program up in the PATH that make started with, not in the PATH that the Makefile exports.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "../..");
// The PATH of a shell that did not read the profile, which adds the cargo folder of rustup.
const BARE_PATH = "/usr/bin:/bin";

function make(home, makefiles, target) {
  return spawnSync("/usr/bin/env", [`HOME=${home}`, `PATH=${BARE_PATH}`, "make", ...makefiles.flatMap((file) => ["-f", file]), target], {
    cwd: root, encoding: "utf8", timeout: 60000,
  });
}

// The programs that a line of shell runs: the first word of each command, after its variable assignments and the
// references to make variables that hold assignments (`$(CARGO_ENV)`). Quoted text and make references are not programs.
function programs(line) {
  const text = line
    .replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, "''")
    .replace(/\$\((?:[^()]|\([^()]*\))*\)/g, "$REF");
  return text.split(/;|&&|\|\||\||\(|\)|\s--\s|\bthen\b|\bdo\b|\belse\b/).flatMap((command) => {
    const words = command.trim().replace(/^[@+-]+/, "").split(/\s+/).filter(Boolean);
    while (words.length > 0 && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]) || words[0] === "$REF" && words.length > 1)) words.shift();
    return words.length > 0 ? [words[0]] : [];
  });
}

test("a recipe line without shell characters runs CARGO when the PATH of make holds no cargo folder", (t) => {
  const cargo = join(homedir(), ".cargo", "bin", "cargo");
  assert.ok(existsSync(cargo), `the test needs the cargo of rustup at ${cargo}`);
  const folder = mkdtempSync(join(tmpdir(), "soksak-make-cargo-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const probe = join(folder, "probe.mk");
  writeFileSync(probe, "probe-cargo:\n\t$(CARGO) --version\n");
  const result = make(homedir(), ["Makefile", probe], "probe-cargo");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^cargo \d+\.\d+\.\d+/m, result.stdout + result.stderr);
});

test("no recipe or variable of the Makefile runs cargo other than through CARGO", () => {
  const lines = readFileSync(join(root, "Makefile"), "utf8").replace(/\\\n/g, " ").split("\n");
  const found = [];
  for (const line of lines) {
    if (/^\s*#/.test(line) || /^CARGO :?= /.test(line)) continue;
    const command = line.startsWith("\t") ? line : line.match(/^[A-Za-z0-9_.-]+ *[:?+]?= *(.*)$/)?.[1];
    if (command === undefined) continue;
    if (programs(command).includes("cargo")) found.push(line.trim());
  }
  assert.deepEqual(found, [], `recipes that run cargo by name:\n${found.join("\n")}`);
});

test("each target whose recipe runs CARGO requires check-cargo", () => {
  const text = readFileSync(join(root, "Makefile"), "utf8").replace(/\\\n/g, " ");
  const cargoVariables = [...text.matchAll(/^([A-Za-z0-9_.-]+) *[:?+]?= .*\$\(CARGO\)/gm)].map((match) => match[1]);
  const runsCargo = (line) => line.includes("$(CARGO)") || cargoVariables.some((name) => line.includes(`$(call ${name},`) || line.includes(`$(${name})`));
  const missing = [];
  let rule = null;
  for (const line of text.split("\n")) {
    const header = line.match(/^([A-Za-z0-9_. -]+):(?!=)(.*)$/);
    // check-cargo reads CARGO and runs no cargo.
    if (header) rule = header[1].trim() === "check-cargo" ? null : { targets: header[1].trim().split(/\s+/), prerequisites: header[2].trim().split(/\s+/) };
    else if (rule && line.startsWith("\t") && runsCargo(line) && !rule.prerequisites.includes("check-cargo")) {
      missing.push(rule.targets.join(" "));
      rule = null;
    }
  }
  assert.ok(cargoVariables.length > 0, "the Makefile defines no variable that runs $(CARGO)");
  assert.deepEqual(missing, [], `targets that run cargo without check-cargo: ${missing.join(", ")}`);
});

test("check-cargo stops with a message when neither the PATH of make nor the cargo folder of HOME holds cargo", () => {
  const result = make("/nonexistent", ["Makefile"], "check-cargo");
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /cargo is on neither PATH nor \/nonexistent\/\.cargo\/bin; rustup installs it there/, result.stderr);
});
