// core.plugins.install, core.plugins.update and core.plugins.enable take end: true, which runs an operation that a running persistent
// service holds, and refuse any other end (docs/spec/installation.md#plugin-state-and-commands).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { EXPOSURE_ERRORS } from "@soksak/plugin-api";
import { pageMemorySaver } from "./support/memory-saver.mjs";

test("a plugin command passes end true to the operation and refuses another end", { timeout: 5000 }, async (t) => {
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
  const parts = { library: { state: () => null }, renames: { state: () => null }, chrome: () => null, drawn: async () => {}, memorySaver: await pageMemorySaver() };
  await installCoreExposure(parts);
  const run = (name, params) => registry.handle({ method: "command.run", params: { name, params } });
  for (const name of ["core.plugins.install", "core.plugins.update", "core.plugins.enable"]) {
    // The declared params refuse an end that is not a boolean, and the command refuses false.
    for (const [end, message] of [["yes", `invalid params for ${name}`], [1, `invalid params for ${name}`], [false, "end must be true"]]) {
      const answer = await run(name, { plugin: "tty", end });
      assert.deepEqual([answer.error?.code, answer.error?.message], [EXPOSURE_ERRORS.invalidParams, message],
        `${name} with end ${JSON.stringify(end)} answered ${JSON.stringify(answer)}`);
    }
    // The page of the check has no native host, so an accepted end reaches the operation, which states that it needs one.
    const answer = await run(name, { plugin: "tty", end: true });
    assert.match(answer.error?.message ?? "", /plugin operations need a native host/, `${name} with end true answered ${JSON.stringify(answer)}`);
  }
});
