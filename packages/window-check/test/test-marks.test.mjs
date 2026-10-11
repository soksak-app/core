// Checks that a window check marks the start and the end of a test in the log of the application when a run identifier is
// set, records each mark in marks.jsonl of the run folder, and does nothing without a run identifier.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { finishSession, Session } from "../app.mjs";

function fakeClient(positions) {
  const requests = [];
  return {
    requests,
    request: async (method, params) => {
      requests.push({ method, ...params });
      if (method !== "diagnostics.test.mark") throw new Error(`unexpected ${method}`);
      return positions.shift();
    },
  };
}

/** Runs body with the run variables set (or removed) and restores them afterwards. */
async function withRun(run, folder, body) {
  const saved = { id: process.env.SOKSAK_RUN_ID, folder: process.env.SOKSAK_RUN_FOLDER };
  const put = (key, value) => (value === undefined ? delete process.env[key] : (process.env[key] = value));
  put("SOKSAK_RUN_ID", run);
  put("SOKSAK_RUN_FOLDER", folder);
  try {
    return await body();
  } finally {
    put("SOKSAK_RUN_ID", saved.id);
    put("SOKSAK_RUN_FOLDER", saved.folder);
  }
}

const marks = (folder) => readFileSync(join(folder, "marks.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));

test("markTest sends the mark with the run identifier and appends its position to marks.jsonl", async (t) => {
  const folder = mkdtempSync(join(tmpdir(), "soksak-marks-"));
  t.after(() => rmSync(folder, { recursive: true }));
  const client = fakeClient([{ boot: "1-2", seq: 7 }, { boot: "1-2", seq: 9 }]);
  const session = new Session({ name: "fixture" }, client);
  await withRun("run-1", folder, async () => {
    assert.deepEqual(await session.markTest("start", "check a"), { boot: "1-2", seq: 7 });
    await session.markTest("end", "check a", "fail");
  });
  assert.deepEqual(client.requests.map(({ window, ...rest }) => rest), [
    { method: "diagnostics.test.mark", kind: "start", name: "check a", run: "run-1" },
    { method: "diagnostics.test.mark", kind: "end", name: "check a", run: "run-1", result: "fail" },
  ]);
  const lines = marks(folder);
  assert.deepEqual(lines.map(({ ts_us, ...rest }) => rest), [
    { run: "run-1", app: "fixture", name: "check a", kind: "start", boot: "1-2", seq: 7 },
    { run: "run-1", app: "fixture", name: "check a", kind: "end", boot: "1-2", seq: 9 },
  ]);
  assert.ok(lines.every((line) => Number.isInteger(line.ts_us) && line.ts_us > 1e15), JSON.stringify(lines));
});

test("markTest does nothing without a run identifier", async (t) => {
  const folder = mkdtempSync(join(tmpdir(), "soksak-marks-"));
  t.after(() => rmSync(folder, { recursive: true }));
  const client = fakeClient([]);
  const session = new Session({ name: "fixture" }, client);
  await withRun(undefined, folder, async () => {
    assert.equal(await session.markTest("start", "check a"), null);
  });
  assert.equal(client.requests.length, 0);
  assert.equal(existsSync(join(folder, "marks.jsonl")), false);
});

test("a run identifier without a run folder is an error", async () => {
  const session = new Session({ name: "fixture" }, fakeClient([{ boot: "b", seq: 1 }]));
  await withRun("run-1", undefined, async () => {
    await assert.rejects(session.markTest("start", "check a"), /SOKSAK_RUN_FOLDER/);
  });
});

/** A configuration folder whose event log holds only log.open, so the error audit of finishSession finds nothing. */
function configWithLog(folder) {
  const config = join(folder, "config");
  mkdirSync(join(config, "logs"), { recursive: true });
  writeFileSync(join(config, "logs", "host-1-1.jsonl"),
    `${JSON.stringify({ ts_us: 1791000000000000, seq: 1, level: "info", layer: "host", event: "log.open", fields: { schema: 2 } })}\n`);
  return config;
}

for (const [passed, result] of [[true, "pass"], [false, "fail"]]) {
  test(`finishSession marks the end after the cleanups as ${result} when the check body ${passed ? "passed" : "failed"}`, async (t) => {
    const folder = mkdtempSync(join(tmpdir(), "soksak-marks-"));
    t.after(() => rmSync(folder, { recursive: true }));
    const client = fakeClient([{ boot: "b", seq: 3 }]);
    const session = new Session({ name: "fixture", configDir: configWithLog(folder) }, client);
    const order = [];
    session.cleanup(() => order.push("cleanup"));
    session.eventStart = {};
    session.recordingsBefore = [];
    const probe = { name: "check a", passed, diagnostic() {} };
    await withRun("run-1", folder, async () => {
      await finishSession(probe, session, () => order.push("close"));
    });
    assert.deepEqual(order, ["cleanup", "close"]);
    assert.equal(client.requests.at(-1).result, result);
    assert.equal(marks(folder)[0].kind, "end");
  });
}
