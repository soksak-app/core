// The core entries read the memory saver of the page (core.tab.memory, core.surfaces and the tab commands), so installCoreExposure
// refuses a page without it before it registers any entry, and it installs the entries of a page that gives it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { EXPOSURE_ERRORS } from "@soksak/plugin-api";
import { pageMemorySaver } from "./support/memory-saver.mjs";

test("installCoreExposure refuses a page without its memory saver and installs the entries of a page that gives it", { timeout: 5000 }, async (t) => {
  const dom = new JSDOM(readFileSync(new URL("../index.html", import.meta.url), "utf8"), { url: "http://localhost/" });
  dom.window.matchMedia = (query) => ({ media: query, matches: true,
    addEventListener: () => {}, removeEventListener: () => {} });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.CSS = dom.window.CSS;
  globalThis.PointerEvent = dom.window.PointerEvent;
  globalThis.MouseEvent = dom.window.MouseEvent;
  globalThis.addEventListener = dom.window.addEventListener.bind(dom.window);
  t.after(() => dom.window.close());
  const { registry } = await import("../exposure.js");
  registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
  const { installCoreExposure } = await import("../core-exposure.js");
  const parts = { home: { state: () => null }, renames: { state: () => null }, chrome: () => null, drawn: async () => {} };
  await assert.rejects(installCoreExposure(parts),
    new TypeError("installCoreExposure requires memorySaver, the memory saver of the page (memory-saver.js)"));
  const memoryStatus = () => registry.handle({ method: "status.get", params: { name: "core.tab.memory" } });
  assert.equal((await memoryStatus()).error?.code, EXPOSURE_ERRORS.unregistered, "the refused install registered core.tab.memory");
  await installCoreExposure({ ...parts, memorySaver: await pageMemorySaver() });
  const answer = await memoryStatus();
  assert.deepEqual(answer.result?.tabs, [], `core.tab.memory answered ${JSON.stringify(answer)}`);
});
