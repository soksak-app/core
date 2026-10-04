// 창 검사가 애플리케이션 로그에서 검사 동안 쓰인 줄을 읽는지 검사한다(docs/spec/hosts.md#application-log).
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readErrors, readLines } from "../application-log.mjs";

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

test("readErrors keeps only the error lines that readLines reads", (t) => {
  const dir = configDir(t);
  writeFileSync(join(dir, "logs", "application.log"), "observation\nerror: wails: failed\n");
  assert.deepEqual(readErrors(dir, 0), { errors: ["error: wails: failed"], end: Buffer.byteLength("observation\nerror: wails: failed\n") });
});
