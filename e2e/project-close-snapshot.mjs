import assert from "node:assert/strict";

/** Waits for a newer accepted source snapshot, then pulls until the host value satisfies the close predicate. */
export async function getClosedProjectSnapshot(s, name, source, afterSequence, predicate, message) {
  if (typeof name !== "string" || name === "" || !source || typeof source !== "object" ||
      typeof source.id !== "string" || source.id === "" ||
      (source.surface !== null && (typeof source.surface !== "string" || source.surface === "")) ||
      !Number.isSafeInteger(source.generation) || source.generation < 1 ||
      !Number.isSafeInteger(afterSequence) || afterSequence < 0 || typeof predicate !== "function") {
    throw new TypeError("closed-project snapshot requires a status, source tuple, accepted sequence and predicate");
  }
  const separator = name.indexOf(".");
  const plugin = name.slice(0, separator);
  const status = name.slice(separator + 1);
  if (separator < 1 || status === "") throw new TypeError(`closed-project snapshot status ${name} is not a declared plugin status`);
  if (source.surface === null) {
    if (source.id !== `plugin:${plugin}`) {
      throw new TypeError(`closed-project status ${name} has plugin-host source ${source.id}, expected plugin:${plugin}`);
    }
  } else if (source.id !== source.surface) {
    throw new TypeError(`closed-project status ${name} has view source id ${source.id}, expected its surface ${source.surface}`);
  }
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
