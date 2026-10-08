// A request for a page file that does not exist writes one error line for each path (docs/spec/diagnostics.md).
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { readErrors, readOffset } from "@soksak/window-check/application-log.mjs";
import { fresh } from "./fixture.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: a request for a missing page file writes one error line for each path`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const first = `/missing-${process.pid}-first.js`;
    const second = `/missing-${process.pid}-second.js`;
    s.expectError(new RegExp(`^error: page asset: /missing-${process.pid}-(first|second)\\.js: not found$`));
    const before = readOffset(app.configDir);
    // The page requests each file twice; the host reports a path once.
    for (const path of [first, second, first]) {
      assert.equal((await s.request("diagnostics.page.request", { path })).path, path);
    }
    const { errors } = readErrors(app.configDir, before);
    assert.deepEqual(errors.filter((line) => line.includes(`missing-${process.pid}`)).sort(), [
      `error: page asset: ${first}: not found`,
      `error: page asset: ${second}: not found`,
    ]);
  });
}
