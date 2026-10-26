// Finds the first recorded view frame whose decoded pixels contain declared plugin content.
import assert from "node:assert/strict";
import { normalizeViewText, recognizeViewFrame } from "./view-content.mjs";

/** Returns the earliest timestamped frame whose pixels contain expected text, with OCR proof for that frame. */
export async function firstContentFrame({ captured, rect, expected, language, directory, recognizeFrame }) {
  assert.ok(Array.isArray(captured) && captured.length > 0, "first content requires at least one decoded frame");
  assert.ok(rect && [rect.x, rect.y, rect.w, rect.h].every(Number.isFinite)
    && rect.w > 0 && rect.h > 0, "first content requires a non-empty captured region");
  assert.ok(typeof expected === "string" && normalizeViewText(expected).length > 0,
    "first content requires non-empty expected text");
  assert.ok(typeof language === "string" && language.length > 0, "first content requires a recognition language");
  assert.ok(recognizeFrame === undefined || typeof recognizeFrame === "function",
    "first content recognizer must be a function");
  if (!recognizeFrame) {
    assert.ok(typeof directory === "string" && directory.length > 0,
      "first content requires the recording directory for OCR artifacts");
  }

  let previousTime = -Infinity;
  for (let frameIndex = 0; frameIndex < captured.length; frameIndex++) {
    const time = captured[frameIndex]?.time;
    assert.ok(Number.isFinite(time) && time >= 0,
      `first content frame ${frameIndex} has no finite display time`);
    assert.ok(time > previousTime, "first content frame times are not strictly increasing");
    previousTime = time;
  }

  const observations = [];
  for (let frameIndex = 0; frameIndex < captured.length; frameIndex++) {
    const frame = captured[frameIndex];
    const recognized = recognizeFrame
      ? await recognizeFrame(frame, rect, language, frameIndex)
      : await recognizeViewFrame({ frame, rect, language, directory,
        artifactName: `view-first-content-frame-${String(frameIndex).padStart(6, "0")}` });
    const lines = recognized?.lines;
    assert.ok(Array.isArray(lines) && lines.every(line => typeof line === "string"),
      `first content recognizer returned invalid OCR lines for frame ${frameIndex}`);
    const actual = lines.join(" ");
    observations.push(`frame ${frameIndex} at ${frame.time}ms: ${JSON.stringify(actual)}`);
    if (normalizeViewText(actual).includes(normalizeViewText(expected))) {
      return { frameIndex, frameCount: captured.length, timeMs: frame.time, proof: { expected, actual, lines } };
    }
  }

  throw new Error(`no recorded frame contains expected content ${JSON.stringify(expected)}; ${observations.join("; ")}`);
}
