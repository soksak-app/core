import assert from "node:assert/strict";
import test from "node:test";
import { loadTerminalReferenceFixture } from "./terminal-reference-fixture.mjs";

// Actual committed recordings are mandatory on every platform; missing data fails.
const options = { timeout: 10000 };
async function acquire(value) {
  const { acquireTerminalReference } = await import("../terminal-reference-acquisition.mjs");
  return acquireTerminalReference(value);
}
test("actual screen.observe acquisition yields a verified complete reference with global geometry", options, async t => {
  const value = loadTerminalReferenceFixture(t);
  const result = await acquire(value);
  assert.deepEqual(result.screen.frame, value.evidence.observed.frame);
  assert.deepEqual(result.screen.rows, value.evidence.observed.rows);
  assert.deepEqual(result.source.render, value.evidence.observed.render);
  assert.equal(result.expected.text, "sh-3.2$");
  assert.equal(result.expected.startColumn, 0);
  const native = value.evidence.host.regions.find(region => region.surface === value.evidence.terminal.surface && region.name === "view");
  const global = { ...native.frame, x: native.frame.x + value.evidence.host.frame.x,
    y: native.frame.y + value.evidence.host.frame.y };
  assert.deepEqual(result.region.rectPt, global);
  assert.deepEqual(result.region.clipRectPt, global);
  assert.deepEqual(result.source.raster.screenBounds, global);
  assert.equal(result.identityRow.status, "matched");
  assert.equal(result.proof, "verified-terminal-reference-acquisition");
  assert.equal(Object.hasOwn(result, "frameIndex"), false, "reference acquisition must not invent earlier-frame proof");
});

const invalid = [
  ["missing renderer metadata", x => { x.evidence.observed.render = null; }],
  ["missing observed request ownership", x => { delete x.evidence.observed.requestId; }],
  ["semantic dimensions differ", x => { x.evidence.observed.columnCount += 1; }],
  ["observed frame differs from retained source", x => { x.evidence.observed.frame.sequence += 1; }],
  ["ambiguous issued artifact", x => { x.identityManifest.artifacts.push(structuredClone(x.identityManifest.artifacts[0])); }],
  ["issued region has no decoded identity", x => { x.identityManifest.artifacts[0].regionToken = "another-region"; }],
  ["ambiguous native region", x => { x.evidence.host.regions.push(structuredClone(x.evidence.host.regions[0])); }],
  ["native placement differs from retained global source", x => { x.evidence.host.frame.x += 1; }],
  ["no matched decoded identity", x => { for (const row of x.decodedRows) row.status = "unmatched"; }],
  ["ambiguous decoded frame join", x => { x.decodedRows.push(structuredClone(x.decodedRows[0])); }],
  ["decoded QR geometry differs", x => {
    const matched = x.decodedRows.filter(row => row.status === "matched" && row.identity && row.roi);
    assert.ok(matched.length > 0, "real fixture must contain a matched QR row");
    for (const row of matched) row.roi.x += 1;
  }],
  ["callback display time differs", x => { for (const row of x.callbacks) row.displayTime = "1"; }],
  ["ambiguous callback frame join", x => { x.callbacks.push(structuredClone(x.callbacks[0])); }],
  ["issued artifact digest differs", x => { x.identityManifest.artifacts[0].sha256 = "0".repeat(64); }],
];
for (const [name, mutate] of invalid) {
  test(`real reference acquisition refuses ${name}`, options, async t => {
    const value = loadTerminalReferenceFixture(t);
    mutate(value);
    await assert.rejects(() => acquire(value), error => error.code !== "ERR_MODULE_NOT_FOUND" &&
      /reference|observe|request|render|frame|region|source|artifact|identity|geometry|dimension|callback|digest|QR|join/i.test(error.message));
  });
}

test("actual term alias screen.observe acquisition yields a verified complete reference", options, async t => {
  const value = loadTerminalReferenceFixture(t, "term-positive");
  const result = await acquire(value);
  assert.deepEqual(result.screen.frame, value.evidence.observed.frame);
  assert.deepEqual(result.screen.rows, value.evidence.observed.rows);
  assert.equal(result.proof, "verified-terminal-reference-acquisition");
});

for (const name of ["terminal-missing-metadata", "terminal-painted-missing-metadata"]) {
  test(`old wire acquisition without atomic renderer metadata is refused: ${name}`, options, async t => {
    await assert.rejects(() => acquire(loadTerminalReferenceFixture(t, name)), error => error.code !== "ERR_MODULE_NOT_FOUND" &&
      /observe|reference|render|metadata/i.test(error.message));
  });
}

test("actual pre-F698 source-history color corruption cannot become a positive reference", options, async t => {
  await assert.rejects(() => acquire(loadTerminalReferenceFixture(t, "terminal-bad-color")), error => error.code !== "ERR_MODULE_NOT_FOUND" &&
    /reference|pixel|glyph|color|raster/i.test(error.message));
});
