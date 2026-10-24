import assert from "node:assert/strict";

/** Waits for a newer accepted source snapshot, then pulls until the host value satisfies the close predicate. */
export async function getClosedProjectSnapshot(s, name, source, afterSequence, predicate, message) {
  const plugin = source.id;
  const status = name.slice(plugin.length + 1);
  let sequence = afterSequence;
  for (;;) {
    await s.until("core.plugin.snapshots", (rows) => rows?.some((row) =>
      row.plugin === plugin && row.status === status && row.surface === source.surface &&
      row.generation === source.generation && row.seq > sequence),
    `${name} did not publish a newer snapshot from its current source`);
    const rows = await s.get("core.plugin.snapshots");
    const accepted = rows?.find((row) => row.plugin === plugin && row.status === status &&
      row.surface === source.surface && row.generation === source.generation && row.seq > sequence);
    if (!accepted) continue;
    const snapshot = await s.get(name);
    assert.ok(Number.isInteger(snapshot?.version) && snapshot.version >= accepted.seq,
      `${name} returned a snapshot older than its accepted sequence`);
    if (predicate(snapshot.value)) return snapshot;
    sequence = Math.max(accepted.seq, snapshot.version);
  }
}
