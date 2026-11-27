// Checks that the notice writer of the page ends with the start that replaces it (docs/spec/notifications.md#notice-center). Each start of
// the page opens one writer on the notice store; two starts must leave one writer, so one change of the notices is written once. The
// host calls of the case (docs/spec/cases/page-wire/README.md) answer both starts and record the one write.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { host, selectPageWire } from "@soksak/runtime";
import { drained } from "./support/drained.mjs";

const wire = selectPageWire("projects-notices-writer");
// The page shows its errors in the document, so the start needs one.
const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
globalThis.document = dom.window.document;
const { HostWorkspaceStore } = await import("../host-store.js");
const { connectSettings } = await import("../settings.js");
const { reportPageNotice } = await import("../tab-reports.js");
const { endNoticesWriter } = await import("../notices-file.js");
// The core declarations, so the notice controls of the page bind their declared commands (exposure.json).
const { registry } = await import("../exposure.js");
registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
globalThis.location = new URL("http://soksak.test/index.html");

let instances = 0;
/** Starts the page once: a new instance of the project module, with the settings and the store of the window. */
async function start() {
  const projects = await import(`../projects.js?notices-writer-${++instances}`);
  const store = new HostWorkspaceStore(host);
  await connectSettings(store);
  await projects.initialise(store);
  return projects;
}

test("two starts of the page leave one notice writer, so a change of the notices is written once", { timeout: 5000 }, async () => {
  await start();
  await start();
  reportPageNotice({ kind: "info", title: "ready", text: "" }, "probe");
  await drained();
  assert.equal(wire.calls.filter(({ name, payload }) => name === "workspace" && payload.kind === "noticesPut").length, 1);
  endNoticesWriter();
  wire.finish();
});
