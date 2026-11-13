// The policy of the event log as the page applies it (docs/spec/logging.md#classes-and-policy): the setting `diagnostics.log` puts the
// policy in force in the gate of the page and asks the host, through the action `policy` of the call `log`, to write the policy file.
// The host answers each call from a page-wire case that the host records (docs/spec/cases/page-wire/README.md).
import assert from "node:assert/strict";
import { test } from "node:test";
import { selectPageWire } from "@soksak/runtime";

const { setLogPolicy } = await import("../log-policy.js");
const { logGate } = await import("../log-gate.js");

const everything = { lifecycle: "trace", input: "trace", call: "trace", io: "trace", frame: "trace" };

test("the setting completes the classes it does not name with error, puts the policy in the gate of the page and has the host write the file", async () => {
  const wire = selectPageWire("log-policy-write");
  try {
    await setLogPolicy({ call: "info", io: "off" });
    assert.deepEqual(wire.calls, [{ name: "log", payload: { action: "policy", classes: { lifecycle: "error", input: "error", call: "info", io: "off", frame: "error" } } }]);
    assert.equal(logGate.enabled("call", "debug"), false);
    assert.equal(logGate.enabled("call", "info"), true);
    assert.equal(logGate.enabled("io", "error"), false);
    wire.finish();
  } finally {
    logGate.set(everything);
  }
});

test("the policy of a settings change carries the cids of the change to the host, and a policy without a change carries none", async () => {
  const wire = selectPageWire("log-policy-cids");
  try {
    await setLogPolicy({ call: "debug" }, ["p1.2"]);
    await setLogPolicy({ call: "trace" });
    assert.deepEqual(wire.calls, [
      { name: "log", payload: { action: "policy", classes: { lifecycle: "error", input: "error", call: "debug", io: "error", frame: "error" }, cids: ["p1.2"] } },
      { name: "log", payload: { action: "policy", classes: { lifecycle: "error", input: "error", call: "trace", io: "error", frame: "error" } } },
    ]);
    wire.finish();
  } finally {
    logGate.set(everything);
  }
});

test("a setting that names a class or a level outside the contract is refused before the gate or the host sees it", async () => {
  const wire = selectPageWire("log-policy-none");
  try {
    await assert.rejects(setLogPolicy({ audio: "off" }), /the class audio is not one of lifecycle, input, call, io, frame/);
    await assert.rejects(setLogPolicy({ call: "loud" }), /the level "loud" of the class call is not one of off, error, warn, info, debug, trace/);
    await assert.rejects(setLogPolicy("off"), /the policy must be an object/);
    assert.deepEqual(wire.calls, []);
    assert.deepEqual(logGate.classes(), everything);
    wire.finish();
  } finally {
    logGate.set(everything);
  }
});

test("a refusal of the host is the error of the call, and the gate of the page keeps the policy that the setting gave", async () => {
  const wire = selectPageWire("log-policy-refused");
  try {
    // The text is the error of the event writer that has no policy file, as the host answers it (log-policy-refused).
    await assert.rejects(setLogPolicy({ call: "warn" }), /this event writer has no policy file/);
    assert.equal(logGate.enabled("call", "info"), false);
    wire.finish();
  } finally {
    logGate.set(everything);
  }
});
