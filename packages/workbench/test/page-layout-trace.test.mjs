// Every phase that a layout records in the performance trace is declared by the event catalog (docs/spec/events.json), including the
// phase of a layout whose preparation is cancelled.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mock, test } from "node:test";

const phases = [];
const real = await import("../performance.js");
mock.module("../performance.js", {
  namedExports: { ...real, trace: (kind, fields) => { if (kind === "layout") phases.push(fields.phase); } },
});
const { armLayoutFault, createPageLayout } = await import("../page-layout.js");
const catalog = JSON.parse(readFileSync(new URL("../../../docs/spec/events.json", import.meta.url), "utf8"));

test("a cancelled layout records only the phases that the event catalog declares", async () => {
  const page = createPageLayout({
    document: null, showError: () => {}, setVerify: () => {}, log: () => {},
    surfaces: { waitPresented: () => Promise.resolve() }, plane: { clear: () => {} },
    compositor: { publishAhead: () => Promise.resolve(), publish: () => {}, cancelPrepared: () => Promise.resolve() },
    waitSurfaceCompositionDeclared: () => Promise.resolve(),
  });
  armLayoutFault();
  page.onLayout({}, () => {}, [], 0, () => true);
  assert.equal(await page.presented(), false, "the layout of the armed fault did not fail");
  assert.ok(phases.includes("cancelled"), `the layout did not record its cancel: ${phases}`);
  const declared = catalog.events["workbench.trace.layout"].fields.properties.phase.enum;
  assert.deepEqual(phases.filter((phase) => !declared.includes(phase)), [], "a phase is not declared by the event catalog");
});
