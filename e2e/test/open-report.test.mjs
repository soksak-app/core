import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openStages, systemState, traceLength } from "../open-report.mjs";

test("open stages list the page rows written after the offset with their elapsed time", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "soksak-open-report-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "performance.ndjson");
  const before = `${JSON.stringify({ event: "action", layer: "page", kind: "project.open", ts: "2026-10-01T10:00:00.000Z" })}\n`;
  writeFileSync(file, before);
  const offset = traceLength(file);
  assert.equal(offset, before.length);
  writeFileSync(file, before + [
    { event: "action", layer: "page", kind: "project.open", ts: "2026-10-01T10:00:32.928Z" },
    { event: "memory", layer: "sampler", ts: "2026-10-01T10:00:33.000Z" },
    { event: "layout", layer: "page", id: 1, phase: "queued", ts: "2026-10-01T10:00:34.301Z" },
    { event: "endpoint", layer: "host", name: "command.run", ts: "2026-10-01T10:00:44.261Z" },
    { event: "command", layer: "page", name: "core.project.open", ts: "2026-10-01T10:00:44.236Z" },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  assert.equal(openStages(file, offset),
    "action project.open@0ms, layout 1 queued@1373ms, command core.project.open@11308ms");
  assert.equal(openStages(file, traceLength(file)), "no page trace rows");
  assert.equal(traceLength(join(directory, "absent.ndjson")), 0);
});

test("the system state names the load average and the processes that use the most CPU", () => {
  const state = systemState();
  assert.match(state, /^load average \d+\.\d \d+\.\d \d+\.\d on \d+ processors; top CPU: \S/);
  assert.equal(state.split("top CPU: ")[1].split("; ").length, 5);
});
