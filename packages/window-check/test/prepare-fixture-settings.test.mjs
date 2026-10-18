// The preparation of a window check changes settings of the check application, and the application keeps the values
// that it had before the check (F129): a person who uses the check application afterwards finds it as it was.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { prepareFixture, Session } from "../app.mjs";

/**
 * A client that answers what prepareFixture asks and keeps the settings that the requests change. Like the host, it writes the
 * policy of the setting diagnostics.log to the policy file of its configuration folder.
 */
function fixture(settings) {
  const configDir = mkdtempSync(join(tmpdir(), "soksak-prepare-"));
  test.after(() => rmSync(configDir, { recursive: true }));
  const levels = ["lifecycle", "input", "call", "io", "frame"];
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
      if (method === "diagnostics.fixture") {
        Object.assign(settings, params.settings);
        const classes = Object.fromEntries(levels.map((kind) => [kind, params.settings["diagnostics.log"][kind] ?? "error"]));
        writeFileSync(join(configDir, "log-policy.json"), JSON.stringify({ schema: 1, classes }));
      }
      return null;
    },
  };
  return new Session({ name: "wailsv3", configDir }, client);
}

test("the preparation of a check restores the settings that it changed when the check ends", async () => {
  const settings = { "diagnostics.performance": true, "diagnostics.log": { call: "info" }, theme: "dark" };
  const session = fixture(settings);
  await prepareFixture(session, { settings: { theme: "light" }, performanceTrace: false });
  assert.deepEqual(settings, { "diagnostics.performance": false, "diagnostics.log": {}, theme: "light" }, "the preparation did not change the settings");
  for (const clean of session.cleanups.reverse()) await clean();
  assert.deepEqual(settings, { "diagnostics.performance": true, "diagnostics.log": { call: "info" }, theme: "dark" });
});

// F192.3-2: a check declares the log policy it needs and the records it reads; a declaration whose policy does not store a
// record that the check reads fails before the preparation changes anything.
const CATALOG = { events: { "sidecar.vt.pty_read": { layer: "sidecar", class: "io", level: "debug" } } };

test("the preparation refuses a check that reads a record which its declared policy does not store", async () => {
  const settings = { theme: "dark" };
  const session = fixture(settings);
  await assert.rejects(prepareFixture(session, { log: { io: "info" }, reads: ["sidecar.vt.pty_read"], catalog: CATALOG, performanceTrace: false }),
    { message: "the check reads sidecar.vt.pty_read (class io, level debug), which the log policy " +
      '{"lifecycle":"error","input":"error","call":"error","io":"info","frame":"error"} of the declaration of the check does not store' });
  assert.deepEqual(settings, { theme: "dark" }, "the preparation changed the settings before it refused the declaration");
});

test("the preparation refuses the policy given as a setting instead of the declaration log", async () => {
  const session = fixture({});
  await assert.rejects(prepareFixture(session, { settings: { "diagnostics.log": { io: "trace" } }, performanceTrace: false }),
    { message: "prepareFixture: the check declares its log policy with log, not with the setting diagnostics.log" });
});

test("the preparation with the performance trace stores the class call at the level debug and waits for the policy file", async () => {
  const settings = { theme: "dark" };
  const session = fixture(settings);
  await prepareFixture(session, { log: { io: "debug" }, reads: ["sidecar.vt.pty_read"], catalog: CATALOG, performanceTrace: true });
  assert.deepEqual(settings["diagnostics.log"], { io: "debug", call: "debug" });
});
