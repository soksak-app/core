// An issued id is new for its kind: an id that the caller reports as taken is issued again, so a new tab never takes the
// id of a stored tab, a held surface or a persistent session (docs/spec/projects.md).
import assert from "node:assert/strict";
import test from "node:test";

test("an id that is taken is issued again", { timeout: 5000 }, async () => {
  // The first draw gives tab-aaaaaa, the second tab-bbbbbb. The draws are the random source that issueId receives.
  const draws = [0, 1];
  const { issueId } = await import("../ids.js");
  assert.equal(issueId("tab", (id) => id === "tab-aaaaaa", (buf) => buf.fill(draws.shift())), "tab-bbbbbb");
  assert.deepEqual(draws, []);
});

test("an id is formed from the bytes of the random source, six characters of the base32 alphabet after the kind", { timeout: 5000 }, async () => {
  const { issueId } = await import("../ids.js");
  // Each byte selects one character: the value 31 selects the last character, 7, and the bytes wrap at 32.
  assert.equal(issueId("project", () => false, (buf) => buf.set([0, 1, 2, 3, 4, 31])), "prj-abcde7");
  assert.equal(issueId("space", () => false, (buf) => buf.set([32, 33, 34, 35, 36, 37])), "spc-abcdef");
});

test("an id kind with a random source that is not a function is refused", { timeout: 5000 }, async () => {
  const { issueId } = await import("../ids.js");
  assert.throws(() => issueId("tab", () => false, 7), /issueId\(tab\) needs a random source function, not 7/);
});

test("an id kind without a taken check is refused", { timeout: 5000 }, async () => {
  const { issueId } = await import("../ids.js");
  assert.throws(() => issueId("tab"), /issueId\(tab\) needs a check of the taken ids, not undefined/);
});
