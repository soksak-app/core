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
async function harness({ deferSubscription = false } = {}) {
  const name = `s${++counter}`;
  const module = await import(`../declared-section.js?${name}`);
  const { setTreeExpanded } = await import("../declared-ui.js");
  const statusId = `demo.${name}`;
  const body = document.createElement("div");
  const world = { registrants: [], active: null, orientation: "vertical", channels: new Map(), listenerRegistrations: [], acks: [], pulls: [], expanded: [], pullReply: null, pullError: null, deferred: [], deferredSubscriptions: [], deferSubscription, skipped: [], failures: [] };
  const section = module.createDeclaredSection({
    statusId,
    body,
    options: { declared: (command) => command === "demo.open", hasIcon: () => true, bind: (el) => el },
    expanded: (source, request) => world.expanded.push({ source: source.id, request }),
    orientation: () => world.orientation,
    choose: () => module.chooseSource({ statusId, active: world.active, registrants: world.registrants, host: world.host ?? null }),
    channel: (source) => ({
      send: (message) => { world.acks.push({ source: source.id, message }); },
      onMessage: (listener) => {
        world.listenerRegistrations.push({ source: source.id, listener });
        if (!world.deferSubscription) {
          world.channels.set(source.id, listener);
          return () => { world.channels.delete(source.id); };
        }
        let ready;
        const readiness = new Promise((resolve) => { ready = resolve; });
        world.deferredSubscriptions.push(() => {
          world.channels.set(source.id, listener);
          ready(() => { world.channels.delete(source.id); });
        });
        return readiness;
      },
    }),
    pull: (source) => {
      world.pulls.push(source.id);
      if (world.pullError) return Promise.reject(world.pullError);
      if (world.deferPull) {
        let release;
        const pending = new Promise((resolve) => { release = resolve; });
        world.deferred.push(release);
        return pending;
      }
      return Promise.resolve(world.pullReply ?? { seq: 0, value: null });
    },
    skipped: (count) => { world.skipped.push(count); },
    failed: (error) => { world.failures.push(error.message); },
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

test("reconciling the ready source again keeps one listener and one pull", async () => {
  const h = await harness();
  h.world.registrants = ["view-a"];
  h.world.active = "view-a";
  h.section.reconcile();
  h.section.reconcile();
  await settle();
  assert.equal(h.world.channels.size, 1, "reconciling the same source installed duplicate listeners");
  assert.deepEqual(h.world.pulls, ["view-a"], "reconciling the same source pulled more than once");
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
  await settle();
  h.push("view-a", 5, list(["x"]));
  assert.deepEqual(h.labels(), ["x"]);
  h.world.deferred[0]({ seq: 2, value: list(["old"]) });
  await settle();
  assert.deepEqual(h.world.pulls, ["view-a"], "the source was pulled more than once");
  assert.deepEqual(h.labels(), ["x"], "a pull reply with a lower seq was drawn");
});

test("the first push is subscribed before the source is pulled", async () => {
  const h = await harness({ deferSubscription: true });
  h.world.registrants = ["view-a"];
  h.world.active = "view-a";
  h.world.pullReply = { seq: 0, value: null };
  h.world.deferPull = true;
  h.section.reconcile();
  await settle();
  assert.deepEqual(h.world.pulls, [], "the source was pulled before its snapshot listener was ready");
  h.world.deferredSubscriptions[0]();
  await settle();
  assert.deepEqual(h.world.pulls, ["view-a"], "the source was not pulled after subscription readiness");
  h.push("view-a", 1, list(["first-push"]));
  assert.deepEqual(h.world.acks.map(({ message }) => message.seq), [1], "the ready listener did not receive the first push");
  assert.deepEqual(h.labels(), ["first-push"], "the ready listener did not draw the first push");
  h.world.deferred[0]({ seq: 0, value: null });
  await settle();
  assert.deepEqual(h.labels(), ["first-push"], "the first push was not accepted before the pull reply");
});

test("a source change before subscription readiness unsubscribes late and never pulls the old source", async () => {
  const h = await harness({ deferSubscription: true });
  h.world.registrants = ["view-a", "view-b"];
  h.world.active = "view-a";
  h.section.reconcile();
  h.world.active = "view-b";
  h.section.reconcile();
  assert.deepEqual(h.world.pulls, [], "a source was pulled before subscription readiness");
  h.world.deferSubscription = false;
  h.world.deferredSubscriptions[0]();
  h.world.deferredSubscriptions[1]();
  await settle();
  assert.equal(h.world.channels.has("view-a"), false, "the obsolete subscription remained after readiness");
  assert.deepEqual(h.world.pulls, ["view-b"], "the obsolete source was pulled or the chosen source was not pulled");
  assert.equal(h.world.channels.has("view-b"), true, "the chosen source listener was not installed");
  h.section.close();
  assert.equal(h.world.channels.size, 0, "closing the section left a listener installed");
});

test("closing before subscription readiness unsubscribes late and never pulls", async () => {
  const h = await harness({ deferSubscription: true });
  h.world.registrants = ["view-a"];
  h.world.active = "view-a";
  h.section.reconcile();
  h.section.close();
  h.world.deferredSubscriptions[0]();
  await settle();
  assert.equal(h.world.channels.has("view-a"), false, "the late listener remained after the section closed");
  assert.deepEqual(h.world.pulls, [], "the source was pulled after the section closed");
});

test("a queued callback from the first A subscription is discarded after an A to B to A change", async () => {
  const h = await harness({ deferSubscription: true });
  h.world.registrants = ["view-a", "view-b"];
  h.world.active = "view-a";
  h.section.reconcile();
  const firstA = h.world.listenerRegistrations[0].listener;
  h.world.deferSubscription = false;
  h.world.active = "view-b";
  h.section.reconcile();
  h.world.active = "view-a";
  h.section.reconcile();
  const currentA = h.world.listenerRegistrations[2].listener;

  // The old A registration has completed, but its queued delivery runs before its readiness continuation can unsubscribe it.
  h.world.deferredSubscriptions[0]();
  firstA({ event: "declared-ui.snapshot", plugin: "demo", status: h.statusId.slice("demo.".length), seq: 4, value: list(["stale-a"]), skipped: 0 });
  assert.deepEqual(h.labels(), [], "a callback from the first A subscription changed the current section");

  currentA({ event: "declared-ui.snapshot", plugin: "demo", status: h.statusId.slice("demo.".length), seq: 5, value: list(["current-a"]), skipped: 0 });
  assert.deepEqual(h.labels(), ["current-a"], "the current A subscription did not update the section");
  await settle();
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
  await settle();
  h.world.registrants = ["view-b"];
  h.world.active = "view-b";
  h.world.pullReply = { seq: 1, value: list(["new"]) };
  h.section.reconcile();
  await settle();
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

// The start of a plugin host page makes the host the chosen source, a new source pair, so the status is pulled once at that change of
// source, and a reconcile without a change pulls nothing (docs/spec/declared-ui.md, pull at a change of source).
test("the start of a plugin host page pulls each declared status once, at the change of source", async () => {
  const h = await harness();
  h.world.host = "host:demo";
  h.world.pullReply = { seq: 3, value: list(["h"]) };
  h.section.reconcile();
  await settle();
  assert.deepEqual(h.world.pulls, ["host:demo"], "the host page start did not pull the status once");
  assert.deepEqual(h.labels(), ["h"], "the pulled host value was not drawn");
  h.section.reconcile();
  await settle();
  assert.deepEqual(h.world.pulls, ["host:demo"], "a reconcile without a change of source pulled again");
  h.world.host = null;
  h.section.reconcile();
  h.world.host = "host:demo";
  h.section.reconcile();
  await settle();
  assert.deepEqual(h.world.pulls, ["host:demo", "host:demo"], "the next host page start did not pull the status once");
});

test("a snapshot that overwrote values reports their count once to skipped",async () => {
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

test("a failed pull leaves the section cleared, reports its error once, and is not retried", async () => {
  const h = await harness();
  h.world.registrants = ["view-a"];
  h.world.active = "view-a";
  h.world.pullReply = { seq: 1, value: list(["a"]) };
  h.section.reconcile();
  await settle();
  assert.deepEqual(h.labels(), ["a"], "the first pull was not drawn");
  h.world.registrants = ["view-b"];
  h.world.active = "view-b";
  h.world.pullReply = null;
  h.world.pullError = new Error("snapshot store read failed");
  h.section.reconcile();
  await settle();
  assert.equal(h.body.textContent, "", "the section drew the previous source's value after a failed pull");
  assert.deepEqual(h.world.failures, ["snapshot store read failed"], "the failed pull was not reported once");
  assert.deepEqual(h.world.pulls, ["view-a", "view-b"], "the failed pull was not made once");
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  try {
    mock.timers.tick(60000);
    await settle();
  } finally {
    mock.timers.reset();
  }
  assert.deepEqual(h.world.pulls, ["view-a", "view-b"], "the failed pull was retried on a timer");
  h.section.reconcile();
  await settle();
  assert.deepEqual(h.world.pulls, ["view-a", "view-b"], "a reconcile without a change of source pulled again");
  assert.deepEqual(h.world.failures, ["snapshot store read failed"], "the failure was reported again");
  assert.equal(h.body.textContent, "", "the section drew a value after the failed pull");
});
