// Checks that the error of a view that stopped its restarts is shown on its card through the error display, and that it is cleared when the
// card is shown again (docs/spec/native-surfaces.md#view-surfaces). The host report is a fake, so the test runs without a host.
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { viewStopState } from "../view-calls.js";

const REASON = "the view failed 4 times within 300 seconds and is created again when its tab is reopened";

test("the stop of a view shows its reason on the card and the reopened card clears it", async (t) => {
  const reports = [];
  t.mock.module("../host.js", { namedExports: { report: (line) => reports.push(line) } });
  const dom = new JSDOM(`<section data-card-id="card-1"><div data-native-surface-id="probe-surface"></div><footer class="status"></footer></section>`);
  globalThis.document = dom.window.document;
  const { setSurfaceStatus } = await import("../surface-status.js?display");
  const status = document.querySelector(".status");
  try {
    setSurfaceStatus(status, { phase: "loading" });
    setSurfaceStatus(status, viewStopState({ surface: "probe-surface", plugin: "probe", reason: REASON }));
    const indicator = status.querySelector("[data-surface-status]");
    assert.equal(status.dataset.surfaceStatus, "error");
    assert.equal(indicator.hidden, false, "the error is visible on the card");
    assert.match(indicator.textContent, /the view failed 4 times within 300 seconds/);
    assert.equal(indicator.dataset.error, "surface status card-1 probe-surface", "the error uses the display path of its card");
    assert.deepEqual(reports, ["surface status card-1 probe-surface: 표면 오류 · " + REASON]);

    setSurfaceStatus(status, { phase: "loading" });
    assert.equal(indicator.dataset.error, undefined, "showing the card again clears the error");
    assert.equal(indicator.textContent, "불러오는 중");
  } finally {
    dom.window.close();
  }
});
