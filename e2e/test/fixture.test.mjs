import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { terminalCheckShell } from "../fixture.mjs";

test("the zsh activation fixture selects a fixed executable without user startup files", () => {
  const path = terminalCheckShell("zsh");
  const mode = statSync(path).mode;

  assert.equal(path, fileURLToPath(new URL("../check-zsh", import.meta.url)));
  assert.notEqual(mode & 0o111, 0, "the zsh fixture must be executable");
  const result = spawnSync(path, [], { input: 'print -P -- "$PS1"\nexit\n', encoding: "utf8", timeout: 2000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.replace(/\r?\n$/, ""), "zle-check% ",
    "the zsh fixture must render the literal percent prompt marker");
});

test("the default window-check shell stays fixed and unsupported shell fixtures fail", () => {
  assert.equal(terminalCheckShell(), fileURLToPath(new URL("../check-shell", import.meta.url)));
  assert.throws(() => terminalCheckShell("login"), /unsupported terminal check shell "login"/);
});
