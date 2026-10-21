// Checks the plugin-facing host call allowlist of the workbench (packages/workbench/view-calls.js): no name of it is a region call
// or a view bridge call. The host side of the allowlist is the host contract case plugin-host.call.refuses-unlisted-commands
// (docs/spec/host-contract.md), which the Go and Rust host tests run; this test reads no source of another package.
import assert from "node:assert/strict";
import test from "node:test";

const viewCalls = await import(new URL("../../packages/workbench/view-calls.js", import.meta.url));

test("the plugin allowlist holds names that are neither region calls nor view bridge calls", { timeout: 5000 }, () => {
  assert.ok(viewCalls.PLUGIN_HOST_CALLS instanceof Set, "view-calls.js exports PLUGIN_HOST_CALLS as a Set");
  for (const name of viewCalls.PLUGIN_HOST_CALLS) {
    assert.equal(viewCalls.REGION_HOST_CALLS.has(name), false, `${name} is not a region call`);
    assert.equal(viewCalls.VIEW_BRIDGE_CALLS.has(name), false, `${name} is not a view bridge call`);
  }
});
