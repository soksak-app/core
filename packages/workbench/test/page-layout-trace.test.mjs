// Every phase that a layout records in the performance trace is declared by the event catalog (docs/spec/events.json), including the
// phase of a layout whose preparation is cancelled.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";

const dom = new JSDOM(readFileSync(new URL("../index.html", import.meta.url), "utf8"), { url: "http://localhost/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.CSS = dom.window.CSS ?? { escape: (text) => text };
globalThis.addEventListener = dom.window.addEventListener.bind(dom.window);
// The calls of the policy, of the trace switch and of the event writer are answered by the page-wire case of this test
// (docs/spec/cases/page-wire/README.md). The case is selected before the modules that read the host are imported.
const wire = selectPageWire("page-layout-trace");
const { setTraceEnabled } = await import("../performance.js");
const { setLogPolicy } = await import("../log-policy.js");
const { flushEvents } = await import("../page-log.js");
const { log, surfaces } = await import("../host.js");
const compositor = await import("../compositor.js");
const plane = await import("../plane.js");
const { value } = await import("../settings.js");
const { armLayoutFault, createErrorDisplay, createErrorWithdrawal, createPageLayout } = await import("../page-layout.js");
const catalog = JSON.parse(readFileSync(new URL("../../../docs/spec/events.json", import.meta.url), "utf8"));

test("a cancelled layout records only the phases that the event catalog declares", async () => {
  // The trace events are of the class frame, which the policy stores at the level debug.
  await setLogPolicy({ frame: "debug" });
  await setTraceEnabled(true);
  const page = createPageLayout({
    document, showError: createErrorDisplay({ document, changed: () => {} }),
    withdrawError: createErrorWithdrawal({ document, changed: () => {} }),
    // setVerify receives the verification rows of core-exposure.js, which this test does not import; the rows are not asserted.
    setVerify: () => {}, log, surfaces,
    plane: { currentGrid: plane.currentGrid, settle: plane.settle, clear: plane.clear },
    compositor: { publishAhead: compositor.publishAhead, publish: compositor.publish, cancelPrepared: compositor.cancelPrepared },
    textSize: () => value("textSize"),
  });
  armLayoutFault();
  page.onLayout({}, () => {}, [], 0, () => true);
  assert.equal(await page.presented(), false, "the layout of the armed fault did not fail");
  await flushEvents();
  const phases = wire.calls.filter((call) => call.name === "log" && call.payload?.action === "batch")
    .flatMap((call) => call.payload.events).filter((event) => event.event === "workbench.trace.layout").map((event) => event.fields.phase);
  assert.ok(phases.includes("cancelled"), `the layout did not record its cancel: ${phases}`);
  const declared = catalog.events["workbench.trace.layout"].fields.properties.phase.enum;
  assert.deepEqual(phases.filter((phase) => !declared.includes(phase)), [], "a phase is not declared by the event catalog");
  wire.finish();
});
