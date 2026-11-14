// Checks the writes of project data of a page against a host that answers later (docs/spec/plugins.md#project-data).
// The host calls of the page are answered by the page-wire case project-data-writes-session (docs/spec/cases/page-wire/README.md): the
// tests of this file run in the order of the case, and each patch of the host waits for the release of its reply. The case is selected
// before the modules are imported, because the page reads the host when it imports them.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { host, selectPageWire } from "@soksak/runtime";
import { drained } from "./support/drained.mjs";

const stored = [{ id: "prj-alpha", root: "/work/alpha", identity: "alpha", title: "alpha", color: "#fff", named: 1,
  activeSpaceId: "spc-alpha", spaces: [{ id: "spc-alpha", title: "SPACE1", layout: { state: { cards: [] } } }], settings: {} }];
const project = { id: "prj-alpha", root: "/work/alpha" };
// The stored values and bases that every host answers alike.
const VALUES = JSON.parse(readFileSync(new URL("../../../docs/spec/cases/project-data/values.json", import.meta.url), "utf8"));

const wire = selectPageWire("project-data-writes-session");

// The window of the page: its address, its history and the error event that the page reports failures through.
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://soksak.test/index.html" });
globalThis.document = dom.window.document;
globalThis.location = dom.window.location;
globalThis.history = dom.window.history;
globalThis.dispatchEvent = dom.window.dispatchEvent.bind(dom.window);
globalThis.ErrorEvent = dom.window.ErrorEvent;

const projects = await import("../projects.js");
const { orderedCallsAnswered } = await import("../host.js");
const { HostWorkspaceStore } = await import("../host-store.js");
const { connectSettings } = await import("../settings.js");
const { declareProjectData, onDataChange, viewDataOf } = await import("../plugin-data.js");

projects.onSwitch({
  check: () => {},
  save: () => stored[0].spaces[0].layout,
  load: () => {},
  update: () => {},
  retain: async () => {},
  presented: async () => {},
  empty: async (show) => { show?.(); },
});

/** The patches that the page sent to the host, in order. */
const patchCalls = () => wire.calls.filter(({ name, payload }) => name === "workspace" && payload.kind === "patch");

declareProjectData("probe", { first: { schema: { type: "string" }, default: "" }, second: { schema: { type: "string" }, default: "" },
  third: { schema: { type: "string" }, default: "" } });
projects.begin({ common: {}, projects: structuredClone(stored), open: [] });
await orderedCallsAnswered();
const store = new HostWorkspaceStore(host);
await connectSettings(store);
await projects.initialise(store);
const data = () => viewDataOf(project, "probe");

/** The host tells the page that the registry changed; the page reads it and the test waits for the end of the read. */
async function registryChanged() {
  wire.deliverNotice();
  await projects.idle();
}

// contract: project-data.write.keeps-the-keys-before-it
test("two writes in a row keep both keys, and the store takes them in order", { timeout: 5000 }, async () => {
  const start = patchCalls().length;
  const first = data().set("first", "one");
  const second = data().set("second", "two");
  await drained();
  // The second write is sent only after the host answers the first one.
  assert.equal(patchCalls().length, start + 1, "the second write reached the store before the store answered the first");
  wire.release();
  await drained();
  assert.equal(patchCalls().length, start + 2, "the second write did not follow the answer of the first");
  wire.release();
  await Promise.all([first, second]);
  assert.deepEqual(patchCalls().at(-1).payload.patch.plugins.probe, { first: { format: 1, value: "one" }, second: { format: 1, value: "two" } });
});

// contract: project-data.write.outran-read-keeps-the-write
test("a read of the store that a write outran keeps the write", { timeout: 5000 }, async () => {
  const heard = [];
  const stop = onDataChange((_project, _plugin, key) => heard.push(key));
  const third = data().set("third", "three");
  await drained();
  await registryChanged();
  assert.equal(data().get("third"), "three", "the read took the write back out of the project");
  assert.deepEqual(heard, [], "a view heard a change of a key that nobody changed");
  wire.release();
  await third;
  assert.deepEqual(heard, ["third"]);
  stop();
});

// contract: project-data.write.refusal-answers-the-view
test("a write that the store refuses answers the view and leaves the project as it was", { timeout: 5000 }, async () => {
  const refused = data().set("first", "lost");
  await drained();
  assert.equal(data().get("first"), "lost");
  wire.release();
  await assert.rejects(refused, /the disk is full/);
  assert.equal(data().get("first"), "one");
});

test("a refused write under a later write stays in the record of that later write", { timeout: 5000 }, async () => {
  const refused = data().set("first", "kept");
  const later = data().set("second", "later");
  await drained();
  wire.release();
  await assert.rejects(refused, /the disk is full/);
  await drained();
  assert.equal(data().get("first"), "kept");
  wire.release();
  await later;
  assert.equal(patchCalls().at(-1).payload.patch.plugins.probe.first.value, "kept");
});

// contract: project-data.replace.changed-value-writes-nothing
test("two replaces from one read keep the first, and the second answers false and writes nothing", { timeout: 5000 }, async () => {
  const start = patchCalls().length;
  const base = data().get("third");
  const first = data().replace("third", base, "first change");
  const second = data().replace("third", base, "second change");
  // A refused replace settles at its call, so it is the first of the race; a replace that waits for the store is not settled yet.
  assert.equal(await Promise.race([second, Promise.resolve("pending")]), false, "the second replace waited for the store");
  await drained();
  assert.equal(patchCalls().length, start + 1, "the first replace did not reach the store");
  wire.release();
  assert.equal(await first, true);
  // The second replace would be a second patch after the answer; the host received only the first patch.
  await drained();
  assert.equal(patchCalls().length, start + 1, "the second replace reached the store");
  assert.equal(data().get("third"), "first change");
});

// contract: project-data.replace.compares-json-values
test("a replace compares JSON values, whatever the form of their text", { timeout: 5000 }, async () => {
  declareProjectData("ordered", { point: { schema: { type: "object" }, default: {} } });
  const ordered = viewDataOf(project, "ordered");
  for (const { stored: text, base, same } of VALUES) {
    // The host holds the JSON value of the text as the key point (the snapshot of the case), and the page reads it.
    await registryChanged();
    const replaced = ordered.replace("point", JSON.parse(base), { next: 1 });
    if (same) {
      await drained();
      wire.release();
    }
    assert.equal(await replaced, same, `${text} against ${base}`);
  }
});

// contract: project-data.replace.read-value-is-its-base
test("the value that a read answered is a base that a replace accepts", { timeout: 5000 }, async () => {
  const ordered = viewDataOf(project, "ordered");
  for (const { stored: text } of VALUES) {
    await registryChanged();
    const replaced = ordered.replace("point", JSON.parse(JSON.stringify(ordered.get("point"))), { next: 1 });
    await drained();
    wire.release();
    assert.equal(await replaced, true, text);
  }
});

// contract: project-data.replace.refusal-answers-the-view
test("a replace that the store refuses answers the view and leaves the value", { timeout: 5000 }, async () => {
  const before = data().get("third");
  const refused = data().replace("third", before, "lost");
  await drained();
  wire.release();
  await assert.rejects(refused, /the disk is full/);
  assert.equal(data().get("third"), before);
  wire.finish();
});
