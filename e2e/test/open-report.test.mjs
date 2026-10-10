import assert from "node:assert/strict";
import test from "node:test";

import { openStages, systemState } from "../open-report.mjs";

test("open stages list the page rows with their elapsed time", () => {
  const rows = [
    { event: "action", layer: "page", kind: "project.open", ts: "2026-10-01T10:00:32.928Z" },
    { event: "memory", layer: "sampler", ts: "2026-10-01T10:00:33.000Z" },
    { event: "layout", layer: "page", id: 1, phase: "queued", ts: "2026-10-01T10:00:34.301Z" },
    { event: "endpoint", layer: "host", name: "command.run", ts: "2026-10-01T10:00:44.261Z" },
    { event: "command", layer: "page", name: "core.project.open", ts: "2026-10-01T10:00:44.236Z" },
  ];
  assert.equal(openStages(rows), "action project.open@0ms, layout 1 queued@1373ms, command core.project.open@11308ms");
  assert.equal(openStages([]), "no page trace rows");
});

test("the system state names the load average and the processes that use the most CPU", () => {
  const state = systemState();
  assert.match(state, /^load average \d+\.\d \d+\.\d \d+\.\d on \d+ processors; top CPU: \S/);
  assert.equal(state.split("top CPU: ")[1].split("; ").length, 5);
});
