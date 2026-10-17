// The golden cases of the policy file (docs/spec/logging.md#policy-file): the validator that a sidecar test calls accepts each
// valid text with the classes and the gate of the case, refuses each invalid text with the error of the case, and the file
// the host writes by default is the default policy.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DEFAULT_POLICY, POLICY_CLASSES, POLICY_VALUES, parsePolicy, policyAllows, policyIsBeingWritten } from "../index.js";

const cases = JSON.parse(readFileSync(new URL("../fixtures/policy/cases.json", import.meta.url), "utf8"));
const FILE = "/config/log-policy.json";

test("the classes and the values of the validator are those of the fixture", () => {
  assert.deepEqual(POLICY_CLASSES, cases.classes);
  assert.deepEqual(POLICY_VALUES, cases.values);
});

for (const valid of cases.valid) {
  test(`the policy "${valid.name}" is accepted with its classes and its gate`, () => {
    const policy = parsePolicy(FILE, valid.text);
    assert.deepEqual(policy, { schema: cases.schema, classes: valid.classes });
    for (const [kind, level] of valid.allows) assert.equal(policyAllows(policy, kind, level), true, `${kind} ${level}`);
    for (const [kind, level] of valid.refuses) assert.equal(policyAllows(policy, kind, level), false, `${kind} ${level}`);
  });
}

for (const invalid of cases.invalid) {
  test(`the policy file "${invalid.name}" is refused with an error that names the file and what was found`, () => {
    const attempt = () => parsePolicy(FILE, invalid.text);
    if (invalid.error_prefix !== undefined) {
      const prefix = invalid.error_prefix.replace("<file>", FILE);
      assert.throws(attempt, (error) => error.message.startsWith(prefix));
    } else {
      assert.throws(attempt, { message: invalid.error.replace("<file>", FILE) });
    }
  });
}

test("a file that is empty is a file that a writer is writing, and a file with content is not", () => {
  for (const waiting of cases.unchanged_by_watcher) assert.equal(policyIsBeingWritten(waiting.text), true, waiting.name);
  for (const { text } of [...cases.valid, ...cases.invalid.filter(({ text }) => text.trim() !== "")]) assert.equal(policyIsBeingWritten(text), false);
});

test("the gate refuses a class or a level outside the contract", () => {
  const policy = parsePolicy(FILE, cases.valid[0].text);
  assert.throws(() => policyAllows(policy, "audio", "info"), { message: "the class audio is not one of lifecycle, input, call, io, frame" });
  assert.throws(() => policyAllows(policy, "call", "verbose"), { message: "the level verbose is not one of error, warn, info, debug, trace" });
});

test("the default policy stores only error in every class, and the default file holds it", () => {
  assert.deepEqual(cases.default, Object.fromEntries(cases.classes.map((kind) => [kind, "error"])));
  assert.deepEqual(DEFAULT_POLICY.classes, cases.default);
  const text = readFileSync(new URL("../fixtures/policy/log-policy.json", import.meta.url), "utf8");
  const policy = parsePolicy(FILE, text);
  assert.deepEqual(policy.classes, cases.default);
  for (const kind of cases.classes) for (const level of cases.levels) assert.equal(policyAllows(policy, kind, level), level === "error", `${kind} ${level}`);
  assert.equal(JSON.stringify(policy), text);
});
