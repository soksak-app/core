// The readiness waits of the agent layout runs (scripts/agent-layout-ready.mjs, F959-4). The tests run real processes and real files.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readyWindow, waitForEndpoint, waitForReady } from "../agent-layout-ready.mjs";

test("the endpoint wait resolves when the endpoint file is created after the wait starts", async () => {
  const config = mkdtempSync(join(tmpdir(), "ready-endpoint-"));
  setTimeout(() => writeFileSync(join(config, "endpoint.json"), "{}"), 100);
  await waitForEndpoint(config);
});

test("the endpoint wait resolves at once when the endpoint file exists already", async () => {
  const config = mkdtempSync(join(tmpdir(), "ready-existing-"));
  writeFileSync(join(config, "endpoint.json"), "{}");
  await waitForEndpoint(config);
});

test("a window that is not ready does not end the readiness wait, and the ready window does", async () => {
  assert.equal(readyWindow([{ window: "main", ready: false }]), null);
  assert.equal(readyWindow([{ window: "main", ready: false }, { window: "second", ready: true }]), "second");
  // The status watch prints the list once per change: the first line is not ready, the second line is ready.
  const script = `
    const out = (windows) => process.stdout.write(JSON.stringify(windows) + "\\n");
    out([{ window: "main", ready: false }]);
    setTimeout(() => { out([{ window: "main", ready: true }]); setInterval(() => {}, 1000); }, 100);
  `;
  assert.equal(await waitForReady(process.execPath, ["-e", script]), "main");
});

test("the readiness wait rejects when the status watch ends before a window is ready", async () => {
  const script = `process.stdout.write(JSON.stringify([{ window: "main", ready: false }]) + "\\n"); process.exit(3);`;
  await assert.rejects(waitForReady(process.execPath, ["-e", script]), /ended with 3 before a window was ready/);
});
