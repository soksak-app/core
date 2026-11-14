// A change watch becomes active some time after the call that starts it, and it reports nothing that changed before. The
// tests make the change of each wait happen in that time (the fault point watchFault.start of folder-wait.mjs: the change runs
// after the call has returned and before the real watch starts) and require that the wait still ends with the changed state.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { POLICY_SCHEMA } from "@soksak/log-contract";

import { untilEndpoint } from "../endpoint-wait.mjs";
import { untilPolicy, policyOfSetting, EVERY_LEVEL } from "../log-policy.mjs";
import { untilEventLines } from "../event-log.mjs";
import { endWatches, watchFault } from "../folder-wait.mjs";
import { joinedFailure } from "../failure.mjs";

/** Sets the change that the next watch start runs before its real watch is active; the fault point is reset when the test ends. */
function changeBeforeWatch(t, change) {
  let pending = change;
  watchFault.start = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    const run = pending;
    pending = () => {};
    run();
  };
  t.after(() => { watchFault.start = null; });
}

function folder(t) {
  const dir = fs.mkdtempSync(join(tmpdir(), "folder-wait-"));
  // The watches that the waits of the test started end before the folder is removed, and a failed end fails the test: on Linux
  // the removal of a watched folder ends its inotify watch, so an end that comes after it fails with EINVAL, and the error would
  // be reported by whichever check next reads the ends of the watches.
  t.after(async () => {
    const ended = await endWatches();
    fs.rmSync(dir, { recursive: true, force: true });
    if (ended.length === 1) throw ended[0];
    if (ended.length > 1) throw joinedFailure(`${ended.length} watch ends failed`, ended);
  });
  return dir;
}

test("the endpoint wait reads an endpoint written before its watch is active", { timeout: 10000 }, async (t) => {
  const dir = folder(t);
  changeBeforeWatch(t, () => {
    const temporary = join(dir, ".settings-endpoint");
    fs.writeFileSync(temporary, `${JSON.stringify({ pid: 200, address: "/tmp/new.sock" })}\n`);
    fs.renameSync(temporary, join(dir, "endpoint.json"));
  });
  const waiting = untilEndpoint(dir, 100);
  assert.deepEqual(await waiting, { pid: 200, address: "/tmp/new.sock" });
});

test("the policy wait reads a policy written before its watch is active", { timeout: 10000 }, async (t) => {
  const dir = folder(t);
  const policy = policyOfSetting(EVERY_LEVEL);
  changeBeforeWatch(t, () => fs.writeFileSync(join(dir, "log-policy.json"), JSON.stringify({ schema: POLICY_SCHEMA, classes: policy.classes })));
  await untilPolicy(dir, policy);
});

test("the event line wait reads a line appended before its watch is active", { timeout: 10000 }, async (t) => {
  const dir = folder(t);
  fs.mkdirSync(join(dir, "logs"));
  const policy = policyOfSetting(EVERY_LEVEL);
  fs.writeFileSync(join(dir, "log-policy.json"), JSON.stringify({ schema: POLICY_SCHEMA, classes: policy.classes }));
  const file = join(dir, "logs", "host-1-10.jsonl");
  const record = (seq, event, fields) => `${JSON.stringify({ ts_us: 1791000000000000 + seq, seq, level: "info", layer: "host", event, fields })}\n`;
  fs.writeFileSync(file, record(1, "log.open", {}));
  const catalog = { events: { "host.record.<level>": { layer: "host", class: "lifecycle", level: ["error", "info"] } } };
  changeBeforeWatch(t, () => fs.appendFileSync(file, record(2, "host.record.info", { where: "w", text: "appended" })));
  const lines = await untilEventLines(dir, {}, (all) => all.includes("info host w: appended"),
    { catalog, records: ["host.record.info"] });
  assert.ok(lines.includes("info host w: appended"));
});
