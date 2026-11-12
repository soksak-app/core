import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { currentEventOffsets, readEvents } from "@soksak/window-check/event-log.mjs";
import { frames } from "@soksak/window-check/frame.mjs";
import { readStills, requireNoLostStills } from "@soksak/window-check/stills.mjs";
import { fresh } from "./fixture.mjs";

function snapshot(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const name = prefix + entry.name;
    if (entry.isDirectory()) return [{ name, directory: true }, ...snapshot(join(directory, entry.name), `${name}/`)];
    assert.ok(entry.isFile(), `capture artifact is not a regular file: ${name}`);
    return [{ name, sha256: createHash("sha256").update(readFileSync(join(directory, entry.name))).digest("hex") }];
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: consecutive captures preserve finalized recordings`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s, { log: { lifecycle: "debug" }, reads: ["native.capture.lifecycle"] });
    const original = (await s.get("core.settings")).values.textSize;
    const completed = [];
    s.cleanup(async () => {
      await s.run("core.settings.set", { patch: { textSize: original }, scope: "common" });
      await s.presented();
    });
    for (let cycle = 0; cycle < 3; cycle++) {
      const started = performance.now();
      console.info(`running ${app.name}: capture lifecycle ${cycle + 1}`);
      assert.equal((await s.get("host.window")).active, false);
      const offsets = currentEventOffsets(app.configDir);
      const recording = await s.record();
      const textSize = cycle % 2 === 0 ? (original === 1 ? 1.1 : 1) : original;
      await s.run("core.settings.set", { patch: { textSize }, scope: "common" });
      await s.until("core.text", (value) => value.frame === textSize, "text size did not reach the requested state");
      const { displayed } = await s.presented();
      const stopped = await recording.stop({ after: displayed });
      await s.flushLog();
      // The trace of one still recording (native.capture.lifecycle of docs/spec/events.json): one start, one first-still
      // record for the written still 0, one stop and one end, all of one session, no still-failed record, and an end that
      // closes the recording without an error and counts its written frames.
      const records = readEvents(app.configDir, offsets).events.filter((event) => event.event === "native.capture.lifecycle");
      const lifecycle = records.map((event) => event.fields);
      const told = JSON.stringify(lifecycle);
      const [start, ...otherStarts] = lifecycle.filter((fields) => fields.phase === "start");
      assert.ok(start && otherStarts.length === 0, `the recording has not exactly one start record: ${told}`);
      const session = start.session;
      assert.ok(typeof session === "string" && session.length > 0, `the start record names no session: ${told}`);
      assert.deepEqual(lifecycle.filter((fields) => fields.session !== session), [], `records of another recording: ${told}`);
      const { refreshRate } = await s.get("host.window");
      assert.equal(start.gap, 1000 / refreshRate, `the recording took a still at another gap than each refresh: ${told}`);
      assert.equal(start.plannedStills, 4096, `the recording planned another number of stills: ${told}`);
      for (const phase of ["first-still", "stop", "end"]) {
        assert.equal(lifecycle.filter((fields) => fields.phase === phase).length, 1, `the recording lacks one ${phase}: ${told}`);
      }
      const first = lifecycle.find((fields) => fields.phase === "first-still");
      assert.equal(first.index, 0, `the first-still record names still ${first.index}: ${told}`);
      assert.deepEqual(lifecycle.filter((fields) => fields.phase === "still-failed"), [], `a still failed: ${told}`);
      const end = records.find((event) => event.fields.phase === "end");
      assert.equal(end.level, "debug", `the recording ended with an error: ${told}`);
      assert.equal(end.fields.reason, null, `the recording ended with an error: ${told}`);
      assert.equal(end.fields.written, stopped.count, `the end record counts other written frames than the stop: ${told}`);
      assert.equal(stopped.frames, recording.frames);
      const count = frames(recording.frames).length;
      assert.ok(count > 0, "the recording contains no frames");
      assert.equal(stopped.count, count, "the stop count differs from finalized frame files");
      // Every still of the recording is written: a still that it lost is a moment of the window that no record holds.
      const rows = readStills(stopped.stills);
      requireNoLostStills(rows, "the consecutive recording");
      const written = rows.filter((row) => row.outcome === "written");
      assert.equal(written.length, count, "the written rows of stills.jsonl differ from the finalized frame files");
      assert.ok(!completed.some((item) => item.directory === recording.frames), "a later recording reused a finalized directory");
      completed.push({ directory: recording.frames, files: snapshot(recording.frames) });
      for (const item of completed)
        assert.deepEqual(snapshot(item.directory), item.files, "a later recording modified finalized artifacts");
      assert.equal((await s.get("host.window")).active, false);
      console.info(`passed ${app.name}: capture lifecycle ${cycle + 1} (${Math.round(performance.now() - started)}ms, ${count} frames)`);
    }
    t.diagnostic("Three sequential recordings retain independent counts and unchanged finalized bytes; controlled native owners cover delayed callbacks.");
  });
}
