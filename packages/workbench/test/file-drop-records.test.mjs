// A file drop that fails, and a file drop that reaches a command, leave a record of the page
// (docs/spec/diagnostics.md#forms); core.drop keeps only the last drop.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";

test("a failed file drop is reported with its reason and every drop is logged", { timeout: 5000 }, async () => {
  // The case selects the host of the page before the host module is imported, because the page reads the host when it is imported.
  const wire = selectPageWire("file-drop-records");
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
  const { logGate } = await import("../log-gate.js");
  // The lines of the log are stored at the level info, so each one reaches the host in the batch of the page.
  logGate.set({ lifecycle: "info", input: "error", call: "error", io: "error", frame: "error" });
  const { flushEvents } = await import("../page-log.js");
  const { registry } = await import("../exposure.js");
  registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
  const { installCoreExposure } = await import("../core-exposure.js");
  try {
    await installCoreExposure({
      library: { state: () => null }, renames: { state: () => null }, chrome: () => null,
      drawn: async () => {},
    });
    // The host delivers each drop as the notice files-dropped. dropFiles logs and reports each of these drops before its first await,
    // because each one throws before the command is run.
    wire.deliverNotice();
    wire.deliverNotice();
    wire.deliverNotice();
    await flushEvents();
    const records = wire.calls
      .filter((call) => call.name === "log" && call.payload.action === "batch")
      .flatMap((call) => call.payload.events)
      .filter((event) => event.event.startsWith("workbench.record."));
    const reported = records.filter((event) => event.level === "error").map((event) => `${event.fields.where}: ${event.fields.text}`);
    const logged = records.filter((event) => event.level === "info").map((event) => `${event.fields.where}: ${event.fields.text}`);
    assert.equal(reported.length, 3, `reported ${JSON.stringify(reported)}`);
    assert.match(reported[0], /^drop: Unexpected token/);
    assert.deepEqual(reported.slice(1), ["drop: the application sent an invalid file drop", "drop: no surface is under the drop point"]);
    assert.deepEqual(logged, [
      "drop: received not json",
      'drop: received {"urls":[],"x":1,"y":2}',
      'drop: received {"urls":["file:///a.txt"],"x":5,"y":6}',
    ]);
    wire.finish();
  } finally {
    dom.window.close();
  }
});
