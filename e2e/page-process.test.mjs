// The end of the WebContent process of a window is written to the event log (docs/spec/diagnostics.md).
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { readEventLines } from "@soksak/window-check/event-log.mjs";
import { fresh } from "./fixture.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: the end of the web content process is written to the event log`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const { pageProcess } = await s.get("host.window");
    assert.ok(Number.isInteger(pageProcess) && pageProcess > 0, `host.window reports no page process: ${pageProcess}`);
    s.expectError(/^error host page process: main: terminated$/);
    process.kill(pageProcess, "SIGKILL");
    // The window loads its page again in a new process.
    await s.until("host.window", (window) => window.pageProcess !== pageProcess, "the window kept the ended page process");
    // The ready value of the ended page stays until the new page requests its start document, which marks the window not
    // ready; the new page marks it ready again when it has drawn.
    await s.until("host.windows", (list) => list.some((window) => !window.ready), "the new page did not start");
    await s.windows(1, "the window did not load its page again");
    // The log keeps the lines of earlier runs; this check reads from the position where it started.
    await s.flushLog();
    const { lines } = readEventLines(s.app.configDir, s.eventStart);
    assert.equal(lines.filter((line) => line === "error host page process: main: terminated").length, 1,
      "the event log does not hold one record for the end of the page process");
  });
}
