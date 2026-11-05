// What the first window of a main page reads (docs/spec/native-host.md#page-start): the settings modal and the debug
// view load at their first use, and a screen that never loaded answers its status as closed.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { importSpecifiers } from "@soksak/plugin-api";

const workbench = new URL("../", import.meta.url);
const read = (name) => readFileSync(new URL(name, workbench), "utf8");
/** The specifiers that a module loads before it runs: a dynamic import is left out. */
const staticImports = (source) => importSpecifiers(source.replace(/\bimport\(\s*["'][^"']+["']\s*\)/g, ""));

/** The workbench files that the static imports of the module scripts of the main page reach. */
function firstWindowModules() {
  const page = read("index.html");
  const scripts = [...page.matchAll(/<script type="module"[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  const reached = new Set();
  const pending = scripts.flatMap(staticImports);
  for (const source of [...page.matchAll(/<script type="module"[^>]*src="\.\/([^"]+)"/g)]) pending.push(`./${source[1]}`);
  while (pending.length > 0) {
    const specifier = pending.pop();
    if (!specifier.startsWith("./") || !specifier.endsWith(".js")) continue;
    const name = specifier.slice(2);
    if (reached.has(name) || !existsSync(new URL(name, workbench))) continue;
    reached.add(name);
    pending.push(...staticImports(read(name)));
  }
  return reached;
}

const LATER = ["settings-ui.js", "debug-ui.js", "debug-state.js", "debug-timeline.js", "debug-order.js", "scroll-keep.js"];

test("the first window of a main page reads no module of the settings modal or the debug view", () => {
  const reached = firstWindowModules();
  assert.ok(reached.has("core-exposure.js") && reached.has("plane.js"), "the walk reached no module of the page");
  assert.deepEqual(LATER.filter((name) => reached.has(name)), []);
});

/** Starts the core commands in the document of the main page, without a host. */
async function start(t) {
  const dom = new JSDOM(read("index.html"), { url: "http://localhost/" });
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
  registry.declare("core", JSON.parse(read("exposure.json")).exposes);
  const { installCoreExposure } = await import("../core-exposure.js");
  await installCoreExposure({
    library: { state: () => null }, renames: { state: () => null }, chrome: () => null, drawn: async () => {},
  });
  return registry;
}

test("a screen that never loaded answers its status as closed, and its first command loads it", async (t) => {
  const registry = await start(t);
  const status = async (name) => (await registry.handle({ method: "status.get", params: { name } })).result;
  const debugBefore = await status("core.debug");
  const settingsBefore = await status("core.settings-modal");
  assert.deepEqual(settingsBefore, { open: false, controls: [] });
  const { debugState } = await import("../debug-ui.js");
  assert.deepEqual(debugBefore, debugState());
  await registry.run("core.debug.close");
  await registry.run("core.settings.close");
  assert.equal(document.querySelector(".set-scrim"), null);
  await registry.run("core.settings.open");
  assert.notEqual(document.querySelector(".set-scrim"), null, "the first command did not open the modal");
  assert.equal((await status("core.settings-modal")).open, true);
  await registry.run("core.settings.close");
  assert.equal(document.querySelector(".set-scrim"), null);
  assert.deepEqual((await status("core.settings-modal")).open, false);
});
