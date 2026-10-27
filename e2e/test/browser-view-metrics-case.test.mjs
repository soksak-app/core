import assert from "node:assert/strict";
import test from "node:test";

import { assertBrowserFrameMatchesSlot, BROWSER_FIXTURE_CONTENT_COLOR, browserDragTailGeometryFrame,
  browserViewDescriptor, measureBrowserFrameGeometry } from "../benchmark/cases/browser.mjs";

test("browser pixel geometry matches the independently declared document slot", { timeout: 5000 }, () => {
  const geometry = { cardRectPt: { left: 0, top: 0, right: 100, bottom: 100 },
    nativeRectPt: { left: 4, top: 8, right: 96, bottom: 92 } };
  const slotInsetsPt = { left: 4, top: 8, right: 4, bottom: 8 };
  assert.equal(assertBrowserFrameMatchesSlot(geometry, slotInsetsPt), 0);
  assert.throws(() => assertBrowserFrameMatchesSlot({ ...geometry,
    nativeRectPt: { ...geometry.nativeRectPt, right: 93 } }, slotInsetsPt), /3 pt/);
});

test("browser fixture color does not include unrelated chrome pixels in the document bounds", { timeout: 5000 }, () => {
  const frame = { width: 300, height: 240, stride: 300 * 4, scale: 1, contentScale: 1,
    content: { x: 0, y: 0, width: 300, height: 240 }, time: 1,
    data: Buffer.alloc(300 * 240 * 4) };
  const set = (x, y, color) => {
    const offset = y * frame.stride + x * 4;
    frame.data[offset] = color[2];
    frame.data[offset + 1] = color[1];
    frame.data[offset + 2] = color[0];
    frame.data[offset + 3] = 255;
  };
  const plane = [16, 17, 23], card = [25, 27, 36], chrome = [32, 28, 30];
  for (let y = 30; y < 210; y++) {
    for (let x = 40; x < 260; x++) set(x, y, card);
  }
  for (let y = 60; y < 190; y++) {
    for (let x = 50; x < 250; x++) set(x, y, BROWSER_FIXTURE_CONTENT_COLOR);
  }
  for (const [x, y] of [[55, 35], [245, 205]]) set(x, y, chrome);
  for (let y = 0; y < frame.height; y++) {
    for (let x = 0; x < frame.width; x++) {
      if ((x >= 40 && x < 260) && (y >= 30 && y < 210)) continue;
      set(x, y, plane);
    }
  }

  const geometry = measureBrowserFrameGeometry(frame, { cornerRadiusPt: 0,
    targetRect: { x: 150, y: 120, width: 1, height: 1 } });
  assert.equal(assertBrowserFrameMatchesSlot(geometry,
    { left: 10, top: 30, right: 10, bottom: 20 }), 0);
  assert.deepEqual(browserDragTailGeometryFrame(3, { ...geometry, timeMs: frame.time },
    { left: 10, top: 30, right: 10, bottom: 20 }), {
    frameIndex: 3, timeMs: frame.time,
    cardRectPt: geometry.cardRectPt, nativeRectPt: geometry.nativeRectPt, contentRectPt: geometry.nativeRectPt,
    slotInsetsPt: { left: 10, top: 30, right: 10, bottom: 20 },
    contentInsetsPt: { left: 0, top: 0, right: 0, bottom: 0 },
  }, "the post-gesture row retains measured source pixels from that exact capture frame");
});

test("browser metrics descriptor waits for the initial empty state and its visible content area", { timeout: 5000 }, async () => {
  const calls = [];
  const s = {
    async until(name, predicate, message, options) {
      calls.push({ name, message, options });
      const location = { url: "", loading: false, error: null, canGoBack: false, canGoForward: false };
      assert.ok(predicate(location));
      return location;
    },
    async rect(name, index, surface) {
      calls.push({ name, index, surface });
      return { width: 480, height: 280 };
    },
    async run(name, params, surface) {
      calls.push({ name, params, surface });
      return { historyEntries: 1, regionHistoryEntries: 0 };
    },
  };
  assert.equal(browserViewDescriptor.plugin, "browser");
  assert.equal(browserViewDescriptor.expectedContent, "주소를 입력하세요");
  assert.equal(browserViewDescriptor.language, "ko-KR");
  assert.equal(browserViewDescriptor.readinessStatus, "browser.location");
  assert.deepEqual(await browserViewDescriptor.readiness(s, "browser-1"), {
    historyEntries: 1,
    regionHistoryEntries: 0,
    location: { url: "", loading: false, error: null, canGoBack: false, canGoForward: false },
  });
  assert.deepEqual(calls, [
    { name: "browser.location", message: "browser view browser-1 did not reach its initial empty state",
      options: { surface: "browser-1" } },
    { name: "browser.empty", index: undefined, surface: "browser-1" },
    { name: "browser.view.measure", params: { action: "read" }, surface: "browser-1" },
  ]);
});

test("browser readiness rejects actual view history beyond the initial entry", { timeout: 5000 }, async () => {
  const s = {
    async until(_name, predicate) {
      const location = { url: "", loading: false, error: null, canGoBack: false, canGoForward: false };
      assert.ok(predicate(location));
      return location;
    },
    async rect() { return { width: 480, height: 280 }; },
    async run(name, params, surface) {
      assert.equal(name, "browser.view.measure");
      assert.deepEqual(params, { action: "read" });
      assert.equal(surface, "browser-3");
      return { historyEntries: 2, regionHistoryEntries: 0 };
    },
  };
  await assert.rejects(browserViewDescriptor.readiness(s, "browser-3"), /actual browser view history/);
});

test("browser metrics readiness rejects a missing empty-state area", { timeout: 5000 }, async () => {
  const s = {
    async until(_name, predicate) {
      const location = { url: "", loading: false, error: null, canGoBack: false, canGoForward: false };
      assert.ok(predicate(location));
      return location;
    },
    async rect() { return { width: 0, height: 280 }; },
  };
  await assert.rejects(browserViewDescriptor.readiness(s, "browser-2"), /no visible empty-state content region/);
});

test("browser diagnostic callbacks use the declared measurement actions", { timeout: 5000 }, async () => {
  const calls = [];
  const s = { async run(name, params, surface) {
    calls.push({ name, params, surface });
    return params.action === "read" ? { historyEntries: 1, regionHistoryEntries: 1, width: 300, height: 200 }
      : { enabled: params.action === "start", sequence: 1 };
  } };
  assert.deepEqual(await browserViewDescriptor.startContentTrace(s, "browser-1"), { enabled: true, sequence: 1 });
  assert.deepEqual(await browserViewDescriptor.stopContentTrace(s, "browser-1"), {
    historyEntries: 1, regionHistoryEntries: 1, width: 300, height: 200,
  });
  assert.deepEqual(await browserViewDescriptor.readDocument(s, "browser-1"), {
    historyEntries: 1, regionHistoryEntries: 1, width: 300, height: 200,
  });
  assert.deepEqual(calls, [
    { name: "browser.view.measure", params: { action: "start" }, surface: "browser-1" },
    { name: "browser.view.measure", params: { action: "stop" }, surface: "browser-1" },
    { name: "browser.view.measure", params: { action: "read" }, surface: "browser-1" },
    { name: "browser.view.measure", params: { action: "read" }, surface: "browser-1" },
  ]);
});
