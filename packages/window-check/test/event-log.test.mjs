// 창 검사가 애플리케이션의 event log(docs/spec/logging.md#files)에서 검사 동안 쓰인 오류 event를 읽는지 검사한다.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readEventErrors, readEventOffsets, writeEventOffsets } from "../event-log.mjs";

function configDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "soksak-event-log-"));
  t.after(() => rmSync(dir, { recursive: true }));
  mkdirSync(join(dir, "logs"));
  return dir;
}

const line = (seq, level, event, fields = {}, layer = "host") =>
  `${JSON.stringify({ ts_us: 1791000000000000 + seq, seq, level, layer, event, fields })}\n`;

test("readEventErrors returns the events of level error and ignores the other levels", (t) => {
  const dir = configDir(t);
  writeFileSync(join(dir, "logs", "host-1-10.jsonl"),
    line(1, "info", "log.open", { schema: 1 }) + line(2, "warn", "host.test.warned") +
    line(3, "error", "host.test.failed", { where: "sidecar", text: "closed" }) + line(4, "error", "page.test.failed", {}, "page"));
  const { errors } = readEventErrors(dir, {});
  assert.deepEqual(errors, [
    'error host host.test.failed: {"where":"sidecar","text":"closed"}',
    "error page page.test.failed: {}",
  ]);
});

test("readEventErrors reads from the offsets of each file and leaves an unfinished line for the next read", (t) => {
  const dir = configDir(t);
  const file = join(dir, "logs", "host-1-10.jsonl");
  writeFileSync(file, line(1, "error", "host.test.first") + '{"ts_us":1791000000000009,"seq":2');
  const first = readEventErrors(dir, {});
  assert.deepEqual(first.errors, ["error host host.test.first: {}"]);
  appendFileSync(file, ',"level":"error","layer":"host","event":"host.test.second","fields":{}}\n');
  const second = readEventErrors(dir, first.offsets);
  assert.deepEqual(second.errors, ["error host host.test.second: {}"]);
  assert.deepEqual(readEventErrors(dir, second.offsets).errors, []);
});

test("readEventErrors reads a file of a later run from its start", (t) => {
  const dir = configDir(t);
  writeFileSync(join(dir, "logs", "host-1-10.jsonl"), line(1, "info", "log.open"));
  const first = readEventErrors(dir, {});
  writeFileSync(join(dir, "logs", "host-2-20.jsonl"), line(1, "error", "host.test.after.restart"));
  assert.deepEqual(readEventErrors(dir, first.offsets).errors, ["error host host.test.after.restart: {}"]);
});

test("readEventErrors names the file and the line of a line that is not an event", (t) => {
  const dir = configDir(t);
  writeFileSync(join(dir, "logs", "host-1-10.jsonl"), line(1, "info", "log.open") + "not json\n");
  assert.throws(() => readEventErrors(dir, {}), /host-1-10\.jsonl:2: .*not valid JSON/);
  writeFileSync(join(dir, "logs", "host-1-10.jsonl"), line(1, "info", "log.open") + '{"seq":2}\n');
  assert.throws(() => readEventErrors(dir, {}), /host-1-10\.jsonl:2: .*level/);
});

test("readEventErrors names a file that is shorter than the bytes already read, and a folder without an event log", (t) => {
  const dir = configDir(t);
  assert.throws(() => readEventErrors(dir, {}), /logs holds no host event log/);
  writeFileSync(join(dir, "logs", "host-1-10.jsonl"), line(1, "info", "log.open"));
  assert.throws(() => readEventErrors(dir, { "host-1-10.jsonl": 100000 }), /host-1-10\.jsonl is shorter than the 100000 bytes already read/);
});

test("the offsets of the event logs are kept beside the configuration folder", (t) => {
  const dir = configDir(t);
  assert.deepEqual(readEventOffsets(dir), {});
  writeEventOffsets(dir, { "host-1-10.jsonl": 42 });
  assert.deepEqual(readEventOffsets(dir), { "host-1-10.jsonl": 42 });
  writeFileSync(`${dir}.event-offsets`, "[1]");
  assert.throws(() => readEventOffsets(dir), /expected an object of byte offsets/);
  rmSync(`${dir}.event-offsets`);
});
