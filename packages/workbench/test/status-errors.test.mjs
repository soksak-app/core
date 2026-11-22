// The errors of the card status row (docs/spec/plugins.md#tab-reports, docs/spec/exposure.md): the error of a stopped surface and the
// operation error of the active tab show their text in the error toast; the status row keeps only the state label of the surface.
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
// The error toast runs the declared command core.error.dismiss, so the page exposure is installed before a toast shows.
const { installExposure } = await import("../exposure.js");
const { default: exposureFile } = await import("../exposure.json", { with: { type: "json" } });
installExposure(exposureFile);

const LONG = "the save of the document failed because the folder is not writable ".repeat(8).trim();

test("an error of the status row shows its text in the toast and the row keeps a state label", { timeout: 5000 }, async () => {
  const dom = new JSDOM(`<section data-card-id="card-1"><footer class="status"></footer></section>`);
  globalThis.document = dom.window.document;
  const { setSurfaceStatus, setTabError } = await import("../surface-status.js?toast");
  const status = document.querySelector(".status");
  const toasts = () => [...document.querySelectorAll(".error-toast__text")].map((shown) => [shown.dataset.error, shown.textContent]);
  try {
    setSurfaceStatus(status, "tab-a", { phase: "error", error: LONG });
    const indicator = status.querySelector("[data-surface-status]");
    assert.deepEqual({ text: indicator.textContent, title: indicator.hasAttribute("title"), where: indicator.dataset.error },
      { text: "표면 오류", title: false, where: undefined }, "the status row holds the state label and no error text");
    assert.deepEqual(toasts(), [["surface status card-1 tab-a", `표면 오류 · ${LONG}`]], "the surface error shows in the toast");
    setSurfaceStatus(status, "tab-a", { phase: "loading" });
    assert.deepEqual(toasts(), [], "the next state withdraws the surface error");

    setTabError("tab-a", LONG);
    assert.equal(status.textContent.includes(LONG), false, "the status row holds no copy of the tab error");
    assert.deepEqual(toasts(), [["tab error tab-a", LONG]], "the tab error shows in the toast");
    setTabError("tab-a", null);
    assert.deepEqual(toasts(), [], "a removed tab error closes its toast");
  } finally {
    dom.window.close();
    delete globalThis.document;
  }
});
