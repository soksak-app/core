// The window events check judges the window that it opens by a state that the windows of other applications do not change
// (docs/spec/hosts.md#launch-activation). This test holds that judgment without a window.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { EVERY_LEVEL } from "@soksak/window-check/log-policy.mjs";
import { openAndCloseWindow } from "../window-events.mjs";

const line = (seq, level, layer, event, fields) =>
  `${JSON.stringify({ ts_us: 1791500000000000 + seq, mono_ns: 1000 + seq, seq, level, class: "lifecycle", layer, event, fields })}\n`;

test("a window that other windows cover completely still opens, draws and leaves its close event", { timeout: 5000 }, async () => {
  const configDir = mkdtempSync(join(tmpdir(), "window-events-"));
  try {
    mkdirSync(join(configDir, "logs"));
    writeFileSync(join(configDir, "log-policy.json"), JSON.stringify({ schema: 1, classes: EVERY_LEVEL }));
    const log = join(configDir, "logs", "host-1791500000-10.jsonl");
    writeFileSync(log, line(1, "info", "host", "log.open", { schema: 3, pid: 10, role: "host", boot: "1791500000-10" }));
    const calls = [];
    const child = {
      // The new window opens behind the windows of other applications, so its occlusion never turns visible.
      get: async () => ({ occluded: true }),
      presented: async () => { calls.push("presented"); return { displayed: 1 }; },
      close: async () => {
        calls.push("close");
        appendFileSync(log, line(2, "info", "host", "host.window.event", { window: "w2", kind: "closed" }));
      },
    };
    const s = {
      app: { configDir },
      window: "main",
      run: async (name) => { calls.push(name); return null; },
      windows: async () => [{ window: "main", ready: true }, { window: "w2", ready: true }],
      on: (window) => { assert.equal(window, "w2"); return child; },
      flushLog: async () => {},
    };
    const closed = await openAndCloseWindow(s);
    assert.match(closed, /^info host host.window.event: .*"window":"w2".*"kind":"closed"/);
    assert.deepEqual(calls, ["core.window.new", "presented", "close"], "the window draws its frames before it closes");
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});
