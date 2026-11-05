// The diagnostic layout fault (diagnostics.layout.fail in docs/spec/endpoint.md) makes the next layout draw throw once: the queue reports
// the failure through failed, the draw of that layout does not run, and the next layout draws.
import assert from "node:assert/strict";
import test from "node:test";
import { armLayoutFault, createPageLayout } from "../page-layout.js";

test("an armed layout fault fails the next draw once and the next layout draws", async () => {
  const shown = [];
  const verified = [];
  const cancelled = [];
  const page = createPageLayout({
    document: null, showError: (text) => shown.push(text), setVerify: (rows) => verified.push(rows), log: () => {},
    surfaces: { waitPresented: () => Promise.resolve() }, plane: { clear: () => {} },
    compositor: { publishAhead: () => Promise.resolve(), publish: () => {}, cancelPrepared: () => { cancelled.push("cancel"); return Promise.resolve(); } }, textSize: () => 1, rendered: () => Promise.resolve(),
    waitSurfaceCompositionDeclared: () => Promise.resolve(),
  });
  const drawn = [];
  armLayoutFault();
  page.onLayout({}, () => drawn.push("first"), [], 0);
  assert.equal(await page.presented(), false, "the layout of the armed fault did not fail");
  assert.deepEqual(shown, ["surface presentation failed: diagnostic layout fault"]);
  assert.deepEqual(drawn, []);
  assert.deepEqual(cancelled, ["cancel"], "the preparation of the failed draw was not cancelled");
  page.onLayout({}, () => drawn.push("second"), [], 0);
  assert.equal(await page.presented(), true);
  assert.deepEqual(drawn, ["second"]);
});

test("a command waits for the declaration of each mounted surface and not for the slot of an unloaded hidden section", async () => {
  const waited = [];
  const page = createPageLayout({
    document: { querySelectorAll: () => [{ dataset: { nativeSurfaceId: "shown" } }, { dataset: { nativeSurfaceId: "hidden" } }] },
    showError: () => {}, setVerify: () => {}, log: () => {},
    surfaces: { waitPresented: () => Promise.resolve() }, plane: { clear: () => {} },
    compositor: { publishAhead: () => Promise.resolve(), publish: () => {}, cancelPrepared: () => {} },
    waitSurfaceCompositionDeclared: (id) => {
      waited.push(id);
      return id === "hidden" ? Promise.reject(new Error(`surface ${id} is not mounted`)) : Promise.resolve();
    },
    surfaceUnloaded: (id) => id === "hidden",
  });
  await page.drawn();
  assert.deepEqual(waited, ["shown"]);
});
