// A frontmost change during a check is not a criterion of the check result: the session finish neither reads nor changes
// the frontmost application (F292-39).
import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";

const root = realpathSync(mkdtempSync(join(tmpdir(), "soksak-session-frontmost-")));
// The sequential-run lock of the harness is placed in this folder instead of the shared temporary folder.
process.env.TMPDIR = root;
delete process.env.SOKSAK_RUN_ID;
delete process.env.SOKSAK_RUN_FOLDER;
delete process.env.SOKSAK_APP;
// The earlier harness read a session baseline from this variable; the current harness ignores it.
process.env.SOKSAK_WINDOW_CHECK_BASELINE = JSON.stringify({ pid: 10, name: "another application", bundle: "org.example.another" });

const binary = join(root, "probe-binary");
writeFileSync(binary, "");
const host = 20;
// The application that is frontmost when the check starts is another application (10); during the check a different
// application (30) becomes frontmost.
const frontmostReads = [];
const activations = [];
const identity = (pid) => pid === 10
  ? { pid, name: "another application", bundle: "org.example.another" }
  : { pid, name: "a different application", bundle: `org.example.app-${pid}` };

mock.module("node:child_process", {
  namedExports: {
    ...childProcess,
    execFileSync(command, args, options) {
      if (command !== "osascript") return childProcess.execFileSync(command, args, options);
      const [script, input] = [args[3], JSON.parse(args[4])];
      if (script.includes("frontmostApplication")) {
        frontmostReads.push(script);
        return JSON.stringify(identity(frontmostReads.length === 1 ? 10 : 30));
      }
      if (script.includes("activateWithOptions")) {
        activations.push(input.pid);
        return "true";
      }
      if (script.includes("runningApplicationWithProcessIdentifier")) return JSON.stringify(identity(input.pid));
      throw new Error(`unexpected osascript call: ${script}`);
    },
  },
});
mock.module("../pasteboard.mjs", {
  namedExports: { readPasteboard: () => ({ items: [] }), writePasteboard: () => [], restoreFailure: () => null },
});
mock.module("../event-log.mjs", {
  namedExports: { readEventErrors: () => ({ errors: [] }), sessionEventBoot: () => 0, sessionEventStart: () => ({}) },
});
class EndpointError extends Error {}
mock.module("@soksak/client", {
  namedExports: {
    EndpointError,
    connect: async () => ({
      endpoint: { pid: host, application: "wailsv3", executable: binary, started: new Date(Date.now() + 60_000).toISOString() },
      close() {},
      request: async () => null,
    }),
  },
});
const { open } = await import("../app.mjs");

test("a frontmost change to another application during a check does not reject the check result", async (t) => {
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const afters = [];
  const check = { name: "probe check", passed: true, diagnostic() {}, after: (fn) => afters.push(fn) };
  await open(check, { name: "wailsv3", binary, configDir: join(root, "config") });
  assert.equal(afters.length, 1);
  await afters[0]();
  assert.deepEqual({ frontmostReads: frontmostReads.length, activations }, { frontmostReads: 0, activations: [] });
});
