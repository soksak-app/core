import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { terminalCheckShell } from "../fixture.mjs";

test("the zsh activation fixture selects a fixed executable without user startup files", () => {
  const path = terminalCheckShell("zsh");
  const source = readFileSync(path, "utf8");
  const mode = statSync(path).mode;

  assert.equal(path, fileURLToPath(new URL("../check-zsh", import.meta.url)));
  assert.notEqual(mode & 0o111, 0, "the zsh fixture must be executable");
  assert.match(source, /^#!\/bin\/sh\n/);
  assert.match(source, /^export PS1='zle-check% '\nexec \/bin\/zsh -f\n$/m);
});

test("the default window-check shell stays fixed and unsupported shell fixtures fail", () => {
  assert.equal(terminalCheckShell(), fileURLToPath(new URL("../check-shell", import.meta.url)));
  assert.throws(() => terminalCheckShell("login"), /unsupported terminal check shell "login"/);
});
