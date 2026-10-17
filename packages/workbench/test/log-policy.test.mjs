// The policy of the event log as the page applies it (docs/spec/logging.md#classes-and-policy): the setting `diagnostics.log` puts the
// policy in force in the gate of the page and asks the host, through the action `policy` of the call `log`, to write the policy file.
import assert from "node:assert/strict";
import { mock, test } from "node:test";

const calls = [];
let failing = null;
mock.module("@soksak/runtime", { namedExports: { host: {
  on: () => {},
  page: (path) => path,
  call: async (name, payload) => {
    if (failing) throw failing;
    calls.push({ name, payload });
  },
} } });
const { setLogPolicy } = await import("../log-policy.js");
const { logGate } = await import("../log-gate.js");

const everything = { lifecycle: "trace", input: "trace", call: "trace", io: "trace", frame: "trace" };

test("the setting completes the classes it does not name with error, puts the policy in the gate of the page and has the host write the file", async () => {
  calls.length = 0;
  try {
    await setLogPolicy({ call: "info", io: "off" });
    assert.deepEqual(calls, [{ name: "log", payload: { action: "policy", classes: { lifecycle: "error", input: "error", call: "info", io: "off", frame: "error" } } }]);
    assert.equal(logGate.enabled("call", "debug"), false);
    assert.equal(logGate.enabled("call", "info"), true);
    assert.equal(logGate.enabled("io", "error"), false);
  } finally {
    logGate.set(everything);
  }
});

test("a setting that names a class or a level outside the contract is refused before the gate or the host sees it", async () => {
  calls.length = 0;
  await assert.rejects(setLogPolicy({ audio: "off" }), /the class audio is not one of lifecycle, input, call, io, frame/);
  await assert.rejects(setLogPolicy({ call: "loud" }), /the level "loud" of the class call is not one of off, error, warn, info, debug, trace/);
  await assert.rejects(setLogPolicy("off"), /the policy must be an object/);
  assert.deepEqual(calls, []);
  assert.deepEqual(logGate.classes(), everything);
});

test("a refusal of the host is the error of the call, and the gate of the page keeps the policy that the setting gave", async () => {
  failing = new Error("the host refuses the policy");
  try {
    await assert.rejects(setLogPolicy({ call: "warn" }), /the host refuses the policy/);
    assert.equal(logGate.enabled("call", "info"), false);
  } finally {
    failing = null;
    logGate.set(everything);
  }
});
