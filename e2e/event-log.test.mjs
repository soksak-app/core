// A running application has started the event writer of its host (docs/spec/logging.md#files): the file
// `logs/host-<boot>.jsonl` of the process opens with `log.open`, is private to its owner, and holds consecutive `seq`.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { currentEventOffsets, untilEventLine } from "@soksak/window-check/event-log.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: the host writes its event log from the start of the process`, { timeout: 30000 }, async (t) => {
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is not built`);
    const { pid } = JSON.parse(readFileSync(join(app.configDir, "endpoint.json"), "utf8"));
    assert.ok(Number.isInteger(pid), `endpoint.json holds no process identifier: ${pid}`);
    const logs = join(app.configDir, "logs");
    // The boot identifier ends with the process identifier, so a file of an earlier run is not read.
    const names = readdirSync(logs).filter((name) => name.startsWith("host-") && name.endsWith(`-${pid}.jsonl`));
    assert.equal(names.length, 1, `logs/ holds ${names.length} event logs of process ${pid}: ${names.join(", ")}`);
    const path = join(logs, names[0]);
    assert.equal(statSync(path).mode & 0o777, 0o600, `${path} is not private to its owner`);
    const events = readFileSync(path, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
    assert.equal(events[0].event, "log.open");
    assert.equal(events[0].fields.pid, pid);
    assert.equal(events[0].fields.role, "host");
    assert.equal(events[0].fields.schema, 2);
    assert.ok(events.some((event) => event.event === "host.app.event" && event.fields.kind === "started"), `${path} holds no application event started`);
    // The observers store a window event or an input source event while the first window opens; a start without either means the host did not install them.
    assert.ok(events.some((event) => event.event.startsWith("native.window.") || event.event === "native.input.source_changed"), `${path} holds no event of the activity observers`);
    events.forEach((event, index) => assert.equal(event.seq, index + 1, `${path} line ${index + 1} has seq ${event.seq}`));
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a window that opens and closes leaves the events of the window`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is not built`);
    const offsets = currentEventOffsets(app.configDir);
    await s.run("core.window.new");
    const list = await s.windows(2, "the new window did not open");
    const child = s.on(list.find((w) => w.window !== s.window).window);
    await child.close();
    const closed = await untilEventLine(app.configDir, offsets,
      (line) => line.startsWith("info host host.window.event:") && line.includes('"kind":"closed"'), 30000);
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
    const { fresh } = await import("./fixture.mjs");
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
    }, 30000);
    assert.ok(placed.includes(terminal.surface), `the placed surface event names no surface: ${placed}`);
    const memory = await untilEventLine(app.configDir, offsets,
      (line) => line.includes("host.sampler.memory") && line.includes('"role":"sidecar"') && line.includes('"rss_kb"'), 60000);
    assert.match(memory, /"pid":[0-9]+/, `the memory event of the sidecar holds no process: ${memory}`);
    await s.run("host.window.reload");
    await s.until("host.windows", (list) => list.some((item) => item.window === s.window && item.ready), "the reloaded page did not report ready");
    await s.flushLog();
    const starts = await untilEventLine(app.configDir, offsets, (line) => line.includes("page.start") && line.includes('"url"'), 30000);
    assert.match(starts, /"time_origin":[0-9.]+/, `the page start event holds no clock origin: ${starts}`);
  });
}
