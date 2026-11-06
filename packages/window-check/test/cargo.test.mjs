// The cargo that the scripts and the checks of the repository start: CARGO of the environment, then the cargo folder of rustup,
// then PATH, the order of the Makefile.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cargoCommand } from "../cargo.mjs";

/** A folder with an executable `cargo` in each of the named subfolders. */
function folders(t, names) {
  const root = mkdtempSync(join(tmpdir(), "soksak-cargo-command-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of names) {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(join(root, name, "cargo"), "#!/bin/sh\n");
    chmodSync(join(root, name, "cargo"), 0o755);
  }
  return root;
}

test("the cargo that CARGO names comes first", (t) => {
  const root = folders(t, ["given", "cargo-home/bin", "path"]);
  const env = { CARGO: join(root, "given/cargo"), CARGO_HOME: join(root, "cargo-home"), HOME: root, PATH: join(root, "path") };
  assert.equal(cargoCommand(env), join(root, "given/cargo"));
});

test("without CARGO, the cargo of CARGO_HOME/bin comes before the cargo of PATH", (t) => {
  const root = folders(t, ["cargo-home/bin", "path"]);
  assert.equal(cargoCommand({ CARGO_HOME: join(root, "cargo-home"), HOME: root, PATH: join(root, "path") }), join(root, "cargo-home/bin/cargo"));
});

test("without CARGO_HOME, the cargo folder of rustup is .cargo/bin of HOME", (t) => {
  const root = folders(t, ["home/.cargo/bin", "path"]);
  assert.equal(cargoCommand({ HOME: join(root, "home"), PATH: join(root, "path") }), join(root, "home/.cargo/bin/cargo"));
});

test("the cargo of PATH when the cargo folder of rustup holds none", (t) => {
  const root = folders(t, ["first", "second"]);
  rmSync(join(root, "first", "cargo"));
  assert.equal(cargoCommand({ HOME: join(root, "home"), PATH: `${join(root, "first")}:${join(root, "second")}` }), join(root, "second/cargo"));
});

test("a CARGO that is no executable file is an error that names it", (t) => {
  const root = folders(t, ["cargo-home/bin"]);
  assert.throws(() => cargoCommand({ CARGO: join(root, "missing"), CARGO_HOME: join(root, "cargo-home"), HOME: root, PATH: "" }),
    new RegExp(`^Error: CARGO names ${join(root, "missing")}, which is no executable file$`));
});

test("no cargo in the cargo folder of rustup or in PATH is an error that names both", (t) => {
  const root = folders(t, []);
  assert.throws(() => cargoCommand({ HOME: root, PATH: "/nonexistent-path-folder" }),
    new RegExp(`^Error: cargo is in neither ${join(root, ".cargo/bin")} nor PATH; rustup installs it in \\$CARGO_HOME/bin$`));
});
