// A request for a page file that does not exist writes one error line for each path (docs/spec/diagnostics.md).
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { currentEventOffsets, untilEventLines } from "@soksak/window-check/event-log.mjs";
import { fresh, reading } from "./fixture.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: a request for a missing page file writes one error line for each path`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const first = `/missing-${process.pid}-first.js`;
    const second = `/missing-${process.pid}-second.js`;
    s.expectError(new RegExp(`^error host page asset: /missing-${process.pid}-(first|second)\\.js: not found$`));
    const before = currentEventOffsets(app.configDir);
    // The page requests each file twice; the host reports a path once.
    for (const path of [first, second, first]) {
      const answer = await s.request("diagnostics.page.request", { path });
      assert.equal(answer.path, path);
      // The start document does not answer a missing file; the status is the error of the host's file server.
      assert.ok(answer.status >= 400, `${path} was answered with status ${answer.status}`);
    }
    // The error records reach the file at the next batch of the writer, so the check waits for both of them.
    const lines = await untilEventLines(app.configDir, before,
      (all) => all.filter((line) => line.startsWith("error ") && line.includes(`missing-${process.pid}`)).length >= 2, 10000,
      reading(app, ["host.record.error"]));
    const errors = lines.filter((line) => line.startsWith("error "));
    assert.deepEqual(errors.filter((line) => line.includes(`missing-${process.pid}`)).sort(), [
      `error host page asset: ${first}: not found`,
      `error host page asset: ${second}: not found`,
    ]);
  });
}
