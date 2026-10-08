// The preparation of a window check changes settings of the check application, and the application keeps the values
// that it had before the check (F129): a person who uses the check application afterwards finds it as it was.
import assert from "node:assert/strict";
import test from "node:test";

import { prepareFixture, Session } from "../app.mjs";

/** A client that answers what prepareFixture asks and keeps the settings that the requests change. */
function fixture(settings) {
  const statuses = {
    "host.windows": [{ window: "main", ready: true }],
    "host.window": { content: { width: 1200, height: 760 }, frame: { x: 0, y: 0, width: 1200, height: 760 } },
    "host.screens": [{ visible: { x: 0, y: 0, width: 2000, height: 1200 } }],
    "core.window.document": { timeOrigin: 2, readyState: "complete" },
    "core.verify": { rows: [] },
  };
  const read = (name) => (name === "core.settings" ? { values: { ...settings } } : statuses[name]);
  const client = {
    endpoint: { pid: 1 },
    on: () => () => {},
    watch: async (window, name) => read(name),
    request: async (method, params) => {
      if (method === "status.get") return read(params.name);
      if (method === "command.run" && params.name === "core.settings.set") Object.assign(settings, params.params.patch);
      if (method === "diagnostics.fixture") Object.assign(settings, params.settings);
      return null;
    },
  };
  return new Session({ name: "wailsv3" }, client);
}

test("the preparation of a check restores the settings that it changed when the check ends", async () => {
  const settings = { "diagnostics.performance": true, theme: "dark" };
  const session = fixture(settings);
  await prepareFixture(session, { settings: { theme: "light" }, performanceTrace: false });
  assert.deepEqual(settings, { "diagnostics.performance": false, theme: "light" }, "the preparation did not change the settings");
  for (const clean of session.cleanups.reverse()) await clean();
  assert.deepEqual(settings, { "diagnostics.performance": true, theme: "dark" });
});
