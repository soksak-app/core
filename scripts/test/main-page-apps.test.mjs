// MAIN_PAGE_APPS of the window-check module lists the applications that have a main page. An application has a main page
// when its environment.json names the runtime that serves the page; the window checks of the main page and of modal web
// views iterate MAIN_PAGE_APPS (docs/operations/examples.md#window-checks), so a list that differs from the applications
// leaves a main page unchecked or checks a page that an application does not have.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const ROOT = new URL("../../", import.meta.url);

test("MAIN_PAGE_APPS lists the applications whose environment.json names a runtime", async () => {
  // Without SOKSAK_APP the session holds the default applications, so MAIN_PAGE_APPS is complete for them.
  delete process.env.SOKSAK_APP;
  const { APP_NAMES, APPS, MAIN_PAGE_APPS } = await import("@soksak/window-check/app.mjs");
  const environment = (name) => new URL(`apps/${name}/environment.json`, ROOT);
  const withRuntime = APP_NAMES.filter((name) => Object.hasOwn(APPS, name))
    .filter((name) => existsSync(environment(name)) && Object.hasOwn(JSON.parse(readFileSync(environment(name), "utf8")), "runtime"));
  assert.deepEqual(MAIN_PAGE_APPS.map((app) => app.name), withRuntime);
});
