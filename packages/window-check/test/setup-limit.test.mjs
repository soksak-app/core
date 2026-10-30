import assert from "node:assert/strict";
import test from "node:test";

import { withSetupLimit } from "../session.mjs";

test("a global setup that does not settle within its limit rejects with its name and its limit", async () => {
  await assert.rejects(withSetupLimit("probe setup", 100, () => new Promise(() => {})),
    /^Error: global setup probe setup exceeded its limit of 100 ms$/);
});

test("a global setup that settles within its limit resolves with its value", async () => {
  assert.equal(await withSetupLimit("probe setup", 1000, async () => 7), 7);
});
