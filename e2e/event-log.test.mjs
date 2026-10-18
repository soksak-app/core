// A running application has started the event writer of its host (docs/spec/logging.md#files): the file
// `logs/host-<boot>.jsonl` of the process opens with `log.open`, is private to its owner, and with the debug file of the process
// holds consecutive `seq`, which the writer counts across both files (docs/spec/logging.md#files).
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { currentEventOffsets, untilEventLine } from "@soksak/window-check/event-log.mjs";
import { fresh, reading } from "./fixture.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: the host writes its event log from the start of the process`, { timeout: 30000 }, async (t) => {
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is not built`);
    // The endpoint calls of the check are events of the class call at the level debug, which the debug file holds.
    await fresh(s, { log: { call: "debug" }, reads: ["host.endpoint.call"] });
    const { pid } = JSON.parse(readFileSync(join(app.configDir, "endpoint.json"), "utf8"));
    assert.ok(Number.isInteger(pid), `endpoint.json holds no process identifier: ${pid}`);
    const logs = join(app.configDir, "logs");
    // The boot identifier ends with the process identifier, so a file of an earlier run is not read.
    const names = readdirSync(logs).filter((name) => name.startsWith("host-") && name.endsWith(`-${pid}.jsonl`));
    assert.equal(names.length, 1, `logs/ holds ${names.length} event logs of process ${pid}: ${names.join(", ")}`);
    const path = join(logs, names[0]);
    assert.equal(statSync(path).mode & 0o777, 0o600, `${path} is not private to its owner`);
    // The writer appends while the check reads, so a last line without its end is not read.
    const lines = (file) => readFileSync(file, "utf8").split("\n").slice(0, -1).map((line) => JSON.parse(line));
    const events = lines(path);
    assert.equal(events[0].event, "log.open");
    assert.equal(events[0].fields.pid, pid);
    assert.equal(events[0].fields.role, "host");
    assert.equal(events[0].fields.schema, 2);
    // The policy in force at the start of the process is stored as log.policy, which passes every gate. host.app.event `started`
    // is below `error` and is stored only by a policy in force before the process started, which no declared entry sets; the
    // activity observers are checked by the window that the next test opens.
    assert.ok(events.some((event) => event.event === "log.policy"), `${path} holds no log.policy`);
    // The debug file of the process holds the events of the levels debug and trace; one seq counts across both files, the log.open
    // of each file included.
    const debugPath = path.replace(/\.jsonl$/, ".debug.jsonl");
    const debug = lines(debugPath);
    assert.equal(statSync(debugPath).mode & 0o777, 0o600, `${debugPath} is not private to its owner`);
    assert.equal(debug[0]?.event, "log.open", `${debugPath} does not open with log.open`);
    // A file that passed its bound was moved to a generation `<name>.<n>` (docs/spec/logging.md#files), which holds the earlier
    // lines of the same seq.
    const generations = (file) => readdirSync(logs).filter((name) => name.startsWith(`${basename(file)}.`) && /^\d+$/.test(name.slice(basename(file).length + 1)))
      .flatMap((name) => lines(join(logs, name)));
    // The files are read one after the other while the writer appends to both, so only the seq up to the last seq of each file
    // is complete in both reads.
    const last = Math.min(events.at(-1).seq, debug.at(-1).seq);
    const numbered = [...generations(path), ...events, ...generations(debugPath), ...debug].filter((event) => event.seq <= last)
      .sort((left, right) => left.seq - right.seq);
    numbered.forEach((event, index) => assert.equal(event.seq, index + 1,
      `the event files of process ${pid} skip from seq ${numbered[index - 1]?.seq} to ${event.seq}`));
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a window that opens and closes leaves the events of the window`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is not built`);
    // host.window.event is a lifecycle event at the levels debug and info, and native.window.occlusion at the level info.
    const reads = ["host.window.event", "native.window.occlusion"];
    await fresh(s, { log: { lifecycle: "debug" }, reads });
    const offsets = currentEventOffsets(app.configDir);
    await s.run("core.window.new");
    const list = await s.windows(2, "the new window did not open");
    // The activity observers that the host installed at its start record the new window when it becomes visible; a window
    // without the event means the host did not install them.
    await s.flushLog();
    await untilEventLine(app.configDir, offsets,
      (line) => line.startsWith("info native native.window.occlusion:") && line.includes('"visible":true'), 30000,
      reading(app, reads));
    const child = s.on(list.find((w) => w.window !== s.window).window);
    await child.close();
    const closed = await untilEventLine(app.configDir, offsets,
      (line) => line.startsWith("info host host.window.event:") && line.includes('"kind":"closed"'), 30000,
      reading(app, reads));
    assert.match(closed, /"window":"[^"]+"/);
  });
}

// The trace of the host (docs/spec/performance-trace.md): with the trace on, the host stores the lifecycle of a surface with its
// geometry, the sampler stores the memory of the host and of every registered sidecar process, and a reload of the main page
// starts a new document that the event `page.start` marks.
for (const app of Object.values(APPS)) {
  test(`${app.name}: the trace stores the surface geometry, the memory of the sidecar and the start of each page document`, { timeout: 90000 }, async (t) => {
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is not built`);
    const { ensureTerminals } = await import("./terminal-screen.mjs");
    const offsets = currentEventOffsets(app.configDir);
    await fresh(s, { performanceTrace: true });
    const [terminal] = await ensureTerminals(s, 1);
    await s.until("terminal.session", (state) => Boolean(state.sessionId), `${terminal.surface} did not open a sidecar session`, { surface: terminal.surface });
    await s.flushLog();
    // The surface is placed hidden first and visible with its geometry after the layout of the window.
    const placed = await untilEventLine(app.configDir, offsets, (line) => {
      if (!line.includes("host.trace.surface") || !line.includes(terminal.surface)) return false;
      const fields = JSON.parse(line.slice(line.indexOf("{")));
      return fields.phase === "placed" && fields.visible === true && fields.w > 0 && fields.h > 0;
    }, 30000, reading(app, ["host.trace.surface"]));
    assert.ok(placed.includes(terminal.surface), `the placed surface event names no surface: ${placed}`);
    const memory = await untilEventLine(app.configDir, offsets,
      (line) => line.includes("host.sampler.memory") && line.includes('"role":"sidecar"') && line.includes('"rss_kb"'), 60000,
      reading(app, ["host.sampler.memory"]));
    assert.match(memory, /"pid":[0-9]+/, `the memory event of the sidecar holds no process: ${memory}`);
    await s.run("host.window.reload");
    await s.until("host.windows", (list) => list.some((item) => item.window === s.window && item.ready), "the reloaded page did not report ready");
    await s.flushLog();
    const starts = await untilEventLine(app.configDir, offsets, (line) => line.includes("page.start") && line.includes('"url"'), 30000,
      reading(app, ["page.start"]));
    assert.match(starts, /"time_origin":[0-9.]+/, `the page start event holds no clock origin: ${starts}`);
  });
}
