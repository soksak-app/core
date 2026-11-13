import assert from "node:assert/strict";
import test from "node:test";
import { host, selectPageWire } from "@soksak/runtime";

// The host calls of the document regions are answered by the page-wire case of each test (docs/spec/cases/page-wire/README.md).
// A case is selected before the document modules are imported, because the page reads the host when it imports them.
selectPageWire("document-region-none");
const { createDocumentRegions } = await import("../document-regions.js");
const { flushEvents } = await import("../page-log.js");

// The attach of a region sends documentAttach with the surface of the tab, as the surface runtime does (surface-modules.js, document.attach).
const attachOf = (tab) => (request) => host.call("documentAttach", { ...request, surface: tab });

test("the reasons of a tab are the query replies of its attached regions", async () => {
  const wire = selectPageWire("document-region-reasons");
  const regions = createDocumentRegions();
  regions.attached("tab", "page");
  regions.attached("tab", "side");
  regions.attached("other", "idle");
  assert.deepEqual(await regions.reasons("tab"), ["media", "capture", "form"]);
  assert.deepEqual(wire.calls, [
    { name: "documentQuery", payload: { surface: "tab", document: "page" } },
    { name: "documentQuery", payload: { surface: "tab", document: "side" } },
  ]);
  assert.deepEqual(await regions.reasons("other"), []);
  regions.detached("tab", "page");
  const before = wire.calls.length;
  assert.deepEqual(await regions.reasons("tab"), ["capture", "form"]);
  assert.deepEqual(wire.calls.slice(before), [{ name: "documentQuery", payload: { surface: "tab", document: "side" } }]);
  regions.released("tab");
  assert.deepEqual(await regions.reasons("tab"), []);
  wire.finish();
});

test("a failed query gives media-unknown and is logged", async () => {
  const wire = selectPageWire("document-region-query-failure");
  const regions = createDocumentRegions();
  regions.attached("tab", "page");
  assert.deepEqual(await regions.reasons("tab"), ["media-unknown"]);
  // The record leaves in the batch of the page log, which the flush waits for.
  await flushEvents();
  const record = wire.calls.at(-1).payload.events.at(-1);
  assert.equal(record.level, "error");
  assert.equal(record.event, "workbench.record.error");
  assert.deepEqual(record.fields, { where: "memory saver", text: "tab tab: document page: the document region is closed" });
  wire.finish();
});

test("a region whose attachment ends while its state is read yields no state, and a held attachment reports its failure", async () => {
  const wire = selectPageWire("document-region-interaction-detached");
  const regions = createDocumentRegions();
  regions.attached("tab", "page");
  // The read of the region is held by the host. The read starts after one turn of the page, so the held reply is outstanding
  // before the test changes the regions and releases the reply.
  const read = regions.interaction("tab");
  await new Promise((resolve) => setImmediate(resolve));
  // The view of the tab ends during the read: the page releases the regions and the restarted view attaches the same name.
  regions.released("tab");
  regions.attached("tab", "page");
  wire.release();
  assert.equal(await read, undefined);
  await assert.rejects(regions.interaction("tab"), /document page: the read failed/);
  wire.finish();
});

// Document regions whose stored sessions are sessions, {tab: {name: interactionState}}.
function withSessions(sessions = {}) {
  const regions = createDocumentRegions();
  regions.useSessions(async (tab) => sessions[tab]);
  return regions;
}

test("the stored interactionState of each region returns to the region of the same name on restore", async () => {
  const wire = selectPageWire("document-region-session-restore");
  const sessions = {};
  const regions = withSessions(sessions);
  regions.attached("tab", "page");
  regions.attached("tab", "empty");
  sessions.tab = await regions.interaction("tab");
  assert.deepEqual(sessions.tab, { page: "AAAA" });
  regions.released("tab");
  regions.restore("tab");
  assert.deepEqual(await regions.attachRequest("tab", "page"), { document: "page", interactionState: "AAAA" });
  // The state is restored once: a later region of the same name loads without it.
  assert.deepEqual(await regions.attachRequest("tab", "page"), { document: "page" });
  assert.deepEqual(await regions.attachRequest("tab", "empty"), { document: "empty" });
  assert.deepEqual(regions.tabs(), []);
  wire.finish();
});

test("a tab whose regions yield no interactionState has no history", async () => {
  const wire = selectPageWire("document-region-session-none");
  const regions = withSessions();
  assert.equal(await regions.interaction("none"), undefined);
  regions.attached("tab", "page");
  assert.deepEqual(regions.tabs(), ["tab"]);
  assert.equal(await regions.interaction("tab"), undefined);
  regions.restore("tab");
  assert.deepEqual(await regions.attachRequest("tab", "page"), { document: "page" });
  wire.finish();
});

test("an attach waits for the stored sessions, and a page without them attaches without a history", async () => {
  const wire = selectPageWire("document-region-none");
  const regions = createDocumentRegions();
  const request = regions.attachRequest("tab", "page");
  regions.useSessions(null);
  assert.deepEqual(await request, { document: "page" });
  assert.deepEqual(wire.calls, []);
  wire.finish();
});

test("an attach replies whether it restored a session history", async () => {
  const wire = selectPageWire("document-region-attach-history");
  const regions = withSessions({ tab: { page: "AAAA" } });
  regions.restore("tab");
  assert.deepEqual(await regions.attach("tab", "fixture", "page", attachOf("tab")), { history: true });
  assert.deepEqual(await regions.attach("tab", "fixture", "page", attachOf("tab")), { history: false });
  wire.finish();
});

test("a refused restored interactionState is reported and the region attaches again without it", async () => {
  const wire = selectPageWire("document-region-attach-refused");
  const regions = withSessions({ tab: { page: "BAD" } });
  const refused = [];
  regions.onRefused((tab, plugin, name, error) => refused.push([tab, plugin, name, error.message]));
  regions.restore("tab");
  assert.deepEqual(await regions.attach("tab", "fixture", "page", attachOf("tab")), { history: false });
  assert.deepEqual(wire.calls, [
    { name: "documentAttach", payload: { document: "page", interactionState: "BAD", surface: "tab" } },
    { name: "documentAttach", payload: { document: "page", surface: "tab" } },
  ]);
  assert.deepEqual(refused, [["tab", "fixture", "page", "interactionState is not a session history"]]);
  assert.deepEqual(await regions.interaction("tab"), { page: "S" });
  // An attach without a restored state that fails is no restore failure.
  await assert.rejects(regions.attach("tab", "fixture", "side", attachOf("tab")), /region side is gone/);
  assert.equal(refused.length, 1);
  wire.finish();
});
