import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { cargoCommand } from "../cargo.mjs";

// The tracked folder holds a cargo program, which prints its own folder name, in each folder that the cases name; the folder
// `first` holds none, and `empty` is a home folder without a cargo folder of rustup.
const root = fileURLToPath(new URL("../fixtures/cargo-command/", import.meta.url));

/** The resolved cargo is the real program of that folder: it runs and prints the name of its folder. */
function runs(command, folder) {
  assert.equal(execFileSync(command, { encoding: "utf8" }), `${folder}\n`);
}

test("the cargo that CARGO names comes first", () => {
  const env = { CARGO: join(root, "given/cargo"), CARGO_HOME: join(root, "cargo-home"), HOME: root, PATH: join(root, "path") };
  assert.equal(cargoCommand(env), join(root, "given/cargo"));
  runs(cargoCommand(env), "given");
});

test("without CARGO, the cargo of CARGO_HOME/bin comes before the cargo of PATH", () => {
  const command = cargoCommand({ CARGO_HOME: join(root, "cargo-home"), HOME: root, PATH: join(root, "path") });
  assert.equal(command, join(root, "cargo-home/bin/cargo"));
  runs(command, "cargo-home/bin");
});

test("without CARGO_HOME, the cargo folder of rustup is .cargo/bin of HOME", () => {
  const command = cargoCommand({ HOME: join(root, "home"), PATH: join(root, "path") });
  assert.equal(command, join(root, "home/.cargo/bin/cargo"));
  runs(command, "home/.cargo/bin");
});

test("the cargo of PATH when the cargo folder of rustup holds none", () => {
  const command = cargoCommand({ HOME: join(root, "empty"), PATH: `${join(root, "first")}:${join(root, "second")}` });
  assert.equal(command, join(root, "second/cargo"));
  runs(command, "second");
});

test("a CARGO that is no executable file is an error that names it", () => {
  assert.throws(() => cargoCommand({ CARGO: join(root, "missing"), CARGO_HOME: join(root, "cargo-home"), HOME: root, PATH: "" }),
    new RegExp(`^Error: CARGO names ${join(root, "missing")}, which is no executable file$`));
});

test("no cargo in the cargo folder of rustup or in PATH is an error that names both", () => {
  const home = join(root, "empty");
  assert.throws(() => cargoCommand({ HOME: home, PATH: join(root, "first") }),
    new RegExp(`^Error: cargo is in neither ${join(home, ".cargo/bin")} nor PATH; rustup installs it in \\$CARGO_HOME/bin$`));
});

/** The JavaScript files of the scripts, the packages and the e2e folder of the checkout, without installed dependencies. */
function scriptFiles(root) {
  const found = [];
  const walk = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const path = join(folder, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(?:mjs|js|cjs)$/.test(entry.name)) found.push(path);
    }
  };
  for (const folder of ["scripts", "packages", "e2e"]) walk(join(root, folder));
  return found;
}

test("no script of the checkout starts cargo by its bare name", () => {
  const checkout = fileURLToPath(new URL("../../../", import.meta.url));
  const bare = /\b(?:spawnSync|spawn|execFileSync|execFile|execFileAsync)\(\s*["'`]cargo["'`]/;
  const starting = scriptFiles(checkout).filter((path) => bare.test(readFileSync(path, "utf8"))).map((path) => relative(checkout, path));
  assert.deepEqual(starting, [], "these files start cargo from PATH instead of the cargo that cargoCommand resolves");
});
