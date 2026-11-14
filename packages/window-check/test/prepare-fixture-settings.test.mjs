// The preparation of a window check changes settings of the check application, and the application keeps the values
// that it had before the check (F129): a person who uses the check application afterwards finds it as it was.
// Each case holds the requests of the preparation and of the cleanup in their order, with the replies of the host: the settings that
// the preparation sends in diagnostics.fixture and the values that the cleanup writes back are the judged requests. The host writes the
// policy of the setting diagnostics.log to the policy file of its configuration folder, so a test writes that file as the host
// leaves it before the preparation waits for it.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { prepareFixture, Session } from "../app.mjs";
import { playSession } from "../fixtures/endpoint-player.mjs";

const LEVELS = ["lifecycle", "input", "call", "io", "frame"];

/** Writes the policy file of the configuration folder with the level of each class in `levels` and error for the others. */
function writePolicy(session, levels) {
  const classes = Object.fromEntries(LEVELS.map((kind) => [kind, levels[kind] ?? "error"]));
  writeFileSync(join(session.app.configDir, "log-policy.json"), JSON.stringify({ schema: 1, classes }));
}

test("the preparation of a check restores the settings that it changed when the check ends", { timeout: 10000 }, async (t) => {
  const { session } = await playSession(t, Session, "window-check-prepare-restores", "wailsv3");
  writePolicy(session, { lifecycle: "info" });
  await prepareFixture(session, { settings: { theme: "light" }, performanceTrace: false });
  for (const clean of session.cleanups.reverse()) await clean();
});

test("the preparation reloads the workbench and waits for a new start of core.window.workbench", { timeout: 10000 }, async (t) => {
  const { session } = await playSession(t, Session, "window-check-prepare-reload", "wailsv3");
  writePolicy(session, { lifecycle: "info" });
  await prepareFixture(session, { performanceTrace: false });
  assert.equal((await session.get("core.window.workbench")).start, "start-2");
});

// F192.3-2: a check declares the log policy it needs and the records it reads; a declaration whose policy does not store a
// record that the check reads fails before the preparation changes anything.
const CATALOG = { events: { "sidecar.vt.pty_read": { layer: "sidecar", class: "io", level: "debug" } } };

test("the preparation refuses a check that reads a record which its declared policy does not store", { timeout: 10000 }, async (t) => {
  // The case window-check-open-idle holds no request: the refusal comes before the preparation reads or changes anything.
  const { session } = await playSession(t, Session, "window-check-open-idle", "wailsv3");
  await assert.rejects(prepareFixture(session, { log: { io: "info" }, reads: ["sidecar.vt.pty_read"], catalog: CATALOG, performanceTrace: false }),
    { message: "the check reads sidecar.vt.pty_read (class io, level debug), which the log policy " +
      '{"lifecycle":"info","input":"error","call":"error","io":"info","frame":"error"} of the declaration of the check does not store' });
});

test("the preparation refuses the policy given as a setting instead of the declaration log", { timeout: 10000 }, async (t) => {
  const { session } = await playSession(t, Session, "window-check-open-idle", "wailsv3");
  await assert.rejects(prepareFixture(session, { settings: { "diagnostics.log": { io: "trace" } }, performanceTrace: false }),
    { message: "prepareFixture: the check declares its log policy with log, not with the setting diagnostics.log" });
});

test("the preparation with the performance trace stores the class call at the level debug and waits for the policy file", { timeout: 10000 }, async (t) => {
  const { session } = await playSession(t, Session, "window-check-prepare-trace", "wailsv3");
  writePolicy(session, { io: "debug", call: "debug", lifecycle: "info" });
  await prepareFixture(session, { log: { io: "debug" }, reads: ["sidecar.vt.pty_read"], catalog: CATALOG, performanceTrace: true });
});

// A failed check keeps the lifecycle of its processes: the sidecars write the open and the close of each session in the class
// lifecycle at the level info, and without them a session that a view lost leaves no record of who closed it.
test("the preparation stores the class lifecycle at least at the level info whatever the check declares", { timeout: 10000 }, async (t) => {
  const { session } = await playSession(t, Session, "window-check-prepare-lifecycle", "wailsv3");
  // A check without a declaration stores no lifecycle below info; the preparation does not narrow the lifecycle that the check declared.
  writePolicy(session, { lifecycle: "info" });
  await prepareFixture(session, { performanceTrace: false });
  writePolicy(session, { lifecycle: "debug" });
  await prepareFixture(session, { log: { lifecycle: "debug" }, performanceTrace: false });
});

// A measurement is valid only under the policy that it declares (docs/spec/hosts.md: G8 runs under the default policy), and the
// policy has one level per class for every writer (docs/spec/logging.md#policy), so a measuring check gets no lifecycle at info.
test("the preparation of a check that measures puts the declared policy in force as it is", { timeout: 10000 }, async (t) => {
  const { session } = await playSession(t, Session, "window-check-prepare-measure", "wailsv3");
  writePolicy(session, {});
  await prepareFixture(session, { measure: true, performanceTrace: false });
  writePolicy(session, { call: "debug" });
  await prepareFixture(session, { measure: true, log: { call: "debug" }, performanceTrace: true });
});
