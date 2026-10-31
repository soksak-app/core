import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { currentEventOffsets, readEvents } from "@soksak/window-check/event-log.mjs";
import { frames } from "@soksak/window-check/frame.mjs";
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
      const lifecycle = readEvents(app.configDir, offsets).events
        .filter(event => event.event === "native.capture.lifecycle").map(event => event.fields);
      const requests = lifecycle.filter(fields => fields.phase === "start-request");
      assert.equal(requests.length, 1, `capture attempt requests: ${JSON.stringify(lifecycle)}`);
      const session = requests[0].session;
      assert.equal(typeof session, "string");
      assert.ok(session.length > 0, "capture attempt session is empty");
      for (const phase of ["start-completion", "first-sample"])
        assert.equal(lifecycle.filter(fields => fields.session === session && fields.phase === phase).length, 1,
          `capture ${session} lacks one ${phase}: ${JSON.stringify(lifecycle)}`);
      assert.equal(lifecycle.filter(fields => fields.phase === "failed").length, 0,
        `capture lifecycle failed: ${JSON.stringify(lifecycle)}`);
      assert.equal(stopped.frames, recording.frames);
      const count = frames(recording.frames).length;
      assert.ok(count > 0, "the recording contains no frames");
      assert.equal(stopped.count, count, "the stop count differs from finalized frame files");
      assert.ok(readFileSync(stopped.callbackStatus, "utf8").trim().length > 0, "callback records are missing");
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
