// A file drop that fails, and a file drop that reaches a command, leave a record of the page
// (docs/spec/diagnostics.md#forms); core.drop keeps only the last drop.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

test("a failed file drop is reported with its reason and every drop is logged", { timeout: 5000 }, async (t) => {
  const markup = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const dom = new JSDOM(markup, { url: "http://localhost/" });
  dom.window.matchMedia = (query) => ({ media: query, matches: true,
    addEventListener: () => {}, removeEventListener: () => {} });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.CSS = dom.window.CSS;
  globalThis.PointerEvent = dom.window.PointerEvent;
  globalThis.MouseEvent = dom.window.MouseEvent;
  globalThis.addEventListener = dom.window.addEventListener.bind(dom.window);

  // jsdom has no layout, so no element is at any point.
  dom.window.document.elementFromPoint = () => null;
  const reported = [];
  const logged = [];
  let dropped = null;
  const actualHost = await import("../host.js");
  t.mock.module("../host.js", { exports: { ...actualHost,
    report: (line) => { reported.push(line); },
    log: (line) => { logged.push(line); },
    onFilesDropped: (handler) => { dropped = handler; },
  } });
  const { registry } = await import("../exposure.js");
  registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
  const { installCoreExposure } = await import("../core-exposure.js");
  try {
    await installCoreExposure({
      library: { state: () => null }, renames: { state: () => null }, chrome: () => null,
      drawn: async () => {},
    });
    assert.equal(typeof dropped, "function", "the drop handler was not installed");
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    dropped("not json");
    await settle();
    assert.equal(reported.length, 1, `reported ${JSON.stringify(reported)}`);
    assert.match(reported[0], /^drop: Unexpected token/);
    dropped(JSON.stringify({ urls: [], x: 1, y: 2 }));
    await settle();
    assert.deepEqual(reported.slice(1), ["drop: the application sent an invalid file drop"]);
    dropped(JSON.stringify({ urls: ["file:///a.txt"], x: 5, y: 6 }));
    await settle();
    assert.deepEqual(reported.slice(2), ["drop: no surface is under the drop point"]);
    assert.deepEqual(logged, [
      "drop: received not json",
      'drop: received {"urls":[],"x":1,"y":2}',
      'drop: received {"urls":["file:///a.txt"],"x":5,"y":6}',
    ]);
  } finally {
    dom.window.close();
  }
});
