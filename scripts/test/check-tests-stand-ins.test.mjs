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
  assert.deepEqual(linesOf(detect(name), "inline-program"), [lineOf(name, "bin/sh"), lineOf(name, "console.log('x')")]);
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

test("accepts the name of a declared dependency in an import specifier and reports the identifiers of the test", () => {
  const name = "declared-dependency.txt";
  const findings = findStandIns(`${FIXTURES}${name}`, readFixture(name), new Set(["fake-indexeddb"]));
  assert.deepEqual(linesOf(findings, "stand-in-name"), [lineOf(name, "new IDBFactory()")]);
  const undeclared = findStandIns(`${FIXTURES}${name}`, readFixture(name));
  assert.deepEqual(linesOf(undeclared, "stand-in-name"),
    [lineOf(name, "import { IDBFactory }"), lineOf(name, "await import("), lineOf(name, "new IDBFactory()")]);
});

test("accepts real inputs: a fixture program, recorded bytes, a system folder and a link to the installed tool on the search path", () => {
  for (const name of ["clean-program.txt", "clean-data.txt", "clean-path.txt", "clean-path-link.txt"]) {
    assert.deepEqual(detect(name), [], name);
  }
});

test("does not judge the output fields of a tool recording and judges its other lines", () => {
  assert.deepEqual(detect("recorded-output.json"), []);
  const name = "recorded-text-judged.json";
  assert.deepEqual(detect(name).map(({ kind, line }) => [kind, line]), [["stand-in-name", lineOf(name, '"recorded"')]]);
  const unrecorded = "unrecorded-output.json";
  assert.deepEqual(detect(unrecorded).map(({ kind, line }) => [kind, line]), [["stand-in-name", lineOf(unrecorded, '"stdout"')]]);
});

test("checks a record for identifiers only", () => {
  const findings = findStandIns("docs/spec/example.md", readFixture("docs-record.txt"));
  assert.deepEqual(findings.map(({ kind, line }) => [kind, line]), [["stand-in-name", lineOf("docs-record.txt", "The check")]]);
});

test("skips the fixture folder, the rule document and sources outside the test and record scope", () => {
  const fixtures = ["module-replacement.txt", "timer-replacement.txt", "global-replacement.txt", "inline-program.txt",
    "path-tool.txt", "stand-in-name.txt"].map((name) => `${FIXTURES}${name}`);
  assert.deepEqual(auditStandIns(fixtures), []);
  assert.deepEqual(auditStandIns(["docs/operations/examples.md", "docs/operations/examples.ko.md", "scripts/check-tests.mjs"]), []);
});

test("reports a test source that cannot be read as an unreadable finding", () => {
  const findings = auditStandIns(["scripts/test/absent-stand-in.test.mjs"]);
  assert.deepEqual(findings.map(({ file, kind, line }) => ({ file, kind, line })),
    [{ file: "scripts/test/absent-stand-in.test.mjs", kind: "unreadable", line: 0 }]);
});
