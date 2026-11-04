import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { restoreRegistry, terminalCheckShell, useRegistry } from "../fixture.mjs";

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

test("a registry that a failed restore left is restored from the record of the first run", async (t) => {
  const configDir = mkdtempSync(join(tmpdir(), "check-registry-"));
  t.after(() => rmSync(configDir, { recursive: true, force: true }));
  let registry = "https://registry.example/index.json";
  let failing = false;
  const s = {
    app: { configDir },
    get: async (name) => {
      assert.equal(name, "core.plugins");
      return { registry };
    },
    run: async (name, { index }) => {
      assert.equal(name, "core.plugins.registry");
      if (failing) throw new Error("the registry command failed");
      registry = index;
    },
  };

  await restoreRegistry(s);
  assert.equal(registry, "https://registry.example/index.json", "a restore without a held registry changed the registry");
  await useRegistry(s, "file:///first/index.json");
  assert.equal(registry, "file:///first/index.json");
  failing = true;
  await assert.rejects(restoreRegistry(s), /the registry command failed/);
  failing = false;

  await useRegistry(s, "file:///second/index.json");
  assert.equal(registry, "file:///second/index.json");
  await restoreRegistry(s);
  assert.equal(registry, "https://registry.example/index.json", "a later run restored the registry that the failed restore left");
  await restoreRegistry(s);
  assert.equal(registry, "https://registry.example/index.json");
  await useRegistry(s, "file:///third/index.json");
  await restoreRegistry(s);
  assert.equal(registry, "https://registry.example/index.json", "the record of an ended run was used again");
});
