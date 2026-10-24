import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runNormalShutdown } from "../normal-shutdown-runner.mjs";

function fixture() {
  const configDir = mkdtempSync(join(tmpdir(), "normal-shutdown-audit-"));
  const logs = join(configDir, "logs");
  mkdirSync(logs);
  writeFileSync(join(configDir, "endpoint.json"), "{}\n");
  const log = join(logs, "host-100-200.jsonl");
  writeFileSync(log, `${JSON.stringify({ seq: 1, level: "info", layer: "host", event: "log.open", fields: {} })}\n`);
  return { configDir, log };
}

test("normal shutdown rejects an application error written by the controlled host during quit", async () => {
  const { configDir, log } = fixture();
  let clientClosed = false;
  const client = {
    endpoint: { pid: 200 },
    request: async (method, params) => {
      assert.equal(method, "command.run");
      assert.equal(params.name, "host.quit");
      appendFileSync(log, `${JSON.stringify({ seq: 2, level: "error", layer: "host", event: "host.record.error", fields: { where: "shutdown", text: "quit failed" } })}\n`);
      return null;
    },
    close: () => { clientClosed = true; },
  };
  try {
    await assert.rejects(runNormalShutdown({
      app: { name: "wailsv3", configDir },
      connectClient: async () => client,
      waitForFilesystem: async (_label, predicate) => assert.equal(predicate(), true),
      waitForReady: async () => {},
      waitForShutdown: async () => ({ closedMs: 1 }),
      env: {},
      write: () => {},
    }), /wailsv3: the application logged 1 error during shutdown:\nerror host shutdown: quit failed/);
    assert.equal(clientClosed, true, "the endpoint client stays open after shutdown audit failure");
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("normal shutdown ignores an application error written before the audit offset", async () => {
  const { configDir, log } = fixture();
  appendFileSync(log, `${JSON.stringify({ seq: 2, level: "error", layer: "host", event: "host.record.error", fields: { where: "earlier", text: "old failure" } })}\n`);
  let quitCalls = 0;
  const client = {
    endpoint: { pid: 200 },
    request: async (method, params) => {
      assert.equal(method, "command.run");
      assert.equal(params.name, "host.quit");
      quitCalls += 1;
      return null;
    },
    close: () => {},
  };
  try {
    const result = await runNormalShutdown({
      app: { name: "wailsv3", configDir },
      connectClient: async () => client,
      waitForFilesystem: async (_label, predicate) => assert.equal(predicate(), true),
      waitForReady: async () => {},
      waitForShutdown: async () => ({ closedMs: 1 }),
      env: {},
      write: () => {},
    });
    assert.equal(result.appName, "wailsv3");
    assert.equal(quitCalls, 1, "the direct host quit request ran once");
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});
