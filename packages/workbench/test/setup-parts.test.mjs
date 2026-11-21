// The setup parts of the agents of the machine and the core.setup entries (docs/spec/settings.md#agents). The host calls are answered
// by the page-wire cases setup-parts-* (docs/spec/cases/page-wire/README.md).
import test from "node:test";
import assert from "node:assert/strict";
import { EXPOSURE_ERRORS } from "@soksak/plugin-api";
import { host, selectPageWire } from "@soksak/runtime";
import { NO_HOST, createSetupParts, missingKinds, setupKinds } from "../setup-parts.js";

/** Settles the reads that the notices and the showing started. */
const settled = () => new Promise((resolve) => setImmediate(resolve));

/** The setup parts over the host of the selected case, with the record of the changes and of the shown errors. */
function open(name) {
  const wire = selectPageWire(name);
  const shown = [];
  let changes = 0;
  const parts = createSetupParts({ host, changed: () => { changes += 1; }, failed: (text) => shown.push(text) });
  return { wire, parts, shown, changes: () => changes };
}

test("showing the group reads the parts, window-active and setup-changed read them again only while it is shown, and a failed read keeps them", { timeout: 5000 }, async () => {
  const { wire, parts, shown } = open("setup-parts-read");
  parts.follow();
  parts.show(true);
  await settled();
  assert.deepEqual(parts.status().parts.map(({ part, state }) => [part, state]), [["path", "ok"], ["skill", "missing"], ["mcp", "missing"]]);
  assert.equal(parts.status().running, null);
  // Drawing the shown group again does not read the parts again.
  parts.show(true);
  await settled();
  assert.equal(wire.calls.length, 1, "a redraw of the shown group read the parts again");

  wire.deliverNotice();
  await settled();
  assert.deepEqual(shown, ["setup: login shell /bin/zsh: no environment within 10 s"], "the failed read is not shown through the error display");
  assert.equal(parts.status().parts.length, 3, "a failed read replaced the parts of the last read");

  wire.deliverNotice();
  await settled();
  assert.deepEqual(parts.status().parts.map(({ part, state }) => [part, state]), [["path", "ok"], ["skill", "ok"], ["mcp", "ok"]]);

  parts.show(false);
  wire.deliverNotice();
  wire.deliverNotice();
  await settled();
  assert.equal(wire.calls.length, 3, "a window-active or setup-changed of a hidden group read the parts");
  wire.finish();
});

test("an install runs setupInstall with the kinds, reports them as running, refuses a second install, and keeps the parts after a failure", { timeout: 5000 }, async () => {
  const { wire, parts, shown } = open("setup-parts-install");
  const first = parts.install(["skill", "mcp"]);
  assert.deepEqual(parts.status(), { parts: [], running: ["skill", "mcp"] });
  await assert.rejects(parts.install(["mcp"]), /^Error: another setup operation is running$/);
  assert.equal(wire.calls.length, 1, "the second install was sent to the host");
  wire.release("setupInstall");
  const answer = await first;
  assert.deepEqual(answer.parts.map(({ part, changed }) => [part, changed]), [["path", undefined], ["skill", true], ["mcp", true]]);
  assert.deepEqual(parts.status().running, null);
  assert.equal(parts.status().parts, answer.parts);

  await assert.rejects(parts.install(["mcp"]), /is not the sok of an application bundle$/);
  assert.equal(parts.status().parts, answer.parts, "a failed install replaced the parts");
  assert.equal(parts.status().running, null);
  assert.deepEqual(shown, ["setup: another setup operation is running",
    "setup: the first sok on PATH, /usr/local/bin/sok, is not the sok of an application bundle"]);
  wire.finish();
});

test("core.setup.install takes a non-empty list of skill and mcp without repetition, and a window without a host has no setup operations", { timeout: 5000 }, async () => {
  for (const parts of [[], ["path"], ["skill", "skill"], "skill", undefined, ["mcp", "other"]]) {
    assert.throws(() => setupKinds(parts), (error) => error.code === EXPOSURE_ERRORS.invalidParams, `${JSON.stringify(parts)} is accepted`);
  }
  assert.deepEqual(setupKinds(["mcp", "skill"]), ["mcp", "skill"]);
  const shown = [];
  const parts = createSetupParts({ host: null, changed: () => {}, failed: (text) => shown.push(text) });
  await assert.rejects(parts.install(["skill"]), new RegExp(`^Error: ${NO_HOST}$`));
  await assert.rejects(parts.read(), new RegExp(`^Error: ${NO_HOST}$`));
  await assert.rejects(parts.install(["path"]), (error) => error.code === EXPOSURE_ERRORS.invalidParams);
  parts.show(true);
  assert.deepEqual(parts.status(), { parts: [], running: null });
});

test("the install kinds are the skill and mcp kinds with a part that is not ok", () => {
  const part = (kind, state) => ({ part: kind, file: kind, state, step: "" });
  assert.deepEqual(missingKinds([part("path", "missing"), part("skill", "ok"), part("skill", "missing"), part("mcp", "error")]), ["skill", "mcp"]);
  assert.deepEqual(missingKinds([part("path", "missing"), part("skill", "ok"), part("mcp", "ok")]), []);
});
