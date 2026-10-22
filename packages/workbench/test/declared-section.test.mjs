// The source and transitions of a declared section (docs/spec/declared-ui.md, status mapping and transitions). The channel, the pull,
// and the registrations are fakes at the boundary of the section.
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<body><div id=body></div></body>");
globalThis.document = dom.window.document;

// The log lines of the display path are collected through the host report function (shown-errors.js).
const reports = [];
mock.module("../host.js", { namedExports: { report: (line) => { reports.push(line); } } });

const settle = () => new Promise((resolve) => setImmediate(resolve));
const list = (texts) => ({ elements: [{ kind: "list", key: "l1", empty: "none", items: texts.map((text) => ({ key: text, label: text })) }] });
const tree = (nodes) => ({ elements: [{ kind: "tree", key: "t1", empty: "none", nodes }] });
const branch = (key, children, extra = {}) => ({ key, label: key, children, ...extra });
const leaf = (key) => ({ key, label: key });

let counter = 0;

/** A declared section for one status, with fake registrations, a fake channel per source, and a fake pull. */
async function harness() {
  const name = `s${++counter}`;
  const module = await import(`../declared-section.js?${name}`);
  const { setTreeExpanded } = await import("../declared-ui.js");
  const statusId = `demo.${name}`;
  const body = document.createElement("div");
  const world = { registrants: [], active: null, orientation: "vertical", channels: new Map(), acks: [], pulls: [], expanded: [], pullReply: null, deferred: [], skipped: [] };
  const section = module.createDeclaredSection({
    statusId,
    body,
    options: { declared: (command) => command === "demo.open", hasIcon: () => true, bind: (el) => el },
    expanded: (source, request) => world.expanded.push({ source: source.id, request }),
    orientation: () => world.orientation,
    choose: () => module.chooseSource({ statusId, active: world.active, registrants: world.registrants }),
    channel: (source) => ({
      send: (message) => { world.acks.push({ source: source.id, message }); },
      onMessage: (listener) => { world.channels.set(source.id, listener); return () => { world.channels.delete(source.id); }; },
    }),
    pull: (source) => {
      world.pulls.push(source.id);
      if (world.deferPull) {
        let release;
        const pending = new Promise((resolve) => { release = resolve; });
        world.deferred.push(release);
        return pending;
      }
      return Promise.resolve(world.pullReply ?? { seq: 0, value: null });
    },
    skipped: (count) => { world.skipped.push(count); },
    failed: (error) => { throw error; },
  });
  return {
    statusId, body, world, section,
    push(source, seq, value, skipped = 0) {
      assert.ok(world.channels.get(source), `no channel is subscribed for ${source}`);
      // The snapshot of a view names the status in its plugin; the channel is per plugin (docs/spec/declared-ui.md).
      world.channels.get(source)({ event: "declared-ui.snapshot", plugin: "demo", status: name, seq, value, skipped });
    },
    expand(path, expanded) {
      assert.doesNotThrow(() => setTreeExpanded({ status: statusId, tree: "t1", path, expanded }), "the tree was not drawn");
    },
    labels() { return [...body.querySelectorAll(".declared-label")].map((label) => label.textContent); },
  };
}

test("a section with no registered source shows nothing, pulls nothing, and subscribes to nothing", async () => {
  const h = await harness();
  h.section.reconcile();
  await settle();
  assert.equal(h.body.textContent, "", "the section drew something without a source");
  assert.deepEqual(h.world.pulls, [], "a value was pulled without a source");
  assert.equal(h.world.channels.size, 0, "a channel was subscribed without a source");
});

test("the active view that registered the status is the source: it is pulled once and its pushed values are drawn", async () => {
  const h = await harness();
  h.world.registrants = ["view-a"];
  h.world.active = "view-a";
  h.world.pullReply = { seq: 1, value: list(["a"]) };
  h.section.reconcile();
  await settle();
  assert.deepEqual(h.world.pulls, ["view-a"], "the source was not pulled once");
  assert.deepEqual(h.labels(), ["a"], "the pulled value was not drawn");
  h.push("view-a", 2, list(["b"]));
  assert.deepEqual(h.labels(), ["b"], "the pushed value was not drawn");
  assert.deepEqual(h.world.acks.map((ack) => ack.message.seq), [2], "the snapshot was not acknowledged");
});

test("tree expansion is sent to its source and displayed after the authoritative snapshot", async () => {
  const h = await harness();
  h.world.registrants = ["view-a"];
  h.world.active = "view-a";
  h.world.pullReply = { seq: 1, value: tree([branch("b", [leaf("c")])]) };
  h.section.reconcile();
  await settle();
  assert.deepEqual(h.labels(), ["b"]);
  h.expand(["b"], true);
  assert.deepEqual(h.world.expanded, [{
    source: "view-a",
    request: { status: h.statusId.slice("demo.".length), tree: "t1", path: ["b"], expanded: true },
  }], "the expand command did not send the plugin update request");
  assert.deepEqual(h.labels(), ["b"], "the workbench changed the tree before the plugin round trip");
  h.push("view-a", 2, tree([branch("b", [leaf("c")], { expanded: true })]));
  assert.deepEqual(h.labels(), ["b", "c"], "the returned plugin value did not change the tree");
  h.world.registrants = ["view-b"];
  h.world.active = "view-b";
  h.world.pullReply = { seq: 1, value: tree([branch("b", [leaf("c")])]) };
  h.section.reconcile();
  assert.equal(h.body.textContent, "", "the section was not cleared at the change of source");
  await settle();
  assert.deepEqual(h.world.pulls, ["view-a", "view-b"], "the new source was not pulled once");
  assert.deepEqual(h.labels(), ["b"], "the previous source's expansion overrode the new plugin value");
});

test("a snapshot that arrives from a source that is no longer chosen is discarded", async () => {
  const h = await harness();
  h.world.registrants = ["view-a"];
  h.world.active = "view-a";
  h.world.pullReply = { seq: 1, value: list(["a"]) };
  h.section.reconcile();
  await settle();
  const staleListener = h.world.channels.get("view-a");
  assert.equal(typeof staleListener, "function", "the chosen source was not subscribed");
  h.world.registrants = ["view-b"];
  h.world.active = "view-b";
  h.world.pullReply = { seq: 0, value: null };
  h.section.reconcile();
  assert.equal(h.world.channels.has("view-a"), false, "the channel of the old source is still subscribed");
  // A delivery that races the unsubscription reaches the old listener; it must not draw.
  staleListener({ event: "declared-ui.snapshot", plugin: "demo", status: h.statusId.slice("demo.".length), seq: 9, value: list(["old"]), skipped: 0 });
  assert.equal(h.body.textContent, "", "a snapshot of the old source was drawn");
});

test("a pull reply with a lower seq than the last accepted value is discarded", async () => {
  const h = await harness();
  h.world.registrants = ["view-a"];
  h.world.active = "view-a";
  h.world.deferPull = true;
  h.section.reconcile();
  h.push("view-a", 5, list(["x"]));
  assert.deepEqual(h.labels(), ["x"]);
  h.world.deferred[0]({ seq: 2, value: list(["old"]) });
  await settle();
  assert.deepEqual(h.world.pulls, ["view-a"], "the source was pulled more than once");
  assert.deepEqual(h.labels(), ["x"], "a pull reply with a lower seq was drawn");
});

test("a pull reply with value null leaves the section cleared until the first push", async () => {
  const h = await harness();
  h.world.registrants = ["view-a"];
  h.world.active = "view-a";
  h.world.pullReply = { seq: 0, value: null };
  h.section.reconcile();
  await settle();
  assert.equal(h.body.textContent, "", "the section drew a null value");
  h.push("view-a", 1, list(["first"]));
  assert.deepEqual(h.labels(), ["first"], "the first push was not drawn");
});

test("a rejected value is shown in the section, and a change of source withdraws it", async () => {
  const h = await harness();
  h.world.registrants = ["view-a"];
  h.world.active = "view-a";
  h.world.pullReply = { seq: 0, value: null };
  h.section.reconcile();
  await settle();
  reports.length = 0;
  h.push("view-a", 1, { elements: [{ kind: "chart", key: "x" }] });
  assert.equal(h.body.textContent, '/elements/0/kind: unknown kind "chart"', "the rejection was not shown");
  assert.equal(h.body.dataset.error, `declared UI ${h.statusId}`);
  assert.deepEqual(reports, [`declared UI ${h.statusId}: /elements/0/kind: unknown kind "chart"`]);
  h.world.registrants = ["view-b"];
  h.world.active = "view-b";
  h.section.reconcile();
  assert.equal(h.body.dataset.error, undefined, "the change of source did not withdraw the error");
});

test("a process end removes its registration, which clears the section and withdraws its error", async () => {
  const h = await harness();
  h.world.registrants = ["view-a"];
  h.world.active = "view-a";
  h.world.pullReply = { seq: 1, value: list(["a"]) };
  h.section.reconcile();
  await settle();
  assert.deepEqual(h.labels(), ["a"]);
  reports.length = 0;
  h.push("view-a", 2, { elements: [{ kind: "chart", key: "x" }] });
  assert.equal(h.body.dataset.error, `declared UI ${h.statusId}`, "the rejection was not shown before the process end");
  h.world.registrants = [];
  h.world.active = null;
  h.section.reconcile();
  assert.equal(h.body.textContent, "", "the section was not cleared at the process end");
  assert.equal(h.body.dataset.error, undefined, "the process end did not withdraw the error");
  assert.equal(h.world.channels.size, 0, "the channel of the ended process is still subscribed");
});

test("a pull reply of a source that is no longer chosen is discarded", async () => {
  const h = await harness();
  h.world.registrants = ["view-a"];
  h.world.active = "view-a";
  h.world.deferPull = true;
  h.world.pullReply = { seq: 1, value: list(["old"]) };
  h.section.reconcile();
  h.world.registrants = ["view-b"];
  h.world.active = "view-b";
  h.world.pullReply = { seq: 1, value: list(["new"]) };
  h.section.reconcile();
  assert.equal(h.body.textContent, "", "a section was drawn before a pull reply arrived");
  h.world.deferred[0]({ seq: 1, value: list(["old"]) });
  await settle();
  assert.equal(h.body.textContent, "", "a pull reply of the old source was drawn");
  h.world.deferred[1]({ seq: 1, value: list(["new"]) });
  await settle();
  assert.deepEqual(h.labels(), ["new"], "the reply of the chosen source was not drawn");
});

test("a surface close clears the section, unsubscribes the channel, and withdraws the error", async () => {
  const h = await harness();
  h.world.registrants = ["view-a"];
  h.world.active = "view-a";
  h.world.pullReply = { seq: 1, value: list(["a"]) };
  h.section.reconcile();
  await settle();
  assert.deepEqual(h.labels(), ["a"]);
  h.push("view-a", 2, { elements: [{ kind: "chart", key: "x" }] });
  assert.equal(h.body.dataset.error, `declared UI ${h.statusId}`, "the rejection was not shown before the close");
  h.section.close();
  assert.equal(h.body.textContent, "", "the section was not cleared at the close");
  assert.equal(h.body.dataset.error, undefined, "the close did not withdraw the error");
  assert.equal(h.world.channels.size, 0, "the channel of the closed surface is still subscribed");
});

test("the active view serves only when it registered the status, and a plugin host serves when no view does", async () => {
  const module = await import("../declared-section.js?choose");
  assert.deepEqual(module.chooseSource({ statusId: "demo.s", active: "view-a", registrants: ["view-a"] }), { id: "view-a", surface: "view-a" });
  assert.equal(module.chooseSource({ statusId: "demo.s", active: "view-a", registrants: ["view-b"] }), null, "another view served");
  assert.equal(module.chooseSource({ statusId: "demo.s", active: null, registrants: ["view-a"] }), null, "a view served without an active tab");
  assert.deepEqual(module.chooseSource({ statusId: "demo.s", active: "view-a", registrants: [], host: "host:demo" }), { id: "host:demo", surface: null });
  assert.deepEqual(module.chooseSource({ statusId: "demo.s", active: "view-a", registrants: ["view-a"], host: "host:demo" }), { id: "view-a", surface: "view-a" }, "the host served before the view");
});

test("a snapshot that overwrote values reports their count once to skipped", async () => {
  const h = await harness();
  h.world.registrants = ["view-a"];
  h.world.active = "view-a";
  h.section.reconcile();
  await settle();
  h.push("view-a", 1, list(["a"]), 3);
  assert.deepEqual(h.world.skipped, [3], "the count of the overwritten values was not reported");
  h.push("view-a", 2, list(["b"]));
  assert.deepEqual(h.world.skipped, [3], "a snapshot without overwrote values was reported");
});

test("the section reports mounted while it draws an accepted value and the rejection while the last value is rejected", async () => {
  const h = await harness();
  h.world.registrants = ["view-a"];
  h.world.active = "view-a";
  h.world.pullReply = { seq: 1, value: list(["a"]) };
  h.section.reconcile();
  await settle();
  assert.deepEqual(h.section.state(), { mounted: true, error: null }, "an accepted value is not reported as mounted");
  h.push("view-a", 2, { elements: [{ kind: "chart", key: "x" }] });
  assert.deepEqual(h.section.state(), { mounted: false, error: '/elements/0/kind: unknown kind "chart"' }, "the rejection is not reported");
  h.push("view-a", 3, list(["b"]));
  assert.deepEqual(h.section.state(), { mounted: true, error: null }, "the next accepted value did not clear the reported error");
  h.world.registrants = ["view-b"];
  h.world.active = "view-b";
  h.section.reconcile();
  assert.deepEqual(h.section.state(), { mounted: false, error: null }, "a change of source is not reported as cleared");
});

test("a change of source that removes the focused tree control moves focus to the document body", async () => {
  const h = await harness();
  document.body.append(h.body);
  try {
    h.world.registrants = ["view-a"];
    h.world.active = "view-a";
    h.world.pullReply = { seq: 1, value: tree([{ key: "a", label: "a", command: "demo.open" }]) };
    h.section.reconcile();
    await settle();
    const label = h.body.querySelector(".declared-label");
    label.focus();
    assert.equal(document.activeElement, label, "the label did not take focus");
    h.world.registrants = ["view-b"];
    h.world.active = "view-b";
    h.world.pullReply = { seq: 1, value: tree([leaf("z")]) };
    h.section.reconcile();
    await settle();
    assert.deepEqual(h.labels(), ["z"], "the new source did not draw its value");
    assert.equal(document.activeElement, document.body, "focus stayed on the removed control after the change of source");
  } finally {
    h.body.remove();
  }
});
