// A change watch becomes active some time after the call that starts it, and it reports nothing that changed before. The
// tests make the change of each wait happen in that time (fault injection at the watch interfaces: the change runs after
// the call has returned and before the real watch starts) and require that the wait still ends with the changed state.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import * as parcel from "@parcel/watcher";
import { POLICY_SCHEMA } from "@soksak/log-contract";

// The change that the next watch start runs before its real watch is active.
let change = () => {};
const runChange = () => {
  const run = change;
  change = () => {};
  run();
};

// node:fs watch: after the code that called it has run, the change runs, and the watch reports nothing until the
// notifications of that change have passed (ACTIVATION ms after it), as a watch that became active after the change.
const ACTIVATION = 300;
mock.module("node:fs", {
  namedExports: {
    ...Object.fromEntries(["readFileSync", "readdirSync", "statSync", "openSync", "readSync", "closeSync", "existsSync", "writeFileSync"]
      .map((name) => [name, fs[name]])),
    watch(path, ...rest) {
      const listener = rest.pop();
      let activeAt = Infinity;
      setImmediate(() => {
        runChange();
        activeAt = Date.now() + ACTIVATION;
      });
      return fs.watch(path, ...rest, (...event) => {
        if (Date.now() >= activeAt) listener(...event);
      });
    },
  },
});
// @parcel/watcher subscribe: the change runs, then the real subscription starts, and the promise resolves when it is active.
mock.module("@parcel/watcher", {
  namedExports: {
    ...parcel,
    subscribe: async (...args) => {
      await new Promise((resolve) => setImmediate(resolve));
      runChange();
      return parcel.subscribe(...args);
    },
  },
});

const { untilEndpoint } = await import("../endpoint-wait.mjs");
const { untilPolicy, policyOfSetting, EVERY_LEVEL } = await import("../log-policy.mjs");
const { untilEventLines } = await import("../event-log.mjs");

function folder(t) {
  const dir = fs.mkdtempSync(join(tmpdir(), "folder-wait-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("the endpoint wait reads an endpoint written before its watch is active", { timeout: 10000 }, async (t) => {
  const dir = folder(t);
  change = () => {
    const temporary = join(dir, ".settings-endpoint");
    fs.writeFileSync(temporary, `${JSON.stringify({ pid: 200, address: "/tmp/new.sock" })}\n`);
    fs.renameSync(temporary, join(dir, "endpoint.json"));
  };
  const waiting = untilEndpoint(dir, 100, 2000);
  assert.deepEqual(await waiting, { pid: 200, address: "/tmp/new.sock" });
});

test("the policy wait reads a policy written before its watch is active", { timeout: 10000 }, async (t) => {
  const dir = folder(t);
  const policy = policyOfSetting(EVERY_LEVEL);
  change = () => fs.writeFileSync(join(dir, "log-policy.json"), JSON.stringify({ schema: POLICY_SCHEMA, classes: policy.classes }));
  await untilPolicy(dir, policy, 2000);
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
  change = () => fs.appendFileSync(file, record(2, "host.record.info", { where: "w", text: "appended" }));
  const lines = await untilEventLines(dir, {}, (all) => all.includes("info host w: appended"), 2000,
    { catalog, records: ["host.record.info"] });
  assert.ok(lines.includes("info host w: appended"));
});
