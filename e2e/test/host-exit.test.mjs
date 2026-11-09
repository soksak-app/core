// An application whose host process exited fails one check with the exit and the last records of its log, and every later check
// of that application is reported as not run because of that exit; the check never starts the application again, which would hide
// the exit.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { open } from "@soksak/window-check/app.mjs";

delete process.env.SOKSAK_APP;

/** A configuration folder whose endpoint.json names a host process that is gone, with the log that the process wrote. */
function exitedHost(t) {
  const configDir = mkdtempSync(join(tmpdir(), "soksak-exited-host-"));
  t.after(() => rmSync(configDir, { recursive: true, force: true }));
  const { pid } = spawnSync(process.execPath, ["-e", ""]);
  writeFileSync(join(configDir, "endpoint.json"), JSON.stringify({ address: join(configDir, "sok.sock"), pid, transport: "unix" }));
  mkdirSync(join(configDir, "logs"));
  const record = (seq, level, event, fields) => JSON.stringify({ ts_us: 1794212561708833 + seq, seq, level, class: "lifecycle", layer: "host", event, fields });
  writeFileSync(join(configDir, "logs", `host-1794212313-${pid}.jsonl`), [
    record(5403, "info", "workbench.start", { url: "wails://localhost/" }),
    record(5404, "info", "log.closed", { cause: "update" }),
    record(5413, "info", "log.closed", { cause: "exit-request" }),
    record(5416, "info", "log.closed", { cause: "last-window-closed" }),
    record(5417, "error", "host.record.error", { text: "the main webview is not in the window hierarchy", where: "main webview identity" }),
    record(5418, "info", "log.gated", { class: "lifecycle", level: "info", count: 6 }),
  ].join("\n") + "\n");
  return { app: { name: "wailsv3", binary: process.execPath, configDir }, pid };
}

test("the first check of an application whose process exited fails with the exit and the last records of its log", async (t) => {
  const { app, pid } = exitedHost(t);
  const skipped = [];
  await assert.rejects(open({ name: "the first check", skip: (reason) => skipped.push(reason) }, app), (error) => {
    assert.match(error.message, new RegExp(`^wailsv3 process ${pid} exited before the check "the first check", so nothing was measured`));
    assert.match(error.message, /seq 5404 log\.closed cause update; seq 5413 log\.closed cause exit-request; seq 5416 log\.closed cause last-window-closed; seq 5417 host\.record\.error the main webview is not in the window hierarchy \(main webview identity\)/);
    assert.doesNotMatch(error.message, /workbench\.start|log\.gated/);
    return true;
  });
  assert.deepEqual(skipped, []);
  const record = JSON.parse(readFileSync(join(app.configDir, "exited.json"), "utf8"));
  assert.equal(record.check, "the first check");
  assert.equal(record.pid, pid);
});

test("every later check of an application whose process exited is reported as not run because of that exit", async (t) => {
  const { app, pid } = exitedHost(t);
  await assert.rejects(open({ name: "the first check", skip() {} }, app));
  const skipped = [];
  await assert.rejects(open({ name: "a later check", skip: (reason) => skipped.push(reason) }, app), (error) => {
    assert.equal(error.message, skipped[0]);
    return true;
  });
  assert.equal(skipped.length, 1);
  assert.match(skipped[0], new RegExp(`^not run: wailsv3 process ${pid} exited, found by the check "the first check"; `));
  assert.match(skipped[0], /seq 5417 host\.record\.error the main webview is not in the window hierarchy/);
  assert.equal(existsSync(join(app.configDir, "exited.json")), true);
});
