import assert from "node:assert/strict";
import test from "node:test";

import { assertBrowserFrameMatchesSlot, browserViewDescriptor } from "../benchmark/cases/browser.mjs";

test("browser pixel geometry matches the independently declared document slot", { timeout: 5000 }, () => {
  const geometry = { cardRectPt: { left: 0, top: 0, right: 100, bottom: 100 },
    nativeRectPt: { left: 4, top: 8, right: 96, bottom: 92 } };
  const slotInsetsPt = { left: 4, top: 8, right: 4, bottom: 8 };
  assert.equal(assertBrowserFrameMatchesSlot(geometry, slotInsetsPt), 0);
  assert.throws(() => assertBrowserFrameMatchesSlot({ ...geometry,
    nativeRectPt: { ...geometry.nativeRectPt, right: 93 } }, slotInsetsPt), /3 pt/);
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
  };
  assert.equal(browserViewDescriptor.plugin, "browser");
  assert.equal(browserViewDescriptor.expectedContent, "주소를 입력하세요");
  assert.equal(browserViewDescriptor.language, "ko-KR");
  assert.deepEqual(await browserViewDescriptor.readiness(s, "browser-1"), {
    historyEntries: 1,
    location: { url: "", loading: false, error: null, canGoBack: false, canGoForward: false },
  });
  assert.deepEqual(calls, [
    { name: "browser.location", message: "browser view browser-1 did not reach its initial empty state",
      options: { surface: "browser-1" } },
    { name: "browser.empty", index: undefined, surface: "browser-1" },
  ]);
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
