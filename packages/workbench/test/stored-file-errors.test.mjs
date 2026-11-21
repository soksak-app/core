// Checks that the page lists the errors of the refused stored files of a workspace snapshot, so it shows each of them and
// starts (docs/spec/projects.md#settings).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

import { storedFileErrors } from "../host-store.js";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

test("a snapshot lists the error of a refused projects.json and of a refused settings.json", { timeout: 1000 }, () => {
  assert.deepEqual(storedFileErrors({ projects: [], common: {} }), []);
  assert.deepEqual(storedFileErrors({ projects: [], common: {}, projectsError: "p: projects.json: format must be 3" }),
    ["p: projects.json: format must be 3"]);
  assert.deepEqual(storedFileErrors({ projects: [], common: {}, projectsError: "p: bad", settingsError: "s: settings.json: format must be 1" }),
    ["p: bad", "s: settings.json: format must be 1"]);
});

test("the start document shows the errors of the refused stored files before the page draws", { timeout: 1000 }, () => {
  assert.match(html, /for \(const text of storedFileErrors\(start\.workspace\)\) showError\(text\);/);
  assert.ok(html.indexOf("installExposure(exposureFile);") < html.indexOf("storedFileErrors(start.workspace)"),
    "the start document displays errors before the toast command is declared");
});

test("the actual start document shows and exposes a dismissible failed workspace toast before the library starts", async (t) => {
  const dom = new JSDOM(html, { url: "http://localhost/" });
  const { window } = dom;
  const { document } = window;
  window.matchMedia = (query) => ({
    media: query, matches: true, addEventListener() {}, removeEventListener() {},
  });
  Object.assign(globalThis, {
    window, document, addEventListener: window.addEventListener.bind(window),
    getComputedStyle: window.getComputedStyle.bind(window), CSS: window.CSS,
    MouseEvent: window.MouseEvent, PointerEvent: window.PointerEvent,
  });
  t.after(() => dom.window.close());
  const { installExposure, registry } = await import("../exposure.js");
  const { rawConsole } = await import("../page-log.js");
  const { reportUncaught } = await import("../page-layout.js");
  const { installErrorExposure } = await import("../core-exposure.js");
  const error = "could not open the workspace";
  const log = t.mock.method(rawConsole, "error", () => {});
  const bindings = {
    installErrorExposure, reportUncaught,
    document, globalThis: window, start: { error }, chrome: false, window,
    storedFileErrors, installExposure,
    exposureFile: JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")),
    nameWindow() { assert.fail("a failed start continued to initialise the workspace"); },
  };
  const startScript = document.querySelector("script[blocking=render]").textContent
    .split("installTokens(document.documentElement);")[1].split("// An installed plugin")[0];
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const execute = new AsyncFunction(...Object.keys(bindings), startScript);
  const pending = Symbol("the exported start is waiting for a reload");
  assert.equal(await Promise.race([execute(...Object.values(bindings)), Promise.resolve(pending)]), pending);
  assert.equal(document.querySelector(".error-toast__text")?.textContent, error);
  assert.equal(log.mock.callCount(), 1);
  const read = () => registry.handle({ method: "status.get", params: { name: "core.workbench.error" } });
  assert.equal((await read()).result, error);
  await registry.run("core.error.dismiss", { text: error });
  assert.equal((await read()).result, null);
  assert.equal(document.querySelector(".error-toast"), null);
});
