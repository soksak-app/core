// Checks the plugin-facing host call allowlist of the workbench (packages/workbench/view-calls.js) against the host command table of
// the Tauri host (packages/host/tauriv2/src/bindings.rs). A name in the allowlist must be a command of the table.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = new URL("../..", import.meta.url);
const viewCalls = await import(new URL("packages/workbench/view-calls.js", ROOT));

function hostCommands() {
  const source = readFileSync(fileURLToPath(new URL("packages/host/tauriv2/src/bindings.rs", ROOT)), "utf8");
  const names = new Set();
  for (const match of source.matchAll(/^fn ([a-z_]+)\(/gm)) names.add(match[1].replace(/_([a-z])/g, (_, c) => c.toUpperCase()));
  return names;
}

test("every host command of the plugin allowlist is a command of the host command table", { timeout: 5000 }, () => {
  assert.ok(viewCalls.PLUGIN_HOST_CALLS instanceof Set, "view-calls.js exports PLUGIN_HOST_CALLS as a Set");
  const commands = hostCommands();
  for (const name of viewCalls.PLUGIN_HOST_CALLS) assert.ok(commands.has(name), `${name} is a host command`);
  for (const name of viewCalls.PLUGIN_HOST_CALLS) assert.equal(viewCalls.REGION_HOST_CALLS.has(name), false, `${name} is not a region call`);
});
