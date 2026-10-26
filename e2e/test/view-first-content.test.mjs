import assert from "node:assert/strict";
import test from "node:test";
import { firstContentFrame } from "../view-first-content.mjs";

function recorded(times) {
  return times.map((time, frameIndex) => ({ time, frameIndex }));
}

test("first content selects the earliest recorded frame whose pixels contain the expected text", { timeout: 5000 }, async () => {
  const seen = [];
  const result = await firstContentFrame({
    captured: recorded([100, 116, 133, 150]),
    rect: { x: 0, y: 0, w: 20, h: 10 },
    expected: "SOKSAK EDITOR CONTENT",
    language: "en-US",
    recognizeFrame: async (frame, rect, language) => {
      assert.deepEqual(rect, { x: 0, y: 0, w: 20, h: 10 });
      assert.equal(language, "en-US");
      seen.push(frame.frameIndex);
      return { lines: frame.frameIndex < 2 ? ["loading"] : ["SOKSAK EDITOR CONTENT"] };
    },
  });

  assert.deepEqual(seen, [0, 1, 2], "the scanner stopped at the earliest matching frame");
  assert.deepEqual(result, {
    frameIndex: 2,
    frameCount: 4,
    timeMs: 133,
    proof: { expected: "SOKSAK EDITOR CONTENT", actual: "SOKSAK EDITOR CONTENT", lines: ["SOKSAK EDITOR CONTENT"] },
  });
});

test("first content rejects recordings whose pixels never contain the expected text", { timeout: 5000 }, async () => {
  await assert.rejects(firstContentFrame({
    captured: recorded([100, 116]),
    rect: { x: 0, y: 0, w: 20, h: 10 },
    expected: "SOKSAK EDITOR CONTENT",
    language: "en-US",
    recognizeFrame: async () => ({ lines: ["loading", "empty"] }),
  }), /no recorded frame contains expected content.*SOKSAK EDITOR CONTENT.*frame 0.*frame 1/s);
});

test("first content rejects missing, non-finite or out-of-order frame times", { timeout: 5000 }, async () => {
  const options = {
    rect: { x: 0, y: 0, w: 20, h: 10 },
    expected: "marker",
    language: "en-US",
    recognizeFrame: async () => ({ lines: ["marker"] }),
  };
  await assert.rejects(firstContentFrame({ ...options, captured: [] }), /requires at least one decoded frame/);
  await assert.rejects(firstContentFrame({ ...options, captured: [{ time: Number.NaN }] }), /frame 0.*finite display time/);
  await assert.rejects(firstContentFrame({ ...options, captured: recorded([100, 100]) }), /frame times are not strictly increasing/);
});
