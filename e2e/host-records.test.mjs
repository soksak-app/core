// The host stores its records in the event log and its raw standard error in the stderr file of the run, under the logs folder
// of the configuration directory (docs/spec/logging.md#files).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { readEventOffsets, untilEventLine } from "@soksak/window-check/event-log.mjs";
import { fresh } from "./fixture.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: the event log holds the run record and the records the page reports`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    s.cleanup(() => s.run("core.projects.browse"));
    // 초점이 옮겨지면 페이지가 그 전이를 report 로 호스트 로그에 적는다.
    await s.run("core.projects.browse");
    await s.until("core.library", (library) => library.shown.length > 0, "the library did not open");
    const transcript = await s.transcript();
    s.cleanup(() => transcript.stop());
    const line = "focus in core.library.search";
    const offsets = readEventOffsets(s.app.configDir);
    await s.run("core.focus.set", { name: "core.library.search" });
    // The transcript holds the record in the text form of the application log.
    await transcript.until((lines) => lines.includes(`info page page: ${line}`), `the page did not report "${line}"`);
    const logs = readdirSync(join(s.app.configDir, "logs"));
    assert.ok(logs.some((name) => /^host-.+\.jsonl$/.test(name)), `logs/ holds no host event log: ${JSON.stringify(logs)}`);
    const run = await untilEventLine(s.app.configDir, {}, (entry) => /^info host run: \S+ pid \d+$/.test(entry), 10000);
    assert.ok(run, "the event log has no run record");
    // The writer stores the record at its next batch, so the check reads the event log until the record is there.
    assert.equal(await untilEventLine(s.app.configDir, offsets, (entry) => entry === `info page page: ${line}`, 10000), `info page page: ${line}`);
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a page reload loses no host reply`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const files = readdirSync(join(s.app.configDir, "logs")).filter((name) => /^host-.+\.stderr$/.test(name));
    assert.equal(files.length >= 1, true, "logs/ holds no stderr file of a run");
    const file = join(s.app.configDir, "logs", files.sort().at(-1));
    const offset = readFileSync(file).length;
    // 새로고침이 멈춘 요청에 쓴 호스트 응답은 사라지고 Wails 는 그 실패를 기록한다(docs/spec/native-host.md#page-reload).
    for (let reload = 0; reload < 2; reload++) await s.run("host.window.reload");
    await s.presented();
    const lost = readFileSync(file).subarray(offset).toString("utf8").split("\n")
      .filter((line) => line.includes("Unable to write json payload"));
    assert.deepEqual(lost, [], `${file} recorded lost host replies during the reloads`);
  });
}
