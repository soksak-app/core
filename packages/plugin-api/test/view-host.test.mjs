// Replays the page-wire cases of the view calls and the view events (docs/spec/cases/page-wire/README.md) against answerViewCall, with the
// options that createTestHost builds. Each view of a case has its own test host, which is named by the surface of the view. The replies of
// the view (each viewReply of the case) and the pushes of the view (each viewEvent of the case) are compared in order. The notices of the
// case drive the host: a view-call notice starts answerViewCall of the view that it names, a cancel notice cancels it, a listen step
// registers the subscription of the page, a change step sets a state of the window through the change methods of the host, and any other
// notice is delivered to the subscriptions as a host event. The host calls that the page makes for the workbench (workspace, exposureForward,
// the log, the window) are not compared.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { answerViewCall } from "../view-answer.js";
import { createTestHost } from "../view-host.js";

const CASES = new URL("../../../docs/spec/cases/page-wire/", import.meta.url);

const START_PROJECT = { id: "p1", root: "/projects/p1" };
const SHORTCUT_ROWS = [
  { key: "shift+cmd+n", owner: "workbench", command: "core.window.new" },
  { key: "cmd+k", owner: "workbench", command: "core.library.search.focus" },
  { key: "Enter", owner: "workbench", command: "core.rename.commit" },
  { key: "Escape", owner: "workbench", command: "core.rename.cancel" },
  { key: "Enter", owner: "workbench", command: "core.library.form.submit" },
  { key: "Escape", owner: "workbench", command: "core.picker.close" },
  { key: "Escape", owner: "workbench", command: "core.modal.dismiss" },
  { key: "Escape", owner: "view", command: "none" },
  { key: "text input keys", owner: "view", command: "none" },
];
const plugin = (id, manifest) => ({ id, package: `@scope/plugin-${id}`, version: "0.1.0", folder: "/installed/plugin", manifest: { id, name: id, ...manifest } });
// The installed plugins: probe declares the extension point language, and one and two contribute to it. Entry 0 of two names a range that
// the point does not accept, so only its entry 1 is connected.
const INSTALLED = () => [
  plugin("probe", { extends: { language: { version: "1.0.0", schema: { type: "object" } } } }),
  plugin("one", { contributes: { "probe.language": [{ range: "^1.0.0", module: "ui/one.js", name: "one" }] } }),
  plugin("two", { contributes: { "probe.language": [{ range: "^2.0.0", module: "ui/skipped.js", name: "skipped" }, { range: "^1.0.0", module: "ui/two.js", name: "two" }] } }),
];
const BINARY_ID = "0123456789abcdef0123456789abcdef";
const DECLARED_COMPOSITION = { kind: "view", regions: [{ name: "doc", kind: "document", input: "native" }, { name: "picture", kind: "image" }], overlays: [] };
// The levels of the log classes that the window starts with.
const LEVELS = { lifecycle: "error", input: "error", call: "error", io: "error", frame: "error" };

/** The fixtures of the probe view. Each call builds new fixtures, because a fixture can hold a state of its own. */
const base = () => ({
  plugin: "probe",
  surface: "probe-surface",
  declarations: {
    status: [{ name: "probe.lines" }, { name: "probe.count" }, { name: "probe.state" }],
    commands: [{ name: "probe.run" }],
    element: [{ name: "probe.view" }],
  },
  contributions: INSTALLED(),
  surfaces: [{ surface: "tab-a", plugin: "probe" }, { surface: "spc-aaaaaa/left/files.tree", plugin: "probe" }],
  sidecars: ["fixture-sidecar"],
  data: { note: { schema: { type: "string" }, default: "default" } },
  project: START_PROJECT,
});

/**
 * The fixtures of the probe-reader view of the dependency cases: its plugin lists the package @fixture/plugin-other of the plugin other,
 * whose note is stored as "from other". The package differs from the id, and the view calls name the id.
 */
const dependencyBase = () => ({
  ...base(),
  plugin: "probe-reader",
  dependencies: { "@fixture/plugin-other": { plugin: "other", data: { note: { schema: { type: "string" }, default: "default" } }, values: { note: "from other" } } },
});

/** A fixture that answers its values in order, and fails when the values are used up. */
const queue = (...values) => () => {
  if (values.length === 0) throw new Error("the fixture has no reply left");
  return values.shift();
};

// The fixtures of each case that needs more than the base: one fixtures object for the view of the case, or a list of them for a case with
// two views. A held fixture is released by the replay after the last step of the case.
const FIXTURES = {
  // The probe plugin lists the package of other in its dependencies, so other's declared status is followed; other2 is not a dependency.
  "view-calls-status-watch-dependency": () => ({ ...base(), dependencies: { "@fixture/plugin-other": { plugin: "other", status: [{ name: "other.count" }] } }, statuses: { "other.count": null } }),
  // The probe-reader plugin lists the package of other in its dependencies, so other's project data is read and followed; other2 is not a dependency.
  "view-calls-data-dependency": dependencyBase,
  "view-calls-data-dependency-refused": dependencyBase,
  "view-calls-cancel-pending": (releases) => ({ ...base(), sidecar: { "fixture-sidecar": () => new Promise((resolve) => releases.push(() => resolve(null))) } }),
  "view-calls-pending-id-refused": (releases) => ({ ...base(), sidecar: { "fixture-sidecar": () => new Promise((resolve) => releases.push(() => resolve(null))) } }),
  // The first run of probe-tool is held until the replay ends, and its cancel ends the call; the second run answers its result.
  "view-calls-program-run": (releases) => {
    let runs = 0;
    return {
      ...base(),
      programs: {
        "probe-tool": () => {
          runs += 1;
          if (runs === 1) return new Promise((resolve) => releases.push(() => resolve(null)));
          return { code: 0, stdout: "ok", stderr: "", truncated: { stdout: false, stderr: false } };
        },
      },
    };
  },
  "view-calls-clipboard-persist-png": () => ({ ...base(), clipboard: { persistPNG: () => ({ path: "/tmp/it's.png" }) } }),
  "view-calls-clipboard-read-png-invalid": () => ({ ...base(), clipboard: { readPNG: () => ({ present: true, type: "png", data: "AQID" }) } }),
  "view-calls-clipboard-read-png": () => ({
    ...base(),
    clipboard: { readPNG: queue({ present: true, type: "png", binary: BINARY_ID }, { present: false, type: "png" }) },
  }),
  "view-calls-clipboard-read-text": () => ({ ...base(), clipboard: { read: () => "text value" } }),
  "view-calls-clipboard-write-text": () => ({ ...base(), clipboard: { writeText: () => null } }),
  "view-calls-command-core-cids": () => ({ ...base(), commands: { "core.tab.select": () => null } }),
  "view-calls-command-core-owned": () => ({
    ...base(),
    commands: { "core.tab.select": () => null, "probe.run": () => ({ owned: true }) },
  }),
  "view-calls-command-core-shortcut": () => {
    // The first run of the row succeeds and its second run fails.
    let runs = 0;
    return {
      ...base(),
      shortcuts: [{ key: "cmd+k", owner: "workbench", command: "core.library.search.focus" }],
      commands: {
        "core.library.search.focus": () => {
          runs += 1;
          if (runs > 1) throw new Error("no focus target");
          return null;
        },
        "core.tab.select": () => { throw new Error("no focus target"); },
      },
    };
  },
  "view-calls-command-owned-cids": () => ({ ...base(), commands: { "probe.run": () => ({ owned: true }) } }),
  "view-calls-command-owned-no-cids": () => ({ ...base(), commands: { "probe.run": () => null } }),
  "view-calls-command-run-surface": () => ({ ...base(), commands: { "probe.run": () => ({ owned: true }) } }),
  "view-calls-composition-calls": () => ({
    ...base(),
    composition: {
      declaration: () => DECLARED_COMPOSITION,
      place: () => null,
      report: () => null,
      document: {
        attach: () => ({ history: false }), load: () => null, zoom: () => null, go: () => true, post: () => null,
        subscribe: () => ({ handle: 3 }), unsubscribe: () => null, detach: () => null,
      },
      image: { attach: () => null, focus: () => null, caret: () => null, text: () => null, detach: () => null },
    },
  }),
  "view-calls-core-file-place": () => ({ ...base(), commands: { "core.file.place": () => null } }),
  "view-calls-data-no-project": () => ({ ...base(), project: null }),
  "view-calls-data-on": () => [base(), { ...base(), surface: "probe-surface-none", project: null }],
  "view-calls-document-subscribe": () => ({
    ...base(),
    composition: { document: { subscribe: queue({ handle: 7 }, {}) } },
  }),
  "view-calls-log-levels-on": () => ({ ...base(), logLevels: LEVELS }),
  "view-calls-native-call": () => ({ ...base(), native: { exposureReply: () => null } }),
  "view-calls-restart-tab-state": () => {
    let stored = null;
    return { ...base(), state: { read: () => stored, write: (value) => { stored = value; } } };
  },
  "view-calls-settings": () => ({ ...base(), settings: { home: "https://example.test" } }),
  "view-calls-shortcuts-read": () => ({
    ...base(),
    shortcuts: [...SHORTCUT_ROWS, { key: "cmd+x", owner: "page", command: "core.none" }],
  }),
  "view-calls-sidecar-send": () => ({ ...base(), sidecar: { "fixture-sidecar": () => null } }),
  "view-calls-subscription-calls": () => base(),
  "view-calls-surface-menu": () => [
    { ...base(), commands: { "core.surface.menu": () => null }, menu: { declared: true, frame: { x: 100, y: 200 } } },
    { ...base(), plugin: "probe-bare", surface: "probe-bare-surface", declarations: {} },
  ],
  "view-calls-tab-state-read": () => ({ ...base(), state: { read: () => ({ count: 2 }), write: () => {} } }),
  "view-calls-tab-state-write": () => ({ ...base(), state: { read: () => null, write: () => {} } }),
  "view-calls-text-size": () => ({ ...base(), textSize: 1.5 }),
  "view-calls-status-unwatch-closed-surface": () => ({
    ...base(),
    surfaces: [{ surface: "tab-a", plugin: "probe" }, { surface: "spc-aaaaaa/left/files.tree", plugin: "probe" }, { surface: "tab-z", plugin: "probe" }],
    statuses: { "tab-z probe.lines": null },
  }),
  "view-calls-status-watch-core": () => ({ ...base(), statuses: { "core.grid": null, "probe.count": null } }),
  "view-events-data": () => ({ ...base(), data: { ...base().data, marks: { schema: { type: "integer" }, default: 0 } } }),
  "view-events-left-out": () => base(),
  "view-events-log-levels": () => ({ ...base(), logLevels: LEVELS }),
  "view-events-ordered-delivery": (releases) => {
    // The reply of the first push is held until the replay releases it. The second push must start after that reply, and a push that
    // starts earlier is refused with its own error, which the check of the case reports.
    let first = true;
    let released = false;
    return {
      ...base(),
      viewEvent: () => {
        if (first) {
          first = false;
          return new Promise((resolve) => releases.push(() => { released = true; resolve(true); }));
        }
        if (!released) throw new Error("the second push started before the reply of the first push");
        return null;
      },
    };
  },
  "view-events-push-refused": () => ({
    ...base(),
    viewEvent: () => { throw new Error("probe-surface has no ready document"); },
  }),
  "view-events-run-start": () => base(),
  "view-events-settings": () => ({ ...base(), settings: { home: "https://example.test" } }),
  "view-events-sidecar-route": () => base(),
  "view-events-document-stream": () => base(),
  "view-events-status-core": () => ({ ...base(), statuses: { "core.grid": { tabs: 2 }, "core.focus": 1 } }),
  "view-events-status-run": () => ({ ...base(), run: true, statuses: { "core.grid": { w: 1 } } }),
  "view-events-status-surface": () => base(),
  "view-events-text-size": () => base(),
};

/** The observed state that the case checks beyond its replies and pushes. */
const CHECKS = {
  "view-calls-error-line": (observed) => assert.deepEqual(observed.errors, ["surface probe-surface save: disk full"]),
  "view-calls-tab-reports": (observed) => assert.deepEqual(
    [observed.tab.title, observed.tab.footer, observed.tab.directory, observed.tab.modified, observed.tab.error],
    ["문서", "1 of 3", "/tmp", true, "저장하지 못했습니다"],
  ),
  "view-calls-tab-keep-off": (observed) => assert.deepEqual(observed.tab.keep, [{ reason: "busy", on: true }, { reason: "busy", on: false }]),
  "view-calls-tab-notify-keep": (observed) => assert.deepEqual(observed.tab.notify, [{ text: "끝났습니다", policy: "system" }]),
  "view-calls-data-get-set": (observed) => assert.deepEqual(observed.data, [{ key: "note", value: "kept" }]),
  "view-calls-links-open": (observed) => assert.deepEqual(observed.links, ["https://example.test"]),
  "view-calls-command-core-cids": (observed) => assert.deepEqual(observed.commands, [{ name: "core.tab.select", params: { tab: "current" }, cids: ["p1700000000000.5"] }]),
  "view-calls-command-core-shortcut": (observed) => assert.deepEqual(observed.events, [
    { level: "error", event: "workbench.input.shortcut.failed", fields: { plugin: "probe", command: "core.library.search.focus" } },
  ]),
  "view-calls-contributions-fail": (observed) => assert.deepEqual(observed.contributions, [
    { plugin: "two", point: "probe.language", index: 1, reason: "extend is not a function" },
  ]),
  // The second push is not refused: it starts after the held reply of the first push.
  "view-events-ordered-delivery": (observed) => assert.deepEqual(observed.errors, []),
  // The refused push is reported with the event name and the refusal text, and the report is the only record of it.
  "view-events-push-refused": (observed) => assert.deepEqual(observed.errors, ["view event exposure-request: probe-surface has no ready document"]),
  // The second send has no sidecar name and is refused before the send, so the only send is the first one.
  "view-calls-sidecar-send": (observed) => assert.deepEqual(observed.sidecar, [
    { sidecar: "fixture-sidecar", id: "probe-surface", body: { n: 1 }, cids: ["c1"] },
  ]),
};

// The change of each state of the window, applied to the host of a view through its change methods (createTestHost).
const CHANGE = {
  settings: (change, body) => change.settings(body.value),
  textSize: (change, body) => change.textSize(body.value),
  logLevels: (change, body) => change.logLevels(body.value),
  status: (change, body) => change.status(body.name, body.value, body.surface),
  run: (change, body) => change.run(body.value),
  // A data change names the dependency of the plugin that it changes, or none for the data of the plugin itself.
  data: (change, body) => (body.plugin === undefined ? change.data(body.key, body.value) : change.dependencyData(body.plugin, body.key, body.value)),
  leftOut: (change, body) => change.leftOut(body.value),
  frame: (change, body) => change.frame(body.value),
};

/** The payload of a reply or a push without the members that the page adds for the workbench. */
const withoutPage = ({ page, generation, surface, ...rest }) => rest;
const flush = async () => {
  for (let turn = 0; turn < 50; turn += 1) await null;
};

/**
 * Replays one case: the notices and the listen steps drive the hosts, the change steps set the state of the window, and the replies and the
 * pushes of the views are compared with the viewReply and viewEvent steps of the case, in order.
 */
async function replay(name) {
  const kase = JSON.parse(readFileSync(new URL(`${name}.json`, CASES), "utf8"));
  const releases = [];
  const views = FIXTURES[name]?.(releases) ?? base();
  // One test host for each view of the case, by surface id. A host event that names no view goes to the first view.
  const hosts = new Map((Array.isArray(views) ? views : [views]).map((fixtures) => [fixtures.surface, createTestHost(fixtures)]));
  const [first] = hosts.values();
  // A case with one view sends each view call to that view, whichever surface the case names for it.
  const hostOf = (surface) => {
    if (hosts.size === 1) return first;
    if (!hosts.has(surface)) throw new Error(`${name}: the case has no view of ${surface}`);
    return hosts.get(surface);
  };
  const replies = [];
  const started = [];
  // The pushes of the views in the order that they were made: the record of each host is read after each step.
  const pushes = [];
  const read = new Map([...hosts.keys()].map((surface) => [surface, 0]));
  const readPushes = () => {
    for (const [surface, host] of hosts) {
      const entries = host.observed.document;
      for (const entry of entries.slice(read.get(surface))) {
        if (entry.name === "viewEvent") pushes.push(entry.payload);
      }
      read.set(surface, entries.length);
    }
  };
  for (const step of kase.steps) {
    if ("notice" in step) {
      const { event, payload } = step.notice;
      if (event === "view-call") {
        const { options } = hostOf(payload.surface);
        if (payload.cancel === true) {
          await answerViewCall(payload, options);
        } else {
          started.push(answerViewCall(payload, options).then(
            (result) => replies.push({ id: payload.id, result: result ?? null }),
            (error) => replies.push({ id: payload.id, error: { code: -32000, message: error?.message ?? String(error) } }),
          ));
        }
      } else {
        first.push(event, payload);
      }
    } else if ("listen" in step) {
      const { event } = step.listen;
      const { options } = first;
      if (event === "sidecar-failure") await options.runtime.subscribe.sidecarFailure(options.surface);
      else await options.runtime.subscribe.native(event);
    } else if ("close" in step) {
      // The case closes its view here: the subscriptions of the view end, so the changes after this step push nothing.
      await first.close();
    } else if ("change" in step) {
      const { state } = step.change;
      const apply = CHANGE[state];
      if (apply === undefined) throw new Error(`${name}: ${state} is not a state of the window`);
      // A frame belongs to the view that it names; every other state of the window reaches each view of the case.
      const targets = state === "frame" ? [hostOf(step.change.view)] : [...hosts.values()];
      for (const host of targets) apply(host.change, step.change);
    }
    await flush();
    readPushes();
  }
  for (const release of releases.splice(0)) release();
  for (const host of hosts.values()) await host.settled();
  await Promise.all(started);
  await flush();
  for (const host of hosts.values()) await host.settled();
  readPushes();

  const expectedReplies = kase.steps.filter((step) => step.call?.name === "viewReply").map(({ call }) => withoutPage(call.payload));
  assert.deepEqual(JSON.parse(JSON.stringify(replies)), expectedReplies, `${name}: the replies of the view`);
  const expectedPushes = kase.steps.filter((step) => step.call?.name === "viewEvent")
    .map(({ call }) => ({ event: call.payload.event, data: call.payload.data }));
  assert.deepEqual(pushes, expectedPushes, `${name}: the pushes of the view`);
  for (const [surface, host] of hosts) assert.deepEqual(host.observed.failures, [], `${name}: a route of ${surface} has no fixture`);
  CHECKS[name]?.(first.observed);
}

const NAMES = readdirSync(CASES)
  .filter((file) => /^view-(calls|events)-.*\.json$/.test(file))
  .map((file) => file.slice(0, -".json".length))
  .sort();

for (const name of NAMES) {
  test(`the page-wire case ${name} replays through answerViewCall`, async () => {
    await replay(name);
  });
}

test("a route without a fixture rejects with its name and records the failure", async () => {
  const host = createTestHost(base());
  await assert.rejects(
    answerViewCall({ id: 1, command: "runtime.native.call", params: { name: "exposureReply", payload: { id: 7, result: "a" } } }, host.options),
    { message: "view host: native.exposureReply has no fixture" },
  );
  assert.deepEqual(host.observed.failures, ["view host: native.exposureReply has no fixture"]);
});

test("a route with a declared fault rejects with the fault message", async () => {
  const host = createTestHost({ ...base(), faults: { "native.exposureReply": "host refused the reply" }, native: { exposureReply: () => null } });
  await assert.rejects(
    answerViewCall({ id: 1, command: "runtime.native.call", params: { name: "exposureReply", payload: { id: 7, result: "a" } } }, host.options),
    { message: "host refused the reply" },
  );
  assert.deepEqual(host.observed.failures, []);
});

test("a data value that is set reads back and notifies the subscription of the view", async () => {
  const host = createTestHost(base());
  await answerViewCall({ id: 1, command: "runtime.data.on" }, host.options);
  await answerViewCall({ id: 2, command: "runtime.data.set", params: { key: "note", value: "kept" } }, host.options);
  assert.equal(await answerViewCall({ id: 3, command: "runtime.data.get", params: { key: "note" } }, host.options), "kept");
  await flush();
  await host.settled();
  assert.deepEqual(host.observed.document.filter((entry) => entry.name === "viewEvent").map(({ payload }) => payload), [
    { event: "data", data: { key: "note" } },
  ]);
});

test("a change of a run state that does not change the run pushes nothing", async () => {
  const host = createTestHost({ ...base(), run: true });
  await answerViewCall({ id: 1, command: "runtime.textSize.on" }, host.options);
  host.change.run(true);
  await flush();
  await host.settled();
  assert.deepEqual(host.observed.document, [], "a run that stays active pushed an event");
  assert.throws(() => host.change.run("yes"), { message: "change.run requires true or false" });
});

test("settled resolves after the pending fixture promise resolves", async () => {
  let release = () => {};
  const host = createTestHost({ ...base(), sidecar: { "fixture-sidecar": () => new Promise((resolve) => { release = () => resolve(null); }) } });
  const answer = answerViewCall({
    id: 1, command: "runtime.sidecar.send", params: { id: "probe-surface", sidecar: "fixture-sidecar", body: 1, cids: [] },
  }, host.options);
  await flush();
  let done = false;
  const waiting = host.settled().then(() => { done = true; });
  await flush();
  assert.equal(done, false, "settled must wait while the fixture promise is pending");
  release();
  await waiting;
  assert.equal(done, true);
  assert.equal(await answer, null);
});
