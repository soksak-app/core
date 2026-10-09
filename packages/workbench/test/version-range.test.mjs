// The version ranges of docs/spec/installation.md.
import test from "node:test";
import assert from "node:assert/strict";
import { compareVersions, satisfies } from "../version-range.js";

test("versions compare by number", () => {
  assert.ok(compareVersions("0.0.10", "0.0.9") > 0);
  assert.ok(compareVersions("1.0.0", "0.9.9") > 0);
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
});

test("a range contains the versions that the specification gives", () => {
  const cases = [
    ["*", "0.0.0", true], ["*", "9.9.9", true],
    ["1.2.3", "1.2.3", true], ["1.2.3", "1.2.4", false],
    ["^1.2.3", "1.9.0", true], ["^1.2.3", "2.0.0", false], ["^1.2.3", "1.2.2", false],
    ["^0.2.3", "0.2.9", true], ["^0.2.3", "0.3.0", false],
    ["^0.0.2", "0.0.2", true], ["^0.0.2", "0.0.3", false],
    ["~1.2.3", "1.2.9", true], ["~1.2.3", "1.3.0", false],
    [">=0.0.8", "0.0.8", true], [">=0.0.8", "0.0.7", false], [">=0.0.8", "3.0.0", true],
    [">=1.0.0 <2.0.0", "1.5.0", true], [">=1.0.0 <2.0.0", "2.0.0", false],
  ];
  for (const [range, version, want] of cases) assert.equal(satisfies(range, version), want, `${range} contains ${version}`);
});

test("a range of another form is an error", () => {
  for (const range of ["latest", "**", "1.2", "1.2.3-beta", ">=1.0.0 <", ""]) {
    assert.throws(() => satisfies(range, "1.0.0"), new RegExp(`range ${range.replace(/[*^.<]/g, "\\$&")} `), range);
  }
});
