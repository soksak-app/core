import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
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

test("no-terminal shutdown refuses a sidecar session before requesting quit", { timeout: 2000 }, async () => {
  const { configDir } = fixture();
  const sessions = [{ sidecar: "vt-alacritty", surface: "tab-terminal" }];
  let quitRequested = false;
  const client = {
    endpoint: { pid: 200 },
    request: async (method, params) => {
      if (method === "diagnostics.objects") {
        assert.deepEqual(params, { window: "main" });
        return { sessions };
      }
      if (method === "command.run" && params.name === "host.quit") {
        quitRequested = true;
        return null;
      }
      throw new Error(`unexpected request ${method} ${JSON.stringify(params)}`);
    },
    close() {},
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
    }), /no-terminal shutdown precondition failed: sidecar sessions=/);
    assert.equal(quitRequested, false, "the runner requests quit before rejecting the live sidecar session");
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("no-terminal shutdown refuses a persistent service endpoint without a session", { timeout: 2000 }, async () => {
  const { configDir } = fixture();
  const serviceDirectory = join(configDir, "services", "vt-alacritty");
  mkdirSync(serviceDirectory, { recursive: true });
  const endpointFile = join(serviceDirectory, "endpoint.json");
  writeFileSync(endpointFile, `${JSON.stringify({ protocol: 1, pid: 321, socket: "unused", token: "unused" })}\n`);
  let quitRequested = false;
  const client = {
    endpoint: { pid: 200 },
    request: async (method, params) => {
      if (method === "diagnostics.objects") return { sessions: [] };
      if (method === "command.run" && params.name === "host.quit") {
        quitRequested = true;
        return null;
      }
      throw new Error(`unexpected request ${method} ${JSON.stringify(params)}`);
    },
    close() {},
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
    }), (error) => {
      assert.match(error.message, /no-terminal shutdown precondition failed/);
      assert.ok(error.message.includes(endpointFile), `the error does not name ${endpointFile}: ${error.message}`);
      return true;
    });
    assert.equal(quitRequested, false, "the runner requests quit before rejecting the service endpoint");
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("no-terminal shutdown records the empty session and endpoint precondition", { timeout: 2000 }, async () => {
  const { configDir } = fixture();
  const client = {
    endpoint: { pid: 200 },
    request: async (method, params) => {
      if (method === "diagnostics.objects") {
        assert.deepEqual(params, { window: "main" });
        return { sessions: [] };
      }
      if (method === "command.run" && params.name === "host.quit") return null;
      throw new Error(`unexpected request ${method} ${JSON.stringify(params)}`);
    },
    close() {},
  };
  const lines = [];
  try {
    await runNormalShutdown({
      app: { name: "wailsv3", configDir },
      connectClient: async () => client,
      waitForFilesystem: async (_label, predicate) => assert.equal(predicate(), true),
      waitForReady: async () => {},
      waitForShutdown: async () => ({ closedMs: 1 }),
      env: {},
      write: (line) => lines.push(line),
    });
    assert.ok(lines.includes("PRECONDITION normal-shutdown app=wailsv3 mode=no-terminal sidecar_sessions=0 service_endpoints=0"),
      `the empty no-terminal precondition was not recorded: ${JSON.stringify(lines)}`);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("no-terminal shutdown reports invalid diagnostic session metadata", { timeout: 2000 }, async () => {
  const { configDir } = fixture();
  let quitRequested = false;
  const client = {
    endpoint: { pid: 200 },
    request: async (method, params) => {
      if (method === "diagnostics.objects") return { sessions: null };
      if (method === "command.run" && params.name === "host.quit") {
        quitRequested = true;
        return null;
      }
      throw new Error(`unexpected request ${method} ${JSON.stringify(params)}`);
    },
    close() {},
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
    }), /diagnostics\.objects returned no sidecar session list/);
    assert.equal(quitRequested, false, "the runner requests quit after receiving invalid session metadata");
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("no-terminal shutdown reports a non-directory service entry", { timeout: 2000 }, async () => {
  const { configDir } = fixture();
  const serviceEntry = join(configDir, "services", "invalid-entry");
  mkdirSync(join(configDir, "services"));
  writeFileSync(serviceEntry, "invalid\n");
  const client = {
    endpoint: { pid: 200 },
    request: async (method) => {
      if (method === "diagnostics.objects") return { sessions: [] };
      throw new Error(`unexpected request ${method}`);
    },
    close() {},
  };
  try {
    await assert.rejects(runNormalShutdown({
      app: { name: "wailsv3", configDir },
      connectClient: async () => client,
      waitForFilesystem: async (_label, predicate) => assert.equal(predicate(), true),
      waitForReady: async () => {},
      env: {},
      write: () => {},
    }), (error) => {
      assert.equal(error.message, `${serviceEntry} is not a service directory`);
      return true;
    });
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("normal shutdown rejects an application error written by the controlled host during quit", async () => {
  const { configDir, log } = fixture();
  let clientClosed = false;
  const client = {
    endpoint: { pid: 200 },
    request: async (method, params) => {
      if (method === "diagnostics.objects") return { sessions: [] };
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
      if (method === "diagnostics.objects") return { sessions: [] };
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
    request: async (method, params) => {
      if (method === "diagnostics.objects") return { sessions: [] };
      assert.equal(method, "command.run");
      assert.equal(params.name, "host.quit");
      return null;
    },
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

test("normal shutdown closes the application client when the shutdown wait fails", async () => {
  const { configDir } = fixture();
  const serviceEndpoint = join(configDir, "services", "terminal", "endpoint.json");
  mkdirSync(join(configDir, "services", "terminal"), { recursive: true });
  writeFileSync(serviceEndpoint, `${JSON.stringify({ protocol: 1, pid: 321, socket: "unused", token: "unused" })}\n`);
  const clients = [];
  const connectClient = async () => {
    const client = {
      endpoint: { pid: 200 },
      request: async () => null,
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
    assert.equal(clients.length, 1, "shutdown does not open a terminal-service observer connection");
    assert.deepEqual(clients.map((client) => client.closed), [true], "the endpoint client closes after a shutdown failure");
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("terminal shutdown fails when endpoint EOF precedes a service process timeout", async () => {
  const { configDir } = fixture();
  const serviceDirectory = join(configDir, "services", "terminal");
  mkdirSync(serviceDirectory, { recursive: true });
  writeFileSync(join(serviceDirectory, "endpoint.json"), `${JSON.stringify({ protocol: 1, pid: 321, socket: "unused", token: "unused" })}\n`);
  const clients = [];
  const connectClient = async () => {
    const client = {
      endpoint: { pid: 200 },
      request: async () => null,
      ended: Promise.resolve(),
      close() {},
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
      waitForShutdown: async () => ({ closedMs: 1 }),
      waitForServiceProcess: async () => { throw new Error("controlled service process wait timeout"); },
      env: { SOKSAK_SHUTDOWN_TERMINAL: "1" },
      write: () => {},
    }), /controlled service process wait timeout/);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("terminal shutdown rejects a service endpoint that remains after PID observation", async () => {
  const { configDir } = fixture();
  const serviceDirectory = join(configDir, "services", "terminal");
  mkdirSync(serviceDirectory, { recursive: true });
  const serviceEndpoint = join(serviceDirectory, "endpoint.json");
  writeFileSync(serviceEndpoint, `${JSON.stringify({ protocol: 1, pid: 321, socket: "unused", token: "unused" })}\n`);
  const client = { endpoint: { pid: 200 }, request: async () => null, close() {} };
  try {
    await assert.rejects(runNormalShutdown({
      app: { name: "wailsv3", configDir },
      connectClient: async () => client,
      waitForFilesystem: async (_label, predicate) => assert.equal(predicate(), true),
      waitForReady: async () => {},
      prepareTerminal: async () => ({ surface: "tab-terminal", sessionId: "session-terminal" }),
      waitForShutdown: async () => ({ closedMs: 1 }),
      waitForServiceProcess: async ({ pid }) => assert.equal(pid, 321),
      env: { SOKSAK_SHUTDOWN_TERMINAL: "1" },
      write: () => {},
    }), /services\/terminal\/endpoint.json remains after service PID 321 ended/);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("terminal shutdown names an invalid service endpoint and rejects its PID", async () => {
  const { configDir } = fixture();
  const serviceDirectory = join(configDir, "services", "terminal");
  mkdirSync(serviceDirectory, { recursive: true });
  const serviceEndpoint = join(serviceDirectory, "endpoint.json");
  writeFileSync(serviceEndpoint, `${JSON.stringify({ protocol: 2, pid: -1 })}\n`);
  const client = { endpoint: { pid: 200 }, request: async () => null, close() {} };
  try {
    await assert.rejects(runNormalShutdown({
      app: { name: "wailsv3", configDir },
      connectClient: async () => client,
      waitForFilesystem: async (_label, predicate) => assert.equal(predicate(), true),
      waitForReady: async () => {},
      prepareTerminal: async () => ({ surface: "tab-terminal", sessionId: "session-terminal" }),
      waitForShutdown: async () => { throw new Error("shutdown should not start"); },
      env: { SOKSAK_SHUTDOWN_TERMINAL: "1" },
      write: () => {},
    }), (error) => error.message === `${serviceEndpoint} must contain protocol 1 and a positive int32 pid`);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("service process wait reaps its observer after the outer deadline", async () => {
  const { runSokProcessWait } = await import("../normal-shutdown-runner.mjs");
  let killSignals = 0;
  const child = new EventEmitter();
  let closed = false;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    killSignals += 1;
    setImmediate(() => {
      closed = true;
      child.emit("close", null, "SIGTERM");
    });
  };
  const configDir = mkdtempSync(join(tmpdir(), "normal-shutdown-sok-"));
  const appDirectory = join(configDir, "MacOS");
  mkdirSync(appDirectory, { recursive: true });
  writeFileSync(join(appDirectory, "sok"), "", { mode: 0o755 });
  try {
    await assert.rejects(runSokProcessWait({
      binary: join(appDirectory, "Host"),
      configDir,
      pid: 321,
      timeoutMs: 1,
      outerLimitMs: 10,
      spawnChild: () => child,
    }), /exceeded 10ms/);
    assert.equal(killSignals, 1, "the observer receives termination at the outer deadline");
    assert.equal(closed, true, "the runner waits for the child close event before rejecting");
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("service process wait reports the bounded cleanup timeout before SIGKILL and reap", { timeout: 2000 }, async () => {
  const { runSokProcessWait } = await import("../normal-shutdown-runner.mjs");
  const signals = [];
  const child = new EventEmitter();
  let reaped = false;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = (signal) => {
    signals.push(signal);
    if (signal === "SIGKILL") {
      reaped = true;
      child.emit("close", null, signal);
    }
  };
  const configDir = mkdtempSync(join(tmpdir(), "normal-shutdown-sok-cleanup-timeout-"));
  const appDirectory = join(configDir, "MacOS");
  mkdirSync(appDirectory, { recursive: true });
  writeFileSync(join(appDirectory, "sok"), "", { mode: 0o755 });
  try {
    await assert.rejects(runSokProcessWait({
      binary: join(appDirectory, "Host"),
      configDir,
      pid: 321,
      timeoutMs: 1,
      outerLimitMs: 20,
      cleanupLimitMs: 20,
      spawnChild: () => child,
    }), (error) => {
      assert.ok(error instanceof AggregateError, `expected the wait and cleanup timeout causes, received ${error}`);
      assert.match(error.errors[0].message, /exceeded 20ms for service PID 321/);
      assert.match(error.errors[1].message, /cleanup wait exceeded 20ms after SIGTERM/);
      assert.match(error.message, /SIGKILL sent and observer child reaped/);
      return true;
    });
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"], "the observer receives SIGTERM, then SIGKILL after its bounded reap expires");
    assert.equal(reaped, true, "the runner waits for observer close after SIGKILL");
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("service process wait rejects malformed CLI output", async () => {
  const { runSokProcessWait } = await import("../normal-shutdown-runner.mjs");
  const configDir = mkdtempSync(join(tmpdir(), "normal-shutdown-sok-output-"));
  const appDirectory = join(configDir, "MacOS");
  mkdirSync(appDirectory, { recursive: true });
  writeFileSync(join(appDirectory, "sok"), "", { mode: 0o755 });
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  try {
    await assert.rejects(runSokProcessWait({
      binary: join(appDirectory, "Host"),
      configDir,
      pid: 321,
      spawnChild: () => {
        setImmediate(() => {
          child.stdout.write("not json");
          child.stdout.end();
          child.stderr.end();
          child.emit("close", 0, null);
        });
        return child;
      },
    }), /returned invalid JSON for service PID 321/);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("service process wait invokes the bundled CLI with the original PID", async () => {
  const { runSokProcessWait } = await import("../normal-shutdown-runner.mjs");
  const configDir = mkdtempSync(join(tmpdir(), "normal-shutdown-sok-success-"));
  const appDirectory = join(configDir, "MacOS");
  mkdirSync(appDirectory, { recursive: true });
  writeFileSync(join(appDirectory, "sok"), "", { mode: 0o755 });
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  try {
    await runSokProcessWait({
      binary: join(appDirectory, "Host"),
      configDir,
      pid: 321,
      timeoutMs: 700,
      spawnChild: (command, args, options) => {
        assert.equal(command, join(appDirectory, "sok"));
        assert.deepEqual(args, ["process", "wait", "321", "--timeout-ms", "700", "--config-dir", configDir]);
        assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
        setImmediate(() => {
          child.stdout.write('{"pid":321,"ended":true}\n');
          child.stdout.end();
          child.stderr.end();
          child.emit("close", 0, null);
        });
        return child;
      },
    });
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("normal shutdown reports client-close errors without hiding a shutdown failure", async () => {
  const { configDir } = fixture();
  const client = {
    endpoint: { pid: 200 },
    request: async (method, params) => {
      if (method === "diagnostics.objects") return { sessions: [] };
      assert.equal(method, "command.run");
      assert.equal(params.name, "host.quit");
      return null;
    },
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
