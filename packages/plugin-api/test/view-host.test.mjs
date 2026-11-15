// Replays the page-wire cases of the view calls and the view events (docs/spec/cases/page-wire/README.md) against answerViewCall, with the
// options that createTestHost builds. The replies of the view (each viewReply of the case) and the pushes of the view (each viewEvent of
// the case) are compared in order. The notices of the case drive the host: a view-call notice starts answerViewCall, a cancel notice
// cancels it, a listen step registers the subscription of the page, and any other notice is delivered to the subscriptions as a host event.
// The host calls that the page makes for the workbench (workspace, exposureForward, the log, the window) are not compared.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { answerViewCall } from "../view-answer.js";
import { createTestHost } from "../view-host.js";

const CASES = new URL("../../../docs/spec/cases/page-wire/", import.meta.url);

// The cases that do not replay, each with its reason. A case replays when its replies and pushes depend on the plugin and on the fixtures.
const EXCLUDED = {
  "view-calls-import": "The case records the start of the workbench page: the module imports and the clock of the first log flush.",
  "view-calls-changed": "The status value reaches the observers of the exposure registry of the window, and the case expects the watch of the view to follow the registry; createTestHost has no source that changes a status.",
  "view-calls-data-on": "The case serves two views, one with the project and one without it, and createTestHost serves one view.",
  "view-calls-log-levels-on": "The stored log levels change through the log gate of the page, which createTestHost does not change.",
  "view-calls-settings": "The case changes the settings and the theme of the window (setTheme, setMenuLanguage), which createTestHost does not drive.",
  "view-calls-text-size": "The text scale changes through the window, which createTestHost does not drive.",
  "view-calls-status-watch-core": "The core status core.grid changes through its module in the core, which createTestHost does not drive.",
  "view-calls-status-unwatch-closed-surface": "The surface tab-z closes in the window between the watch and the unwatch, and createTestHost has no surface close.",
  "view-calls-surface-menu": "The case serves two views (probe and probe-bare), and createTestHost serves one view.",
  "view-calls-tab-focus": "The check of the focused element {name, index} is the focus rule of the workbench (view-focus.js), which this package does not hold; createTestHost records the value without that check.",
  "view-events-close": "The case listens to probe.changed, which the plugin gate refuses (PLUGIN_NATIVE_EVENTS of view-answer.js), so the registration that the case records is refused by the gate of the page.",
  "view-events-data": "The case pushes the key marks, which the workbench changes outside any view call; createTestHost changes project data only through a view call.",
  "view-events-left-out": "The case listens to probe.event, which the plugin gate refuses (see view-events-close), and it depends on the placement that leaves out the section surface.",
  "view-events-log-levels": "The stored log levels change through the log gate of the page, which createTestHost does not change.",
  "view-events-native-once": "The case listens to probe.changed, which the plugin gate refuses (see view-events-close).",
  "view-events-ordered-delivery": "The case holds the reply of a push, which createTestHost does not hold, and listens to input, which the plugin gate refuses.",
  "view-events-push-refused": "The case listens to probe.changed, which the plugin gate refuses (see view-events-close).",
  "view-events-registrar-function": "The case tests a registrar that the page supplies to createViewSubscriptions; createTestHost supplies its own registrars.",
  "view-events-registrar-throws": "The case tests a registrar that the page supplies to createViewSubscriptions; createTestHost supplies its own registrars.",
  "view-events-run-start": "The run start belongs to the run state of the workbench, which createTestHost has no driver for.",
  "view-events-settings": "The settings change through the workbench, which createTestHost does not drive.",
  "view-events-status-core": "The status values change through the registry of the window, which createTestHost does not drive.",
  "view-events-status-refused": "The case records no step; the refusal that it names is a registrar of the workbench registry, which createTestHost does not supply.",
  "view-events-status-run": "The status values held during a run belong to the run state of the workbench, which createTestHost has no driver for.",
  "view-events-status-surface": "The status values of the section and tab surfaces come from the registry of the window, which createTestHost does not drive.",
  "view-events-text-size": "The text scale changes through the window, which createTestHost does not drive.",
};

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
const plugin = (id, manifest) => ({ id, package: `@scope/plugin-${id}`, version: "0.1.0", manifest: { id, name: id, ...manifest } });
// The installed plugins: probe declares the extension point language, and one and two contribute to it. Entry 0 of two names a range that
// the point does not accept, so only its entry 1 is connected.
const INSTALLED = () => [
  plugin("probe", { extends: { language: { version: "1.0.0", schema: { type: "object" } } } }),
  plugin("one", { contributes: { "probe.language": [{ range: "^1.0.0", module: "ui/one.js", name: "one" }] } }),
  plugin("two", { contributes: { "probe.language": [{ range: "^2.0.0", module: "ui/skipped.js", name: "skipped" }, { range: "^1.0.0", module: "ui/two.js", name: "two" }] } }),
];
const BINARY_ID = "0123456789abcdef0123456789abcdef";
const DECLARED_COMPOSITION = { kind: "view", regions: [{ name: "doc", kind: "document", input: "native" }, { name: "picture", kind: "image" }], overlays: [] };

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

/** A fixture that answers its values in order, and fails when the values are used up. */
const queue = (...values) => () => {
  if (values.length === 0) throw new Error("the fixture has no reply left");
  return values.shift();
};

// The fixtures of each case that needs more than the base. A held fixture is released by the replay after the last step of the case.
const FIXTURES = {
  "view-calls-cancel-pending": (releases) => ({ ...base(), sidecar: { "fixture-sidecar": () => new Promise((resolve) => releases.push(() => resolve(null))) } }),
  "view-calls-pending-id-refused": (releases) => ({ ...base(), sidecar: { "fixture-sidecar": () => new Promise((resolve) => releases.push(() => resolve(null))) } }),
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
  "view-calls-document-subscribe": () => ({
    ...base(),
    composition: { document: { subscribe: queue({ handle: 7 }, {}) } },
  }),
  "view-calls-native-call": () => ({ ...base(), native: { exposureReply: () => null } }),
  "view-calls-restart-tab-state": () => {
    let stored = null;
    return { ...base(), state: { read: () => stored, write: (value) => { stored = value; } } };
  },
  "view-calls-shortcuts-read": () => ({
    ...base(),
    shortcuts: [...SHORTCUT_ROWS, { key: "cmd+x", owner: "page", command: "core.none" }],
  }),
  "view-calls-sidecar-send": () => ({ ...base(), sidecar: { "fixture-sidecar": () => null } }),
  "view-calls-subscription-calls": () => base(),
  "view-calls-tab-state-read": () => ({ ...base(), state: { read: () => ({ count: 2 }), write: () => {} } }),
  "view-calls-tab-state-write": () => ({ ...base(), state: { read: () => null, write: () => {} } }),
  "view-events-sidecar-route": () => base(),
  "view-events-document-stream": () => base(),
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
  "view-calls-command-core-cids": (observed) => assert.deepEqual(observed.commands, [{ name: "core.tab.select", params: {}, cids: ["p1700000000000.5"] }]),
  "view-calls-command-core-shortcut": (observed) => assert.deepEqual(observed.events, [
    { level: "error", event: "workbench.input.shortcut.failed", fields: { plugin: "probe", command: "core.library.search.focus" } },
  ]),
  "view-calls-contributions-fail": (observed) => assert.deepEqual(observed.contributions, [
    { plugin: "two", point: "probe.language", index: 1, reason: "extend is not a function" },
  ]),
  // The second send has no sidecar name and is refused before the send, so the only send is the first one.
  "view-calls-sidecar-send": (observed) => assert.deepEqual(observed.sidecar, [
    { sidecar: "fixture-sidecar", id: "probe-surface", body: { n: 1 }, cids: ["c1"] },
  ]),
};

/** The payload of a reply or a push without the members that the page adds for the workbench. */
const withoutPage = ({ page, generation, surface, ...rest }) => rest;
const flush = async () => {
  for (let turn = 0; turn < 50; turn += 1) await null;
};

/**
 * Replays one case: the notices and the listen steps drive the host, and the replies and the pushes of the view are compared with the
 * viewReply and viewEvent steps of the case, in order.
 */
async function replay(name) {
  const kase = JSON.parse(readFileSync(new URL(`${name}.json`, CASES), "utf8"));
  const releases = [];
  const fixtures = FIXTURES[name]?.(releases) ?? base();
  const host = createTestHost(fixtures);
  const { options } = host;
  const replies = [];
  const started = [];
  for (const step of kase.steps) {
    if ("notice" in step) {
      const { event, payload } = step.notice;
      if (event === "view-call") {
        if (payload.cancel === true) {
          await answerViewCall(payload, options);
        } else {
          started.push(answerViewCall(payload, options).then(
            (result) => replies.push({ id: payload.id, result: result ?? null }),
            (error) => replies.push({ id: payload.id, error: { code: -32000, message: error?.message ?? String(error) } }),
          ));
        }
      } else {
        host.push(event, payload);
      }
    } else if ("listen" in step) {
      const { event } = step.listen;
      if (event === "sidecar-failure") await options.runtime.subscribe.sidecarFailure(options.surface);
      else await options.runtime.subscribe.native(event);
    }
    await flush();
  }
  for (const release of releases.splice(0)) release();
  await host.settled();
  await Promise.all(started);
  await flush();
  await host.settled();

  const expectedReplies = kase.steps.filter((step) => step.call?.name === "viewReply").map(({ call }) => withoutPage(call.payload));
  assert.deepEqual(JSON.parse(JSON.stringify(replies)), expectedReplies, `${name}: the replies of the view`);
  const expectedPushes = kase.steps.filter((step) => step.call?.name === "viewEvent")
    .map(({ call }) => ({ event: call.payload.event, data: call.payload.data }));
  const observedPushes = host.observed.document.filter((entry) => entry.name === "viewEvent").map(({ payload }) => payload);
  assert.deepEqual(observedPushes, expectedPushes, `${name}: the pushes of the view`);
  assert.deepEqual(host.observed.failures, [], `${name}: a route has no fixture`);
  CHECKS[name]?.(host.observed);
}

const NAMES = readdirSync(CASES)
  .filter((file) => /^view-(calls|events)-.*\.json$/.test(file))
  .map((file) => file.slice(0, -".json".length))
  .sort();

test("every excluded case names an existing case and gives its reason", () => {
  for (const [name, reason] of Object.entries(EXCLUDED)) {
    assert.ok(NAMES.includes(name), `${name} is not a view case`);
    assert.ok(reason.length > 0, `${name} has no reason`);
  }
});

for (const name of NAMES.filter((item) => !Object.hasOwn(EXCLUDED, item))) {
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
