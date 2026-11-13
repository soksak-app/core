import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { auditStandIns, findStandIns } from "../check-tests.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FIXTURES = "scripts/test/fixtures/check-tests-stand-ins/";
// The fixtures are text inputs of the detector; the node test runner does not run them as modules.
const readFixture = (name) => readFileSync(`${ROOT}${FIXTURES}${name}`, "utf8");
const detect = (name) => findStandIns(`${FIXTURES}${name}`, readFixture(name));
const lineOf = (name, text) => readFixture(name).split("\n").findIndex((line) => line.includes(text)) + 1;
const linesOf = (findings, kind) => findings.filter((finding) => finding.kind === kind).map(({ line }) => line);

test("rejects a module replacement at the line that calls it", () => {
  const name = "module-replacement.txt";
  assert.deepEqual(linesOf(detect(name), "module-replacement"), [lineOf(name, ".module(")]);
});

test("rejects a clock replacement at the line that enables it", () => {
  const name = "timer-replacement.txt";
  assert.deepEqual(linesOf(detect(name), "timer-replacement"), [lineOf(name, ".timers.")]);
});

test("rejects a replacement of a global method at the line that calls it", () => {
  const name = "global-replacement.txt";
  assert.deepEqual(linesOf(detect(name), "global-replacement"), [lineOf(name, "globalThis")]);
});

test("rejects inline program text that the test writes and runs, shebang or literal", () => {
  const name = "inline-program.txt";
  assert.deepEqual(linesOf(detect(name), "inline-program"), [lineOf(name, "#!/bin/sh"), lineOf(name, "console.log('x')")]);
});

test("rejects a search path prepended with a temporary folder that holds executables", () => {
  const name = "path-tool.txt";
  assert.deepEqual(linesOf(detect(name), "path-tool"), [lineOf(name, "PATH: `")]);
});

test("reports each identifier or word that names a stand-in", () => {
  const name = "stand-in-name.txt";
  const findings = detect(name);
  assert.deepEqual(linesOf(findings, "stand-in-name"), [lineOf(name, "Client = {"), lineOf(name, "answers every"), lineOf(name, "Client.send()")]);
  assert.deepEqual(findings.map(({ kind }) => kind), ["stand-in-name", "stand-in-name", "stand-in-name"]);
});

test("accepts real inputs: a fixture program, recorded bytes and a system folder on the search path", () => {
  for (const name of ["clean-program.txt", "clean-data.txt", "clean-path.txt"]) {
    assert.deepEqual(detect(name), [], name);
  }
});

test("checks a record for identifiers only", () => {
  const findings = findStandIns("docs/spec/example.md", readFixture("docs-record.txt"));
  assert.deepEqual(findings.map(({ kind, line }) => [kind, line]), [["stand-in-name", lineOf("docs-record.txt", "The check")]]);
});

test("skips the fixture folder, the rule document and sources outside the test and record scope", () => {
  const fixtures = ["module-replacement.txt", "timer-replacement.txt", "global-replacement.txt", "inline-program.txt",
    "path-tool.txt", "stand-in-name.txt"].map((name) => `${FIXTURES}${name}`);
  assert.deepEqual(auditStandIns(fixtures), []);
  assert.deepEqual(auditStandIns(["docs/operations/examples.md", "scripts/check-tests.mjs"]), []);
});

test("reports a test source that cannot be read as an unreadable finding", () => {
  const findings = auditStandIns(["scripts/test/absent-stand-in.test.mjs"]);
  assert.deepEqual(findings.map(({ file, kind, line }) => ({ file, kind, line })),
    [{ file: "scripts/test/absent-stand-in.test.mjs", kind: "unreadable", line: 0 }]);
});
