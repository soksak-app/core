// The failures of the update at start that the host keeps reach the error display of the window when the window reads the plugin
// state (docs/spec/installation.md#update-at-start).
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";
import { installExposure } from "../exposure.js";
import exposureFile from "../exposure.json" with { type: "json" };

installExposure(exposureFile);

test("a failure of the update at start that pluginsState reports is shown through the error display", { timeout: 5000 }, async () => {
  // The case selects the host of the page before the module below is imported, because the page reads the host when it is imported.
  const wire = selectPageWire("plugin-operations-start-update-failed");
  const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  const { followPluginChanges, pluginOperations } = await import("../installed-plugins.js");
  const following = followPluginChanges(async () => {});
  await following;
  assert.deepEqual(pluginOperations.startFailures(), [
    { where: "plugin update probe", text: "section browser.dom status is removed" },
  ], "the page did not keep the failure of the update at start");
  const toast = document.querySelector(".error-toast__text")?.textContent ?? null;
  assert.equal(toast, "section browser.dom status is removed", "the failure of the update at start was not shown through the error display");
  wire.finish();
});
