import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { preserveDisplayLinkArtifact, validateDisplayLinkRecord } from "../display-link-artifact.mjs";

const observation = (sequence, overrides = {}) => ({
  sequence, timestamp: sequence, targetTimestamp: sequence + 0.016, duration: 0.016,
  callbackTime: String(sequence * 1000), callbackMediaTime: sequence + 0.001, mediaClockAfter: String(sequence * 1000 + 1),
  machTimebaseNumerator: 1, machTimebaseDenominator: 1, windowNumber: 1, displayID: 1,
  visible: true, occluded: false, applicationActive: false, ...overrides,
});
const record = (state = "available", fields = {}) => ({ state,
  reason: state === "available" ? "" : "the display link was unavailable", observations: [observation(1)],
  omittedObservations: state === "incomplete" ? 1 : 0, ...fields });

test("display-link metadata accepts available, unavailable and incomplete states without merging clock domains", () => {
  assert.equal(validateDisplayLinkRecord(record()).state, "available");
  assert.equal(validateDisplayLinkRecord(record("unavailable", { observations: [] })).state, "unavailable");
  assert.equal(validateDisplayLinkRecord(record("unavailable")).observations.length, 1,
    "an unavailable run may retain observations sampled while hidden or off-display");
  assert.equal(validateDisplayLinkRecord(record("incomplete")).omittedObservations, 1);
  assert.equal(validateDisplayLinkRecord({ ...record(), observations: [observation(1), observation(2)] }).observations.length, 2);
});

test("display-link metadata allows a later refresh forecast to move earlier", () => {
  const first = observation(1, { timestamp: 1, targetTimestamp: 1.016, callbackMediaTime: 1.001 });
  const second = observation(2, { timestamp: 1.01, targetTimestamp: 1.015, callbackTime: "2000",
    callbackMediaTime: 1.002, mediaClockAfter: "2001" });
  assert.equal(validateDisplayLinkRecord({ ...record(), observations: [first, second] }).observations.length, 2);
});

test("display-link metadata allows equal callback reads at finite media-clock precision", () => {
  const first = observation(1, { timestamp: 1, targetTimestamp: 1.016, callbackMediaTime: 1.001 });
  const second = observation(2, { timestamp: 1.01, targetTimestamp: 1.02, callbackTime: "2000",
    callbackMediaTime: 1.001, mediaClockAfter: "2001" });
  assert.equal(validateDisplayLinkRecord({ ...record(), observations: [first, second] }).observations.length, 2);
});

test("display-link metadata rejects malformed states, fields and non-monotonic clocks", () => {
  const invalid = [
    [{ ...record(), state: "unknown" }, /state is invalid/],
    [record("unavailable", { reason: "" }), /must explain its state/],
    [record("available", { observations: [] }), /must contain observations/],
    [record("incomplete", { omittedObservations: 0 }), /must report omitted observations/],
    [{ ...record(), observations: [observation(2)] }, /sequence must be contiguous/],
    [{ ...record(), observations: [observation(1), observation(2, { timestamp: 1 })] }, /timestamp must increase/],
    [{ ...record(), observations: [observation(1), observation(2, { callbackMediaTime: 1 })] }, /callbackMediaTime must not decrease/],
    [{ ...record(), observations: [observation(1), observation(2, { callbackTime: "1000" })] }, /callbackTime must increase/],
    [{ ...record(), observations: [observation(1, { callbackTime: "01" })] }, /canonical unsigned decimal/],
    [{ ...record(), observations: [observation(1, { mediaClockAfter: "999" })] }, /bracket is reversed/],
    [{ ...record(), observations: [observation(1, { visible: 1 })] }, /visible must be a boolean/],
  ];
  for (const [value, message] of invalid) assert.throws(() => validateDisplayLinkRecord(value), message);
});

test("capture stop preserves the declared artifact in config evidence before recording cleanup", () => {
  const configDir = mkdtempSync(join(tmpdir(), "soksak-display-link-"));
  try {
    const frames = join(configDir, "logs", "captures", "capture-1");
    mkdirSync(frames, { recursive: true });
    writeFileSync(join(frames, "display-link.json"), JSON.stringify(record()));
    const stop = { frames, displayLink: join(frames, "display-link.json") };
    const saved = preserveDisplayLinkArtifact({ frames, stop, configDir });
    rmSync(frames, { recursive: true });
    assert.equal(saved.record.state, "available");
    assert.deepEqual(JSON.parse(readFileSync(saved.evidencePath, "utf8")), record());
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("capture stop error preserves an incomplete artifact when the host leaves it available", () => {
  const configDir = mkdtempSync(join(tmpdir(), "soksak-display-link-error-"));
  try {
    const frames = join(configDir, "logs", "captures", "capture-1");
    mkdirSync(frames, { recursive: true });
    const incomplete = record("incomplete");
    writeFileSync(join(frames, "display-link.json"), JSON.stringify(incomplete));
    const saved = preserveDisplayLinkArtifact({ frames, configDir, requireStopReply: false });
    rmSync(frames, { recursive: true });
    assert.equal(saved.record.state, "incomplete");
    assert.deepEqual(JSON.parse(readFileSync(saved.evidencePath, "utf8")), incomplete);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("capture stop rejects a display-link path outside its recording", () => {
  const configDir = mkdtempSync(join(tmpdir(), "soksak-display-link-path-"));
  try {
    const frames = join(configDir, "logs", "captures", "capture-1");
    mkdirSync(frames, { recursive: true });
    assert.throws(() => preserveDisplayLinkArtifact({ frames,
      stop: { frames, displayLink: join(configDir, "elsewhere.json") }, configDir }), /displayLink path must be/);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});
