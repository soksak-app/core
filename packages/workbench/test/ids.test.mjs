// An issued id is new for its kind: an id that the caller reports as taken is issued again, so a new tab never takes the
// id of a stored tab, a held surface or a persistent session (docs/spec/projects.md).
import assert from "node:assert/strict";
import test from "node:test";

test("an id that is taken is issued again", { timeout: 5000 }, async (t) => {
  // The first draw gives tab-aaaaaa, the second tab-bbbbbb.
  const draws = [0, 1];
  t.mock.method(crypto, "getRandomValues", (buf) => buf.fill(draws.shift()));
  const { issueId } = await import("../ids.js");
  assert.equal(issueId("tab", (id) => id === "tab-aaaaaa"), "tab-bbbbbb");
  assert.deepEqual(draws, []);
});

test("an id kind without a taken check is refused", { timeout: 5000 }, async () => {
  const { issueId } = await import("../ids.js");
  assert.throws(() => issueId("tab"), /issueId\(tab\) needs a check of the taken ids, not undefined/);
});
