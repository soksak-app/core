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
    assert.equal(events[0].fields.schema, 1);
    assert.ok(events.some((event) => event.event === "host.app.event" && event.fields.kind === "started"), `${path} holds no application event started`);
    assert.ok(events.some((event) => event.event === "native.window.occlusion"), `${path} holds no native window event: the host did not install the activity observers`);
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
