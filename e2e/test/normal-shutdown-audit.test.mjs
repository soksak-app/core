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

test("normal shutdown retains an application error when the shutdown wait fails", async () => {
  const { configDir, log } = fixture();
  const client = {
    endpoint: { pid: 200 },
    request: async () => null,
    close() {},
  };
  try {
    await assert.rejects(runNormalShutdown({
      app: { name: "wailsv3", configDir },
      connectClient: async () => client,
      waitForFilesystem: async (_label, predicate) => assert.equal(predicate(), true),
      waitForReady: async () => {},
      waitForShutdown: async () => {
        appendFileSync(log, `${JSON.stringify({ seq: 2, level: "error", layer: "host", event: "host.record.error", fields: { where: "shutdown", text: "late quit failure" } })}\n`);
        throw new Error("controlled shutdown timeout");
      },
      env: {},
      write: () => {},
    }), (error) => {
      assert.ok(error instanceof AggregateError, `expected both failures, received ${error}`);
      assert.match(error.errors[0].message, /controlled shutdown timeout/);
      assert.match(error.errors[1].message, /application logged 1 error during shutdown/);
      assert.match(error.errors[1].message, /error host shutdown: late quit failure/);
      return true;
    });
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("normal shutdown closes both clients when the shutdown wait fails", async () => {
  const { configDir } = fixture();
  const serviceEndpoint = join(configDir, "services", "terminal", "endpoint.json");
  mkdirSync(join(configDir, "services", "terminal"), { recursive: true });
  writeFileSync(serviceEndpoint, "{}\n");
  const clients = [];
  const connectClient = async () => {
    const client = {
      endpoint: { pid: 200 },
      request: async () => null,
      ended: new Promise(() => {}),
      closed: false,
      close() { this.closed = true; },
    };
    clients.push(client);
    return client;
  };
  try {
    await assert.rejects(runNormalShutdown({
      app: { name: "wailsv3", configDir },
      connectClient,
      waitForFilesystem: async (_label, predicate) => assert.equal(predicate(), true),
      waitForReady: async () => {},
      prepareTerminal: async () => ({ surface: "tab-terminal", sessionId: "session-terminal" }),
      waitForShutdown: async () => { throw new Error("controlled shutdown timeout"); },
      env: { SOKSAK_SHUTDOWN_TERMINAL: "1" },
      write: () => {},
    }), /controlled shutdown timeout/);
    assert.equal(clients.length, 2);
    assert.deepEqual(clients.map((client) => client.closed), [true, true],
      "the endpoint and terminal-service clients both close after a shutdown failure");
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("normal shutdown reports client-close errors without hiding a shutdown failure", async () => {
  const { configDir } = fixture();
  const client = {
    endpoint: { pid: 200 },
    request: async () => null,
    close() { throw new Error("controlled client-close failure"); },
  };
  try {
    await assert.rejects(runNormalShutdown({
      app: { name: "wailsv3", configDir },
      connectClient: async () => client,
      waitForFilesystem: async (_label, predicate) => assert.equal(predicate(), true),
      waitForReady: async () => {},
      waitForShutdown: async () => { throw new Error("controlled shutdown failure"); },
      env: {},
      write: () => {},
    }), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors[0].message, "controlled shutdown failure");
      assert.match(error.errors[1].message, /could not close the application client: controlled client-close failure/);
      return true;
    });
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});
