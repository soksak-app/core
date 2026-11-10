// A plugin command declares no time limit: it ends by the reply of its handler, which ends with the reads and downloads of its
// host calls (`timeout` in docs/spec/exposure.md; the limits of those reads are in docs/spec/installation.md).
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const { exposes } = JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8"));

test("a plugin command that waits for reads and downloads declares no time limit", () => {
  const names = ["core.plugins.registry", "core.plugins.install", "core.plugins.update", "core.plugins.remove",
    "core.plugins.enable", "core.plugins.disable"];
  for (const name of names) {
    const command = exposes.commands.find((entry) => entry.name === name);
    assert.ok(command, `${name} is not declared`);
    assert.equal(Object.hasOwn(command, "timeout"), false, `${name} declares timeout ${command.timeout}`);
  }
});
