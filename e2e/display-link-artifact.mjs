import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

const finitePositive = (value) => typeof value === "number" && Number.isFinite(value) && value > 0;
const integer = (value) => Number.isSafeInteger(value) && value > 0;
const rawClock = (value, name) => {
  assert.equal(typeof value, "string", `${name} must be a decimal string`);
  assert.match(value, /^(0|[1-9][0-9]*)$/, `${name} must be a canonical unsigned decimal string`);
  return BigInt(value);
};

/** Validates the published display-link JSON fields without converting between clock domains. */
export function validateDisplayLinkRecord(record) {
  assert.ok(record && typeof record === "object" && !Array.isArray(record), "display-link artifact must be an object");
  assert.ok(["available", "unavailable", "incomplete"].includes(record.state), "display-link state is invalid");
  assert.equal(typeof record.reason, "string", "display-link reason must be a string");
  assert.ok(Array.isArray(record.observations), "display-link observations must be an array");
  assert.ok(Number.isSafeInteger(record.omittedObservations) && record.omittedObservations >= 0,
    "display-link omittedObservations must be a non-negative safe integer");
  assert.ok(record.observations.length <= 4096, "display-link observations exceed the published limit");
  if (record.state === "available") {
    assert.equal(record.reason, "", "available display-link state must not have a reason");
    assert.ok(record.observations.length > 0, "available display-link state must contain observations");
    assert.equal(record.omittedObservations, 0, "available display-link state cannot omit observations");
  } else {
    assert.ok(record.reason.length > 0, `${record.state} display-link state must explain its state`);
  }
  if (record.state === "unavailable")
    assert.equal(record.omittedObservations, 0, "unavailable display-link state cannot omit observations");
  if (record.state === "incomplete")
    assert.ok(record.omittedObservations > 0, "incomplete display-link state must report omitted observations");

  let previousTimestamp = -Infinity, previousMedia = -Infinity;
  let previousCallback = null, previousAfter = null, timebase = null;
  for (const [index, observation] of record.observations.entries()) {
    const label = `display-link observation ${index + 1}`;
    assert.ok(observation && typeof observation === "object" && !Array.isArray(observation), `${label} must be an object`);
    assert.equal(observation.sequence, index + 1, `${label} sequence must be contiguous and one-based`);
    for (const name of ["timestamp", "targetTimestamp", "duration", "callbackMediaTime"])
      assert.ok(finitePositive(observation[name]), `${label} ${name} must be a finite positive number`);
    assert.ok(observation.targetTimestamp > observation.timestamp, `${label} targetTimestamp must follow timestamp`);
    assert.ok(observation.timestamp > previousTimestamp, `${label} timestamp must increase in the Core Animation clock`);
    assert.ok(observation.callbackMediaTime >= previousMedia, `${label} callbackMediaTime must not decrease in the Core Animation clock`);
    const callback = rawClock(observation.callbackTime, `${label} callbackTime`);
    const after = rawClock(observation.mediaClockAfter, `${label} mediaClockAfter`);
    assert.ok(after >= callback, `${label} raw Mach clock bracket is reversed`);
    if (previousCallback !== null) assert.ok(callback > previousCallback, `${label} callbackTime must increase in the raw Mach clock`);
    if (previousAfter !== null) assert.ok(after >= previousAfter, `${label} mediaClockAfter must not decrease in the raw Mach clock`);
    assert.ok(integer(observation.machTimebaseNumerator), `${label} Mach timebase numerator must be a positive safe integer`);
    assert.ok(integer(observation.machTimebaseDenominator), `${label} Mach timebase denominator must be a positive safe integer`);
    const currentTimebase = `${observation.machTimebaseNumerator}/${observation.machTimebaseDenominator}`;
    if (timebase !== null) assert.equal(currentTimebase, timebase, `${label} changed the Mach timebase during one recording`);
    timebase = currentTimebase;
    assert.ok(integer(observation.windowNumber), `${label} windowNumber must be a positive safe integer`);
    assert.ok(observation.displayID === null || integer(observation.displayID), `${label} displayID must be null or a positive safe integer`);
    for (const name of ["visible", "occluded", "applicationActive"])
      assert.equal(typeof observation[name], "boolean", `${label} ${name} must be a boolean`);
    previousTimestamp = observation.timestamp;
    previousMedia = observation.callbackMediaTime;
    previousCallback = callback;
    previousAfter = after;
  }
  return record;
}

/** Copies a stop artifact into the disposable config before recording cleanup removes its source folder. */
export function preserveDisplayLinkArtifact({ frames, stop, configDir, requireStopReply = true }) {
  const config = realpathSync(configDir);
  const captureRoot = join(config, "logs", "captures");
  const frameDirectory = realpathSync(frames);
  assert.ok(frameDirectory.startsWith(`${captureRoot}/`), `recording directory is outside ${captureRoot}`);
  const expected = join(frames, "display-link.json");
  if (requireStopReply) {
    assert.equal(stop?.frames, frames, "capture stop returned a different frames directory");
    assert.equal(stop?.displayLink, expected, `capture stop displayLink path must be ${expected}`);
  } else if (stop?.displayLink !== undefined) {
    assert.equal(stop.displayLink, expected, `capture stop displayLink path must be ${expected}`);
  }
  if (!existsSync(expected)) {
    if (!requireStopReply) return null;
    throw new Error(`display-link artifact is missing: ${expected}`);
  }
  const source = realpathSync(expected);
  assert.ok(source.startsWith(`${frameDirectory}/`), "display-link artifact resolves outside the recording directory");
  const evidenceRoot = join(config, "logs", "capture-evidence");
  mkdirSync(evidenceRoot, { recursive: true });
  const evidenceDirectory = mkdtempSync(join(evidenceRoot, "display-link-"));
  const evidencePath = join(evidenceDirectory, "display-link.json");
  copyFileSync(source, evidencePath);
  const bytes = readFileSync(evidencePath);
  let record;
  try {
    record = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`preserved display-link artifact is not valid JSON at ${evidencePath}: ${error.message}`, { cause: error });
  }
  validateDisplayLinkRecord(record);
  return { source, evidencePath, record };
}
