// An application whose main document does not reply to a request and to one probe after it is recorded as not replying in its
// configuration folder, and every later check of that application fails at once with that record instead of waiting for its own
// timeouts (F351).
import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import { EndpointError } from "@soksak/client";

delete process.env.SOKSAK_APP;
delete process.env.SOKSAK_RUN_ID;
delete process.env.SOKSAK_RUN_FOLDER;

mock.module("node:child_process", {
  namedExports: {
    ...childProcess,
    execFile(command, args, options, callback) {
      if (command === "/bin/launchctl") {
        queueMicrotask(() => callback(null, "pid/20 = {\n}\n", ""));
        return;
      }
      if (command !== "/usr/bin/sample") throw new Error(`unexpected execFile: ${command}`);
      queueMicrotask(() => callback(null, "", ""));
    },
  },
});
mock.module("../event-log.mjs", {
  namedExports: { readEventErrors: () => ({ errors: [] }), sessionEventBoot: () => 0, sessionEventStart: () => ({}) },
});
const { open, Session } = await import("../app.mjs");

const silent = () => Promise.reject(new EndpointError({ code: 1006, message: "the document did not reply within 10000 ms" }));

test("a document that does not reply to a request and to the probe after it makes the later checks of its application fail at once", async (t) => {
  const configDir = mkdtempSync(join(tmpdir(), "soksak-unresponsive-"));
  t.after(() => rmSync(configDir, { recursive: true, force: true }));
  const app = { name: "wailsv3", binary: process.execPath, configDir };
  const client = {
    endpoint: { pid: 20 },
    request: (method) => (method === "diagnostics.stall.dump" ? Promise.resolve({ boot: "b1", seq: 4 }) : silent()),
  };
  const session = new Session(app, client);
  session.check = "probe check";
  await assert.rejects(session.get("core.settings"), (error) => {
    assert.match(error.message, /the document did not reply within 10000 ms/);
    assert.match(error.message, /wailsv3 does not reply to a probe either, so its later checks fail at once/);
    return true;
  });
  const record = JSON.parse(readFileSync(join(configDir, "unresponsive.json"), "utf8"));
  assert.equal(record.check, "probe check");
  assert.equal(record.request, "wailsv3 status.get core.settings");
  await assert.rejects(session.get("core.workbench.error"),
    /^Error: wailsv3 stopped replying in the check "probe check" at wailsv3 status\.get core\.settings, so this request is not sent; /);
  await assert.rejects(open({ name: "a later check" }, app),
    /^Error: wailsv3 stopped replying in the check "probe check" at wailsv3 status\.get core\.settings, so this check does not run; /);
});

test("a document that replies to the probe after a timeout leaves no record", async (t) => {
  const configDir = mkdtempSync(join(tmpdir(), "soksak-unresponsive-"));
  t.after(() => rmSync(configDir, { recursive: true, force: true }));
  let first = true;
  const client = {
    endpoint: { pid: 20 },
    request(method) {
      if (method === "diagnostics.stall.dump") return Promise.resolve({ boot: "b1", seq: 4 });
      if (first) { first = false; return silent(); }
      return Promise.resolve(null);
    },
  };
  const session = new Session({ name: "wailsv3", binary: process.execPath, configDir }, client);
  session.check = "probe check";
  await assert.rejects(session.get("core.settings"), /the document did not reply within 10000 ms/);
  assert.equal(existsSync(join(configDir, "unresponsive.json")), false);
});
