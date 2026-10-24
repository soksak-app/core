import assert from "node:assert/strict";

/** Pulls and validates the current plugin-host snapshot after its section is no longer mounted. */
export async function getClosedProjectSnapshot(s, name, afterSequence, predicate, message) {
  const snapshot = await s.get(name);
  assert.ok(Number.isInteger(snapshot?.version) && snapshot.version > afterSequence,
    `${name} did not return a newer snapshot`);
  assert.ok(predicate(snapshot.value), message);
  return snapshot;
}
