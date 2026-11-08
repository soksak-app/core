// The capture identity checks decode identity codes from captured pixels. The check windows overlap, and the window of the
// centred application is covered whole (uncoverFromCheckWindows in e2e/fixture.mjs); a covered window presents its documents
// less often, so these checks uncover their window before they start the recording.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/** The checks that decode identity codes in captured pixels, each with the text of its recording start. */
const DECODING_CHECKS = [
  { file: "capture-document-frame-identity.test.mjs", record: "await s.record({ frameIdentity: true })" },
  { file: "capture-frame-identity.test.mjs", record: "await s.record({ frameIdentity: true })" },
];

test("a check that decodes identity codes in captured pixels uncovers its window before it records", () => {
  for (const { file, record } of DECODING_CHECKS) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    const recording = source.indexOf(record);
    assert.ok(recording > 0, `${file} starts no frame identity recording`);
    const uncovering = source.lastIndexOf("await uncoverFromCheckWindows(t, s);", recording);
    const opening = source.lastIndexOf("const s = await open(t, app);", recording);
    assert.ok(uncovering > opening && opening >= 0, `${file} records frame identity in a window that it did not uncover`);
  }
});
