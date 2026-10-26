import assert from "node:assert/strict";
import test from "node:test";
import { firstContentFrame, firstDifferentContentFrame } from "../view-first-content.mjs";

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

test("first content starts only after the OCR-proven anchor frame in the same recording", { timeout: 5000 }, async () => {
  const seen = [];
  const result = await firstContentFrame({
    captured: recorded([0.5, 5.5, 6.1, 10]),
    startFrameIndex: 2,
    rect: { x: 0, y: 0, w: 20, h: 10 },
    expected: "SOKSAK EDITOR CONTENT",
    language: "en-US",
    recognizeFrame: async (frame) => {
      seen.push(frame.time);
      return { lines: [frame.time === 10 ? "SOKSAK EDITOR CONTENT" : "different anchor"] };
    },
  });
  assert.deepEqual(seen, [6.1, 10], "the target OCR scanned old pixels or the anchor boundary frame");
  assert.deepEqual(result, {
    frameIndex: 3,
    frameCount: 4,
    timeMs: 10,
    proof: { expected: "SOKSAK EDITOR CONTENT", actual: "SOKSAK EDITOR CONTENT", lines: ["SOKSAK EDITOR CONTENT"] },
  });
  await assert.rejects(firstContentFrame({
    captured: recorded([10]), startFrameIndex: 1,
    rect: { x: 0, y: 0, w: 20, h: 10 }, expected: "marker", language: "en-US",
    recognizeFrame: async () => ({ lines: ["marker"] }),
  }), /start frame 1 is outside the recorded frames/);
});

test("one phase proof accepts an anchor transition before or after the process request", { timeout: 5000 }, async () => {
  const cases = [
    { name: "anchor before request", times: [0.5, 5.5, 10], anchorTime: 5.5, requestAt: 6 },
    { name: "anchor after request", times: [0.5, 5.5, 6.1, 7.1, 10], anchorTime: 7.1, requestAt: 6 },
  ];
  for (const scenario of cases) {
    const captured = recorded(scenario.times);
    const anchor = await firstDifferentContentFrame({
      captured,
      rect: { x: 0, y: 0, w: 20, h: 10 },
      expected: "SOKSAK EDITOR CONTENT",
      language: "en-US",
      recognizeFrame: async (frame) => ({ lines: [frame.time === scenario.anchorTime
        ? "different anchor" : "SOKSAK EDITOR CONTENT"] }),
    });
    const targetSeen = [];
    const target = await firstContentFrame({
      captured,
      startFrameIndex: anchor.frameIndex + 1,
      rect: { x: 0, y: 0, w: 20, h: 10 },
      expected: "SOKSAK EDITOR CONTENT",
      language: "en-US",
      recognizeFrame: async (frame) => {
        targetSeen.push(frame.time);
        return { lines: [frame.time === 10 ? "SOKSAK EDITOR CONTENT" : "different anchor"] };
      },
    });
    assert.equal(anchor.timeMs, scenario.anchorTime, `${scenario.name}: chose the wrong physical anchor frame`);
    assert.equal(anchor.timeMs < scenario.requestAt, scenario.name === "anchor before request",
      `${scenario.name}: request event and capture frame order changed`);
    assert.equal(target.frameIndex, captured.length - 1, `${scenario.name}: accepted content before the target frame`);
    assert.ok(target.frameIndex > anchor.frameIndex, `${scenario.name}: target preceded the anchor transition`);
    assert.ok(Number.isFinite(scenario.requestAt), `${scenario.name}: request timestamp was lost`);
    assert.deepEqual(targetSeen, scenario.times.slice(anchor.frameIndex + 1),
      `${scenario.name}: target OCR did not begin strictly after the anchor frame`);
    assert.deepEqual(captured.map((frame) => frame.time), scenario.times,
      `${scenario.name}: the original capture timestamps changed`);
  }
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

test("anchor proof requires actual nonempty pixels that differ from target content", { timeout: 5000 }, async () => {
  const seen = [];
  const result = await firstDifferentContentFrame({
    captured: recorded([100, 116, 133]),
    rect: { x: 0, y: 0, w: 20, h: 10 },
    expected: "SOKSAK EDITOR CONTENT",
    language: "en-US",
    recognizeFrame: async (frame) => {
      seen.push(frame.time);
      return { lines: [frame.time === 133 ? "SOKSAK EDITOR CONTENT" : "Different page content"] };
    },
  });
  assert.deepEqual(seen, [100]);
  assert.deepEqual(result, {
    frameIndex: 0,
    frameCount: 3,
    timeMs: 100,
    proof: { targetAbsent: "SOKSAK EDITOR CONTENT", actual: "Different page content", lines: ["Different page content"] },
  });
  const boundary = await firstDifferentContentFrame({
    captured: recorded([0.5, 5.5, 6.1]),
    rect: { x: 0, y: 0, w: 20, h: 10 },
    expected: "SOKSAK EDITOR CONTENT",
    language: "en-US",
    recognizeFrame: async (frame) => {
      seen.push(frame.time);
      return { lines: [frame.time === 0.5 ? "SOKSAK EDITOR CONTENT" : "Different page content"] };
    },
  });
  assert.deepEqual(boundary, {
    frameIndex: 1,
    frameCount: 3,
    timeMs: 5.5,
    proof: { targetAbsent: "SOKSAK EDITOR CONTENT", actual: "Different page content", lines: ["Different page content"] },
  });
  assert.deepEqual(seen, [100, 0.5, 5.5], "anchor proof must observe pixels without a callback-time cutoff");
  await assert.rejects(firstDifferentContentFrame({
    captured: recorded([100, 116]),
    rect: { x: 0, y: 0, w: 20, h: 10 },
    expected: "SOKSAK EDITOR CONTENT",
    language: "en-US",
    recognizeFrame: async () => ({ lines: ["SOKSAK EDITOR CONTENT"] }),
  }), /no recorded frame shows nonempty content different/s);
  await assert.rejects(firstDifferentContentFrame({
    captured: recorded([100]),
    rect: { x: 0, y: 0, w: 20, h: 10 },
    expected: "SOKSAK EDITOR CONTENT",
    language: "en-US",
    recognizeFrame: async () => ({ lines: [] }),
  }), /no recorded frame shows nonempty content different/s);
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
