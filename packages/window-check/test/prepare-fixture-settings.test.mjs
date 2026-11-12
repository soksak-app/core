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
  const reloads = [];
  const statuses = {
    "host.windows": [{ window: "main", ready: true }],
    "host.window": { content: { width: 1200, height: 760 }, frame: { x: 0, y: 0, width: 1200, height: 760 } },
    "host.screens": [{ visible: { x: 0, y: 0, width: 2000, height: 1200 } }],
    "core.window.workbench": { start: "start-1", startedAt: 2, readyState: "complete" },
    "core.verify": { rows: [] },
  };
  // The application selects no project, so the common values are the effective values.
  const read = (name) => (name === "core.settings" ? { values: { ...settings }, common: { ...settings } } : statuses[name]);
  const client = {
    endpoint: { pid: 1 },
    on: () => () => {},
    // A watch answers the current value when it satisfies the predicate; a value that does not is an error, because
    // nothing in the fixture changes it later.
    watch: async (window, name, predicate) => {
      const value = read(name);
      if (predicate && !predicate(value)) throw new Error(`the fixture value of ${name} does not satisfy the wait: ${JSON.stringify(value)}`);
      return value;
    },
    request: async (method, params) => {
      if (method === "status.get") return read(params.name);
      // The reload starts the workbench again: a new start in the same page process.
      if (method === "command.run" && params.name === "host.window.reload") {
        reloads.push(statuses["core.window.workbench"].start);
        statuses["core.window.workbench"] = { start: `start-${reloads.length + 1}`, startedAt: 2 + reloads.length, readyState: "complete" };
      }
      if (method === "command.run" && params.name === "core.settings.set") Object.assign(settings, params.params.patch);
      // host.window.presented answers the display time of the screen that shows the current layout.
      if (method === "command.run" && params.name === "host.window.presented") return { displayed: 16 };
      if (method === "diagnostics.fixture") {
        Object.assign(settings, params.settings);
        const classes = Object.fromEntries(levels.map((kind) => [kind, params.settings["diagnostics.log"][kind] ?? "error"]));
        writeFileSync(join(configDir, "log-policy.json"), JSON.stringify({ schema: 1, classes }));
      }
      return null;
    },
  };
  const session = new Session({ name: "wailsv3", configDir }, client);
  session.reloads = reloads;
  return session;
}

test("the preparation of a check restores the settings that it changed when the check ends", async () => {
  const settings = { "diagnostics.performance": true, "diagnostics.log": { call: "info" }, theme: "dark" };
  const session = fixture(settings);
  await prepareFixture(session, { settings: { theme: "light" }, performanceTrace: false });
  assert.deepEqual(settings, { "diagnostics.performance": false, "diagnostics.log": { lifecycle: "info" }, theme: "light" }, "the preparation did not change the settings");
  for (const clean of session.cleanups.reverse()) await clean();
  assert.deepEqual(settings, { "diagnostics.performance": true, "diagnostics.log": { call: "info" }, theme: "dark" });
});

test("the preparation reloads the workbench and waits for a new start of core.window.workbench", async () => {
  const session = fixture({});
  await prepareFixture(session, { performanceTrace: false });
  assert.deepEqual(session.reloads, ["start-1"], "the preparation did not reload the workbench once");
  assert.equal((await session.get("core.window.workbench")).start, "start-2");
});

// F192.3-2: a check declares the log policy it needs and the records it reads; a declaration whose policy does not store a
// record that the check reads fails before the preparation changes anything.
const CATALOG = { events: { "sidecar.vt.pty_read": { layer: "sidecar", class: "io", level: "debug" } } };

test("the preparation refuses a check that reads a record which its declared policy does not store", async () => {
  const settings = { theme: "dark" };
  const session = fixture(settings);
  await assert.rejects(prepareFixture(session, { log: { io: "info" }, reads: ["sidecar.vt.pty_read"], catalog: CATALOG, performanceTrace: false }),
    { message: "the check reads sidecar.vt.pty_read (class io, level debug), which the log policy " +
      '{"lifecycle":"info","input":"error","call":"error","io":"info","frame":"error"} of the declaration of the check does not store' });
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
  assert.deepEqual(settings["diagnostics.log"], { io: "debug", call: "debug", lifecycle: "info" });
});

// A failed check keeps the lifecycle of its processes: the sidecars write the open and the close of each session in the class
// lifecycle at the level info, and without them a session that a view lost leaves no record of who closed it.
test("the preparation stores the class lifecycle at least at the level info whatever the check declares", async () => {
  const settings = {};
  const session = fixture(settings);
  await prepareFixture(session, { performanceTrace: false });
  assert.deepEqual(settings["diagnostics.log"], { lifecycle: "info" }, "a check without a declaration stores no lifecycle below error");
  await prepareFixture(session, { log: { lifecycle: "debug" }, performanceTrace: false });
  assert.deepEqual(settings["diagnostics.log"], { lifecycle: "debug" }, "the preparation narrowed the lifecycle that the check declared");
});

// A measurement is valid only under the policy that it declares (docs/spec/hosts.md: G8 runs under the default policy), and the
// policy has one level per class for every writer (docs/spec/logging.md#policy), so a measuring check gets no lifecycle at info.
test("the preparation of a check that measures puts the declared policy in force as it is", async () => {
  const settings = {};
  const session = fixture(settings);
  await prepareFixture(session, { measure: true, performanceTrace: false });
  assert.deepEqual(settings["diagnostics.log"], {}, "a measuring check without a declaration does not run under the default policy");
  await prepareFixture(session, { measure: true, log: { call: "debug" }, performanceTrace: true });
  assert.deepEqual(settings["diagnostics.log"], { call: "debug" }, "a measuring check runs under another policy than it declared");
});
