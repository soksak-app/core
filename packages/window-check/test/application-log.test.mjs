// 창 검사가 애플리케이션 로그에서 검사 동안 쓰인 줄을 읽는지 검사한다(docs/spec/hosts.md#application-log).
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseRecord, readErrors, readLines } from "../application-log.mjs";

function configDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "soksak-application-log-"));
  t.after(() => rmSync(dir, { recursive: true }));
  mkdirSync(join(dir, "logs"));
  return dir;
}

test("readLines returns the complete lines after the offset and keeps an unfinished line for the next read", (t) => {
  const dir = configDir(t);
  const log = join(dir, "logs", "application.log");
  const before = "line of the previous check\n";
  writeFileSync(log, `${before}exposure reply 9 of removed surface "tab-a" arrived after its request ended\nerror: verify: 1 fail\npart`);
  const first = readLines(dir, Buffer.byteLength(before));
  assert.deepEqual(first.lines, [
    'exposure reply 9 of removed surface "tab-a" arrived after its request ended',
    "error: verify: 1 fail",
  ]);
  assert.equal(first.end, statSync(log).size - Buffer.byteLength("part"), "the unfinished line was counted as read");
  appendFileSync(log, "ial line\n");
  const second = readLines(dir, first.end);
  assert.deepEqual(second, { lines: ["partial line"], end: statSync(log).size });
  assert.deepEqual(readLines(dir, second.end).lines, []);
});

test("readLines reads the rest of the previous generation when the log was replaced", (t) => {
  const dir = configDir(t);
  const log = join(dir, "logs", "application.log");
  writeFileSync(`${log}.1`, "old line\nlast line of the old run\n");
  writeFileSync(log, "new run\n");
  assert.deepEqual(readLines(dir, Buffer.byteLength("old line\n")).lines, ["last line of the old run", "new run"]);
});

const T = "2026-10-09T05:50:18.336Z";

test("parseRecord splits a text record into its time, level, layer, place and text", () => {
  assert.deepEqual(parseRecord(`${T} error host page process: main: terminated`), {
    time: T, level: "error", layer: "host", where: "page process", text: "main: terminated",
  });
  assert.deepEqual(parseRecord(`${T} info native input method: {"call":"keyDown"}`), {
    time: T, level: "info", layer: "native", where: "input method", text: '{"call":"keyDown"}',
  });
  // A line that is not a record is not parsed: the output of the runtime and of the operating system has no form.
  for (const line of ["error: wails: failed", `${T} warning host x: y`, `${T} error cloud x: y`, `${T} error host no separator`, "TSM AdjustCapsLock"]) {
    assert.equal(parseRecord(line), null, line);
  }
});

test("readErrors keeps the records of level error without their time and reports the lines that have no form", (t) => {
  const dir = configDir(t);
  const text = `${T} info host webkit children: pid 7: gone\n${T} error host wails: failed\nTSM AdjustCapsLock\n${T} error page library: x\n`;
  writeFileSync(join(dir, "logs", "application.log"), text);
  assert.deepEqual(readErrors(dir, 0), {
    errors: ["error host wails: failed", "error page library: x"],
    unformatted: ["TSM AdjustCapsLock"],
    end: Buffer.byteLength(text),
  });
});

test("readLines finds the rest of the old run in the newest earlier generation that is long enough", (t) => {
  const dir = configDir(t);
  const log = join(dir, "logs", "application.log");
  writeFileSync(`${log}.1`, "second generation of the old run\n");
  writeFileSync(log, "new run\n");
  assert.deepEqual(readLines(dir, Buffer.byteLength("second generation of the old run\n") - 10).lines.slice(-1), ["new run"]);
});
