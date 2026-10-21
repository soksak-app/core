// Checks the region call allowlist of the workbench (packages/workbench/view-calls.js). Which host commands a plugin can reach
// is decided by the host contract case plugin-host.call.refuses-unlisted-commands (docs/spec/host-contract.md), which the Go and
// Rust host tests run against their command tables; this test reads no source of another package.
import assert from "node:assert/strict";
import test from "node:test";

const viewCalls = await import(new URL("../../packages/workbench/view-calls.js", import.meta.url));

test("the region allowlist does not hold the window fact documentWebviews", { timeout: 5000 }, () => {
  assert.ok(viewCalls.REGION_HOST_CALLS instanceof Set, "view-calls.js exports REGION_HOST_CALLS as a Set");
  assert.equal(viewCalls.REGION_HOST_CALLS.has("documentWebviews"), false);
});
