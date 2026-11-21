import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

test("the settings dialog owns the existing toast until it closes", async (t) => {
  const markup = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const dom = new JSDOM(markup, { url: "http://localhost/" });
  const { window } = dom;
  const { document } = window;
  window.matchMedia = (query) => ({ media: query, matches: true, addEventListener() {}, removeEventListener() {} });
  Object.assign(globalThis, {
    window, document, CSS: { escape: (value) => value },
    getComputedStyle: window.getComputedStyle.bind(window),
    addEventListener: window.addEventListener.bind(window),
  });
  t.after(() => dom.window.close());
  const { rawConsole } = await import("../page-log.js");
  const records = t.mock.method(rawConsole, "error", () => {});
  const { installExposure, registry } = await import("../exposure.js");
  installExposure(JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")));
  const { installErrorExposure } = await import("../core-exposure.js");
  const errors = installErrorExposure();
  const { openSettings, closeSettings } = await import("../settings-ui.js");
  const message = "The workspace could not be saved";
  errors.show(message, "", "workspace");
  const toast = document.querySelector(".error-toast");
  const button = toast.querySelector("button");
  let dismissals = 0;
  registry.watch((name) => { if (name === "core.error.dismiss") dismissals++; });

  openSettings();
  assert.equal(document.querySelector("#settings[role=dialog] .error-toast"), toast);
  assert.equal(document.querySelectorAll(".error-toast__close").length, 1);
  button.focus();
  assert.equal(document.activeElement, button, "the error close control is focusable inside the dialog");

  closeSettings();
  assert.equal(document.querySelector("body > #errorToasts .error-toast"), toast);
  assert.equal(records.mock.callCount(), 1, "moving a toast records no new occurrence");

  openSettings();
  button.click();
  await registry.commandsEnded();
  assert.equal(document.querySelector(".error-toast"), null);
  assert.equal(dismissals, 1, "one press runs one declared dismissal");
  assert.equal(errors.text("workspace"), message, "dismissing the toast does not recover the workspace");
  closeSettings();
});
