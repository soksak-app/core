import assert from "node:assert/strict";
import test from "node:test";

import * as harness from "../app.mjs";

// The missing executable is a path that does not exist, so the check cannot start the application.
const MISSING = "/nonexistent/soksak-required-apps/Application";

/** Runs a function with SOKSAK_APP set to the value, or unset when the value is undefined. */
async function withSet(value, run) {
  const saved = process.env.SOKSAK_APP;
  if (value === undefined) delete process.env.SOKSAK_APP;
  else process.env.SOKSAK_APP = value;
  try {
    return await run();
  } finally {
    if (saved === undefined) delete process.env.SOKSAK_APP;
    else process.env.SOKSAK_APP = saved;
  }
}

test("requiredApps covers every application when SOKSAK_APP is unset", () => {
  assert.deepEqual(harness.requiredApps({}), ["wailsv3", "tauriv2"]);
});

test("requiredApps covers only the application that SOKSAK_APP names", () => {
  assert.deepEqual(harness.requiredApps({ SOKSAK_APP: "tauriv2" }), ["tauriv2"]);
});

test("requiredApps rejects a SOKSAK_APP that names no application", () => {
  assert.throws(() => harness.requiredApps({ SOKSAK_APP: "electron" }), /unknown SOKSAK_APP: electron/);
});

test("open fails with an error that names the binary of a required application that is not built", async () => {
  await withSet("wailsv3", async () => {
    const app = { name: "wailsv3", binary: MISSING, configDir: "/nonexistent/config" };
    await assert.rejects(harness.open({ diagnostic() {} }, app), (error) => {
      assert.match(error.message, /does not exist/);
      assert.ok(error.message.includes(MISSING), error.message);
      return true;
    });
  });
});

test("open fails for a missing binary when SOKSAK_APP is unset and the application is in the default set", async () => {
  await withSet(undefined, async () => {
    const app = { name: "tauriv2", binary: MISSING, configDir: "/nonexistent/config" };
    await assert.rejects(harness.open({ diagnostic() {} }, app), (error) => error.message.includes(MISSING));
  });
});

test("open returns null without reading the binary of an application outside the set", async () => {
  await withSet("tauriv2", async () => {
    let read = false;
    const app = {
      name: "wailsv3",
      get binary() {
        read = true;
        return MISSING;
      },
      configDir: "/nonexistent/config",
    };
    assert.equal(await harness.open({ diagnostic() {} }, app), null);
    assert.equal(read, false);
  });
});
