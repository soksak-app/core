import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRecordingFixture } from "./recording-fixture.mjs";

export const TERMINAL_REFERENCE_FIXTURES = Object.freeze([
  "terminal-positive", "term-positive", "terminal-bad-color",
  "terminal-missing-metadata", "terminal-painted-missing-metadata",
]);
const json = path => JSON.parse(readFileSync(path, "utf8"));
const rows = path => readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);

/** Extracts a declared actual recording; the test context owns its native files. */
export function loadTerminalReferenceFixture(t, name = "terminal-positive") {
  if (!TERMINAL_REFERENCE_FIXTURES.includes(name)) throw new Error(`unknown terminal recording fixture: ${name}`);
  const fixtureDirectory = fileURLToPath(new URL(`./fixtures/terminal-reference/${name}/`, import.meta.url));
  const recording = loadRecordingFixture({ fixtureDirectory });
  t.after(recording.dispose);
  const captureDirectory = join(recording.directory, "capture");
  const evidence = json(join(recording.directory, "evidence.json"));
  // Relocate only the declared replay input. The preserved evidence.json and
  // committed provenance retain every original acquisition path unchanged.
  evidence.capture = { ...evidence.capture, frames: captureDirectory,
    callbackStatus: join(captureDirectory, "callback-status.jsonl"),
    displayLink: join(captureDirectory, "display-link.json"),
    frameIdentity: { ...evidence.capture.frameIdentity,
      manifest: join(captureDirectory, "frame-identities", "manifest.json") } };
  return {
    evidence, captureDirectory,
    identityManifest: json(join(captureDirectory, "frame-identities", "manifest.json")),
    decodedRows: rows(join(captureDirectory, "frame-identities", "decoded-frames.jsonl")),
    callbacks: rows(join(captureDirectory, "callback-status.jsonl")),
    expected: { text: "sh-3.2$", row: 0, startColumn: 0,
      guards: [{ row: 0, edge: "left", column: 0 }, { row: 0, column: 7 }] },
    criteria: { colorDistance: 32, minimumGlyphPixels: 1, minimumUnderlineCoverage: 0.75 },
  };
}
