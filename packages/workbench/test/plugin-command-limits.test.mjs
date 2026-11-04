// Checks that a plugin command declares a reply limit that covers the network reads of its host calls (limits of docs/spec/installation.md).
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const { exposes } = JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8"));
const limitOf = (name) => exposes.commands.find((command) => command.name === name)?.timeout;

test("a plugin command declares the limit of the reads and downloads that it waits for", () => {
  // Three index reads of 60 seconds: the registry address, the plugin state and the application update state.
  assert.equal(limitOf("core.plugins.registry"), 180000, "core.plugins.registry");
  // A download of a release may take 600 seconds, which is the largest limit of a command.
  for (const name of ["core.plugins.install", "core.plugins.update", "core.plugins.remove"]) {
    assert.equal(limitOf(name), 600000, name);
  }
  // The local change and one index read of 60 seconds for the state that follows it.
  for (const name of ["core.plugins.enable", "core.plugins.disable"]) {
    assert.equal(limitOf(name), 120000, name);
  }
});
