// Checks the region call allowlist of the workbench (packages/workbench/view-calls.js) against the host command table of the Tauri host
// (packages/host/tauriv2/src/bindings.rs). The table names each command as a Rust function; a name maps to camelCase.
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

const REGION_KIND = /^(document|image|composition)[A-Z]/;

// The region-kind commands of the table are exactly the names of the region allowlist: a region command that the allowlist
// omits could reach a plugin, and an allowlist name without a command of the table refuses nothing.
test("the region allowlist equals the region-kind commands of the host command table", { timeout: 5000 }, () => {
  assert.ok(viewCalls.REGION_HOST_CALLS instanceof Set, "view-calls.js exports REGION_HOST_CALLS as a Set");
  const regionKind = [...hostCommands()].filter((name) => REGION_KIND.test(name)).sort();
  assert.deepEqual([...viewCalls.REGION_HOST_CALLS].sort(), regionKind);
});

test("the region allowlist does not hold the window fact documentWebviews", { timeout: 5000 }, () => {
  assert.ok(viewCalls.REGION_HOST_CALLS instanceof Set, "view-calls.js exports REGION_HOST_CALLS as a Set");
  assert.equal(viewCalls.REGION_HOST_CALLS.has("documentWebviews"), false);
});
