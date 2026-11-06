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
  assert.deepEqual(harness.requiredApps({}), ["wailsv3", "tauriv2", "mygo"]);
});

test("requiredApps covers only the application that SOKSAK_APP names", () => {
  assert.deepEqual(harness.requiredApps({ SOKSAK_APP: "tauriv2" }), ["tauriv2"]);
});

test("requiredApps accepts mygo as SOKSAK_APP", () => {
  assert.deepEqual(harness.requiredApps({ SOKSAK_APP: "mygo" }), ["mygo"]);
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

test("requiresAll is true only when the required set holds every application", () => {
  assert.equal(harness.requiresAll({}), true);
  assert.equal(harness.requiresAll({ SOKSAK_APP: "wailsv3" }), false);
  assert.equal(harness.requiresAll({ SOKSAK_APP: "tauriv2" }), false);
  assert.equal(harness.requiresAll({ SOKSAK_APP: "mygo" }), false);
});

test("requiresAll holds only for a set that covers the mygo application", () => {
  assert.ok(harness.requiredApps({}).includes("mygo"), "the session without SOKSAK_APP does not cover mygo");
  assert.equal(harness.requiresAll({}), true);
});

test("APP_NAMES names the three applications that SOKSAK_APP may name", () => {
  assert.deepEqual(harness.APP_NAMES, ["wailsv3", "tauriv2", "mygo"]);
});

let fresh = 0;
/** Imports app.mjs again under SOKSAK_APP set to the value, so that APPS and MAIN_PAGE_APPS are computed for it. */
const appsUnder = (value) => withSet(value, () => import(`../app.mjs?main-page=${++fresh}`));

test("MAIN_PAGE_APPS holds the session applications that have a main page", async () => {
  const names = async (value) => (await appsUnder(value)).MAIN_PAGE_APPS.map((app) => app.name);
  assert.deepEqual(await names(undefined), ["wailsv3", "tauriv2"]);
  assert.deepEqual(await names("tauriv2"), ["tauriv2"]);
  assert.deepEqual(await names("mygo"), []);
});

test("MAIN_PAGE_APPS holds the same application objects as APPS", async () => {
  const module = await appsUnder(undefined);
  for (const app of module.MAIN_PAGE_APPS) assert.equal(app, module.APPS[app.name]);
});

test("the processes of the run are the applications of the root that hold an endpoint, checked or not", async () => {
  const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "soksak-run-processes-"));
  try {
    for (const [name, pid] of [["wailsv3", 101], ["mygo", 303]]) {
      mkdirSync(join(root, `soksak-check-${name}`));
      writeFileSync(join(root, `soksak-check-${name}`, "endpoint.json"), JSON.stringify({ pid }));
    }
    // tauriv2 has a folder without an endpoint: it has not started, so it has no process.
    mkdirSync(join(root, "soksak-check-tauriv2"));
    assert.deepEqual(harness.runProcesses({ SOKSAK_CONFIG_ROOT: root, SOKSAK_APP: "mygo" }), [101, 303]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
