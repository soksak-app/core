// Verifies the recipes of the Makefiles: every recipe of the root Makefile finds cargo under GNU Make 3.81, which runs a recipe
// line without shell characters itself and looks its program up in the PATH that make started with, not in the PATH that the
// Makefile exports; and every recipe that runs $(MAKE) names a target of the Makefile that it runs.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "../..");
// The PATH of a shell that did not read the profile, which adds the cargo folder of rustup.
const BARE_PATH = "/usr/bin:/bin";

// The cargo of the toolchain that rustup selects. A test links this real executable into the cargo folder that it names.
function realCargo() {
  return execFileSync("rustup", ["which", "cargo"], { encoding: "utf8" }).trim();
}

test("managed mygo verification prepares declared native fixtures and selects CGO0", () => {
  const text = readFileSync(join(root, "Makefile"), "utf8");
  const rule = (name) => {
    const match = text.match(new RegExp(`^${name}:([^\\n]*)\\n((?:\\t[^\\n]*\\n)*)`, "m"));
    assert.ok(match, `missing ${name} target`);
    return { prerequisites: match[1].trim().split(/\s+/), recipe: match[2] };
  };
  const mygo = rule("test-mygo");
  assert.ok(mygo.prerequisites.includes("build-native-mygo"));
  assert.ok(mygo.prerequisites.includes("build-native-tests"));
  assert.match(mygo.recipe, /CGO_ENABLED=0[^\n]*scripts\/go-tests\.mjs/);
  // F694: a cgo-free link still needs Go's public internal-linker macOS
  // minimum. Generic linker flags are mandatory; cgo external flags stay out.
  assert.ok(/^GO_INTERNAL_LINK\s*=\s*-macos=\$\(MACOS_MINIMUM\)\s*$/m.test(text), "GO_INTERNAL_LINK must declare -macos=$(MACOS_MINIMUM)");
  const workbench = mygo.recipe.split("\n").find((line) => line.includes("scripts/go-tests.mjs"));
  const contract = mygo.recipe.split("\n").find((line) => line.includes("scripts/test-hosts.mjs"));
  assert.match(workbench, /--ldflags=['"]\$\(GO_INTERNAL_LINK\)['"]/);
  assert.match(contract, /--go-ldflags=['"]\$\(GO_INTERNAL_LINK\)['"]/);
  assert.doesNotMatch(mygo.recipe, /--cgo-ldflags|\$\(GO_LINK\)|-extldflags/);
  const fixtures = rule("build-native-tests");
  for (const target of ["build-host-test", "build-host-callback-abi", "build-host-callback-worker"]) {
    assert.ok(fixtures.recipe.includes(target), `missing native fixture ${target}`);
  }
  for (const name of ["test-hosts", "test-wailsv3"]) {
    const selected = rule(name);
    assert.ok(selected.prerequisites.includes("build-native-tests"), name);
    assert.match(selected.recipe, /--cgo-ldflags=/);
  }
  assert.match(rule("test-hosts").recipe, /--go-ldflags=['"]\$\(GO_INTERNAL_LINK\)['"]/, "the mixed host run must retain the internal macOS minimum in its CGO0 profile");
  const repeat = rule("repeat-go");
  assert.doesNotMatch(repeat.recipe, /go-repeat-inputs\.mjs/);
  assert.match(repeat.recipe, /--cgo-ldflags=/);
  assert.match(repeat.recipe, /--ldflags='\$\(GO_LDFLAGS\)'/, "portable repeat-go must forward caller-selected generic GO_LDFLAGS");
  const debug = rule("check-host-debug");
  for (const directory of ["apps/mygo", "packages/host/mygo"]) {
    const line = debug.recipe.split("\n").find((line) => line.includes(`go vet -C ${directory} `));
    assert.match(line, /CGO_ENABLED=0/);
    assert.doesNotMatch(line, /\$\(GO_ENV\)/);
  }
  const benchmark = rule("benchmark-empty-window").recipe;
  assert.match(benchmark, /CGO_ENABLED=0/);
  assert.match(benchmark, /-ldflags ['"]\$\(GO_INTERNAL_LINK\)['"]/);
  assert.doesNotMatch(benchmark, /\$\(GO_LINK\)|-extldflags/);
});

// Runs make with only HOME, the bare PATH and, when given, CARGO_HOME in its environment, so no variable of the environment of
// the test (CARGO, CARGO_HOME, MAKEFLAGS) reaches it.
function make({ home, cargoHome }, makefiles, target) {
  return spawnSync("/usr/bin/make", [...makefiles.flatMap((file) => ["-f", file]), target], {
    cwd: root, encoding: "utf8", timeout: 60000,
    env: { HOME: home, PATH: BARE_PATH, ...(cargoHome === undefined ? {} : { CARGO_HOME: cargoHome }) },
  });
}

// A make file that runs $(CARGO) --version on a recipe line without shell characters.
function cargoProbe(t) {
  const folder = mkdtempSync(join(tmpdir(), "soksak-make-cargo-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const probe = join(folder, "probe.mk");
  writeFileSync(probe, "probe-cargo:\n\t$(CARGO) --version\n");
  return { folder, probe };
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
  // rustup installs cargo in $CARGO_HOME/bin, which is ~/.cargo/bin when CARGO_HOME is not set; the cargo folder of HOME holds
  // the real cargo of the toolchain.
  const { folder, probe } = cargoProbe(t);
  const home = join(folder, "home");
  mkdirSync(join(home, ".cargo", "bin"), { recursive: true });
  const cargo = realCargo();
  symlinkSync(cargo, join(home, ".cargo", "bin", "cargo"));
  const version = execFileSync(cargo, ["--version"], { encoding: "utf8" }).trim();
  const result = make({ home }, ["Makefile", probe], "probe-cargo");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(result.stdout.split("\n").includes(version), result.stdout + result.stderr);
});

test("a recipe line runs the cargo of CARGO_HOME when CARGO_HOME is not the cargo folder of HOME", (t) => {
  // A hosted runner sets CARGO_HOME to a folder outside HOME; the cargo folder there holds the real cargo of the toolchain.
  const { folder, probe } = cargoProbe(t);
  const cargoHome = join(folder, "cargo-home");
  mkdirSync(join(cargoHome, "bin"), { recursive: true });
  const cargo = realCargo();
  symlinkSync(cargo, join(cargoHome, "bin", "cargo"));
  const version = execFileSync(cargo, ["--version"], { encoding: "utf8" }).trim();
  const result = make({ home: "/nonexistent", cargoHome }, ["Makefile", probe], "probe-cargo");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(result.stdout.split("\n").includes(version), result.stdout + result.stderr);
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
  const result = make({ home: "/nonexistent" }, ["Makefile"], "check-cargo");
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /cargo is on neither PATH nor \/nonexistent\/\.cargo\/bin; rustup installs it there/, result.stderr);
});

// The tracked Makefiles of the repository.
function trackedMakefiles() {
  const result = spawnSync("git", ["ls-files", "--", "Makefile", "*/Makefile"], { cwd: root, encoding: "utf8", timeout: 20000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.split("\n").filter(Boolean);
}

// The targets that make knows in `folder`: the explicit targets and the pattern rules of its database, each pattern rule with
// its prerequisites. make prints the database for a goal that has no rule and runs no recipe of the Makefile.
function knownTargets(folder) {
  const goal = "no-such-goal-of-the-recipe-test";
  const result = spawnSync("make", ["-pRrq", "-C", folder, "--no-print-directory", goal], { cwd: root, encoding: "utf8", timeout: 60000 });
  // GNU Make 3.81 quotes the target as `goal', GNU Make 4 as 'goal'.
  assert.match(result.stderr, new RegExp(`No rule to make target [\`']${goal}'`), result.stderr);
  const explicit = new Set();
  const patterns = [];
  const lines = result.stdout.split("\n");
  for (const [index, line] of lines.entries()) {
    if (lines[index - 1] === "# Not a target:") continue;
    const rule = line.match(/^([^\s#:][^:=]*?)::?(?!=)(.*)$/);
    if (!rule) continue;
    if (rule[1].includes("%")) patterns.push({ pattern: rule[1], prerequisites: rule[2].split("|")[0].trim().split(/\s+/).filter(Boolean) });
    else explicit.add(rule[1]);
  }
  return { explicit, patterns };
}

// Whether make in `folder` has a rule for `target`: an explicit target, or a pattern rule whose first prerequisite for the
// stem of the target is a file or a target.
function hasRule(folder, { explicit, patterns }, target) {
  if (explicit.has(target)) return true;
  return patterns.some(({ pattern, prerequisites }) => {
    const [prefix, suffix] = pattern.split("%");
    if (!target.startsWith(prefix) || !target.endsWith(suffix) || target.length < prefix.length + suffix.length) return false;
    const first = prerequisites[0]?.replace("%", target.slice(prefix.length, target.length - suffix.length));
    return first === undefined || explicit.has(first) || existsSync(resolve(folder, first));
  });
}

// The words of the command that starts at `text`, up to the end of the command: a `;`, `|`, `&` or a `)` that closes no make
// reference of the command. A make reference `$(...)` stays inside its word.
function commandWords(text) {
  const words = [];
  let word = "";
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "$" && text[index + 1] === "(") {
      depth += 1;
      word += "$(";
      index += 1;
    } else if (depth > 0) {
      if (character === ")") depth -= 1;
      word += character;
    } else if (/[;|&)]/.test(character)) {
      break;
    } else if (/\s/.test(character)) {
      if (word) words.push(word);
      word = "";
    } else {
      word += character;
    }
  }
  if (word) words.push(word);
  return words;
}

// The runs of $(MAKE) in the recipes of `makefile`: the folder that each runs in and the goals that it names. $(CURDIR) is the
// folder of the Makefile.
function subMakes(makefile) {
  const folder = join(root, dirname(makefile));
  const runs = [];
  for (const line of readFileSync(join(root, makefile), "utf8").replace(/\\\n/g, " ").split("\n")) {
    if (!line.startsWith("\t")) continue;
    for (const match of line.matchAll(/\$\(MAKE\)/g)) {
      const written = commandWords(line.slice(match.index + match[0].length));
      const words = written.map((word) => word.replaceAll("$(CURDIR)", folder));
      let runFolder = folder;
      const goals = [];
      for (let index = 0; index < words.length; index += 1) {
        const word = words[index];
        if (word === "-C" || word === "-f") {
          if (word === "-C") runFolder = resolve(folder, words[index + 1]);
          index += 1;
        } else if (!word.startsWith("-") && !word.includes("=")) {
          goals.push(word);
        }
      }
      runs.push({ command: ["$(MAKE)", ...written].join(" "), folder: runFolder, goals });
    }
  }
  return runs;
}

test("each run of $(MAKE) in a recipe of a Makefile names targets of the Makefile that it runs", () => {
  const databases = new Map();
  const missing = [];
  let goals = 0;
  for (const makefile of trackedMakefiles()) {
    for (const run of subMakes(makefile)) {
      if (!databases.has(run.folder)) databases.set(run.folder, knownTargets(run.folder));
      for (const goal of run.goals) {
        goals += 1;
        if (goal.includes("$") || !hasRule(run.folder, databases.get(run.folder), goal)) {
          missing.push(`${makefile}: ${goal} is no target of ${relative(root, run.folder) || "."}: ${run.command}`);
        }
      }
    }
  }
  assert.ok(goals > 0, "no run of $(MAKE) names a goal");
  assert.deepEqual(missing, [], missing.join("\n"));
});
