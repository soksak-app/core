// Checks the host mode of the view document of the testing module (testing.js of this package): openView answers each call of the
// view page through answerViewCall with the options of createTestHost, over the real view bridge and the real exposure of the SDK.
// The view page is the bridge calls below, which the page module of a plugin makes through the same bridge.
import assert from "node:assert/strict";
import test from "node:test";
import { openView, turn } from "../testing.js";

const START = { surface: "probe-surface", params: null, origin: { directory: null }, project: null, section: null };
const PROJECT = { id: "p1", root: "/projects/p1" };

/** The fixtures of the view of plugin probe. Each call builds new fixtures, because a fixture can hold a state of its own. */
const fixtures = (extra = {}) => ({
  surface: "probe-surface",
  declarations: { status: [], commands: [], element: [] },
  contributions: [],
  project: PROJECT,
  data: { note: { schema: { type: "string" }, default: "default" } },
  sidecars: ["fixture-sidecar"],
  ...extra,
});

test("a data value that the view sets is read back by the view through the host", { timeout: 5000 }, async () => {
  const view = await openView("probe", { start: START, host: fixtures() });
  assert.equal(await view.bridge.runtime.data.get("note"), "default");
  await view.bridge.runtime.data.set("note", "written");
  assert.equal(await view.bridge.runtime.data.get("note"), "written");
  await view.settled();
  await view.close();
});

test("a call to a route without a fixture rejects in the view and close names the route", { timeout: 5000 }, async () => {
  const view = await openView("probe", { start: START, host: fixtures() });
  await assert.rejects(view.bridge.runtime.clipboard.writeText("text"), /view host: clipboard.writeText has no fixture/);
  await view.settled();
  await assert.rejects(view.close(), /view host: clipboard.writeText has no fixture/);
});

test("a declared fault point rejects the call of the view with its message", { timeout: 5000 }, async () => {
  const view = await openView("probe", { start: START, host: fixtures({ faults: { "clipboard.read": "clipboard is locked" } }) });
  await assert.rejects(view.bridge.runtime.clipboard.read("text"), /clipboard is locked/);
  await view.settled();
  await view.close();
});

test("a tab title that the view reports is recorded in the observed tab", { timeout: 5000 }, async () => {
  const view = await openView("probe", { start: START, host: fixtures() });
  await view.bridge.calls.request("tab.title", "Probe title");
  await view.settled();
  assert.equal(view.observed.tab.title, "Probe title");
  await view.close();
});

test("a sidecar send reaches the sidecar fixture and its reply returns to the view", { timeout: 5000 }, async () => {
  const view = await openView("probe", {
    start: START,
    host: fixtures({ sidecar: { "fixture-sidecar": (body) => ({ echo: body }) } }),
  });
  const reply = await view.bridge.runtime.sidecar("fixture-sidecar").send("probe-surface", { n: 1 });
  assert.deepEqual(reply, { echo: { n: 1 } });
  await view.settled();
  assert.deepEqual(view.observed.sidecar, [{ sidecar: "fixture-sidecar", id: "probe-surface", body: { n: 1 }, cids: [] }]);
  await view.close();
});

test("cases and host together, or neither, is refused with a TypeError that names the options", { timeout: 5000 }, async () => {
  const cases = new URL("../../../docs/spec/cases/view-wire/", import.meta.url);
  await assert.rejects(openView("probe", { cases, host: fixtures(), start: START }), {
    name: "TypeError",
    message: "openView takes either the case folder `cases` or the host fixtures `host`, not both",
  });
  await assert.rejects(openView("probe", { start: START }), {
    name: "TypeError",
    message: /openView requires the case folder `cases`/,
  });
});

test("host fixtures that name a plugin are refused, because the name of the view is its plugin", { timeout: 5000 }, async () => {
  await assert.rejects(openView("probe", { start: START, host: fixtures({ plugin: "other" }) }), {
    name: "TypeError",
    message: "openView host fixtures take no plugin: the plugin of the view is the name",
  });
});

test("a document state that the host pushes reaches the listener of the view", { timeout: 5000 }, async () => {
  const view = await openView("probe", { start: START, host: fixtures() });
  const states = [];
  await view.bridge.runtime.native.on("document-state", (data) => states.push(data));
  await view.push("document-state", { surface: "probe-surface", document: "page", state: { url: "https://example.invalid/" } });
  await view.settled();
  assert.deepEqual(states, [{ surface: "probe-surface", document: "page", state: { url: "https://example.invalid/" } }]);
  await view.close();
});

// The page module of the test view: its bridge, its ready promise and the messages that its sidecar listener received.
const PAGE = new URL("./fixtures/probe-page.js", import.meta.url);
const PROBE = {
  status: [{ name: "probe.state" }],
  commands: [{ name: "probe.echo" }, { name: "probe.fail" }],
  element: [],
};

test("a page module loaded into the view uses its own bridge, and its data calls reach the host", { timeout: 5000 }, async () => {
  const view = await openView("probe", { start: START, declarations: PROBE, host: fixtures({ declarations: PROBE }) });
  const page = await view.load(PAGE);
  await page.ready;
  assert.equal(await page.bridge.runtime.data.get("note"), "default");
  await page.bridge.runtime.data.set("note", "written");
  assert.equal(await page.bridge.runtime.data.get("note"), "written");
  await view.settled();
  await view.close();
});

test("a sidecar message routed to the view reaches the sidecar listener of the page, and a session without a route is refused", { timeout: 5000 }, async () => {
  const view = await openView("probe", { start: START, declarations: PROBE, host: fixtures({ declarations: PROBE }) });
  const page = await view.load(PAGE);
  await page.ready;
  view.sidecarMessage("fixture-sidecar", "probe-surface", { body: { n: 2 }, cids: ["c1"] });
  view.sidecarMessage("fixture-sidecar", "probe-surface", { body: { n: 3 } });
  await view.settled();
  assert.deepEqual(page.sidecarMessages, [{ body: { n: 2 }, cids: ["c1"] }, { body: { n: 3 }, cids: [] }]);
  assert.throws(() => view.sidecarMessage("fixture-sidecar", "other-session", { body: {} }), {
    message: "view host: no route for sidecar fixture-sidecar session other-session: the view has no subscription for it",
  });
  await view.close();
});

test("a request of the host runs the command of the page and resolves with its result, or rejects with its error", { timeout: 5000 }, async () => {
  const view = await openView("probe", { start: START, declarations: PROBE, host: fixtures({ declarations: PROBE }) });
  const page = await view.load(PAGE);
  await page.ready;
  assert.deepEqual(await view.request("probe.echo", { n: 4 }), { echo: { n: 4 } });
  await assert.rejects(view.request("probe.fail", null), { message: "probe failed" });
  await view.settled();
  await view.close();
});

test("view.bridge is refused once a page is loaded, and a page is refused once view.bridge was read", { timeout: 5000 }, async () => {
  const loaded = await openView("probe", { start: START, declarations: PROBE, host: fixtures({ declarations: PROBE }) });
  await loaded.load(PAGE);
  assert.throws(() => loaded.bridge, {
    message: "view probe has a page loaded: its page module holds the view bridge, so view.bridge is not available",
  });
  await loaded.close();

  const read = await openView("probe", { start: START, declarations: PROBE, host: fixtures({ declarations: PROBE }) });
  assert.equal(typeof read.bridge.runtime.data.get, "function");
  await assert.rejects(read.load(PAGE), {
    message: "view probe already has a bridge: view.bridge was read, so a page module cannot load into the same view",
  });
  await read.settled();
  await read.close();
});

// The page modules of the host-mode tests: the bare globals of a page, the subscriptions to the changes of the window, and the start values.
const PAGE_GLOBALS = new URL("./fixtures/page-globals.js", import.meta.url);
const PAGE_CHANGES = new URL("./fixtures/page-changes.js", import.meta.url);
const PAGE_START = new URL("./fixtures/page-start.js", import.meta.url);

test("a page module reads the bare globals of a browser page from the window of the view", { timeout: 5000 }, async () => {
  const view = await openView("probe", { start: START, host: fixtures() });
  try {
    const page = await view.load(PAGE_GLOBALS);
    assert.deepEqual(page.mount(), { rootIsElement: true, isWindowDocument: true, keyboardEvent: true, mouseEvent: true, frame: "function" });
    assert.notEqual(view.window.document.getElementById("page-root"), null);
    view.window.dispatchEvent(new view.window.KeyboardEvent("keydown", { key: "a" }));
    assert.deepEqual(page.keys, ["a"]);
  } finally {
    await view.close();
  }
});

test("each change of the window after open reaches the page subscriptions through view.change", { timeout: 5000 }, async () => {
  const view = await openView("probe", { start: START, declarations: PROBE, host: fixtures({ declarations: PROBE }) });
  try {
    assert.deepEqual(Object.keys(view.change).sort(), ["data", "dependencyData", "frame", "leftOut", "logLevels", "run", "settings", "status", "textSize"]);
    const page = await view.load(PAGE_CHANGES);
    await page.ready;
    await view.change.settings({ theme: "light" });
    await view.change.textSize(1.25);
    await view.change.data("note", "written");
    await view.change.status("probe.state", { ok: false });
    await view.settled();
    assert.deepEqual(page.seen, [
      ["settings", { theme: "light" }],
      ["textSize", 1.25],
      ["data", "note"],
      ["status", { ok: false }],
    ]);
  } finally {
    await view.close();
  }
});

test("a log batch refused by the host fails with the fault message, and its events are not stored", { timeout: 5000 }, async () => {
  const view = await openView("probe", { start: START, host: fixtures({ faults: { "command.runtime.log": "log store is full" } }) });
  try {
    await assert.rejects(view.bridge.calls.request("runtime.log", { action: "batch", events: [{ event: "probe.refused" }] }), {
      message: "log store is full",
    });
    await view.settled();
    assert.deepEqual(view.events, []);
  } finally {
    await view.close();
  }
});

test("a log batch without a fault is stored in the events of the view in arrival order", { timeout: 5000 }, async () => {
  const view = await openView("probe", { start: START, host: fixtures() });
  try {
    await view.bridge.calls.request("runtime.log", { action: "batch", events: [{ event: "probe.first" }] });
    await view.bridge.calls.request("runtime.log", { action: "batch", events: [{ event: "probe.second" }] });
    await view.settled();
    // The view also stores the page records that it writes from its start (page.start, page.theme.applied), which the order of the
    // two batches of the test leaves out.
    assert.deepEqual(view.events.map((event) => event.event).filter((event) => event.startsWith("probe.")), ["probe.first", "probe.second"]);
  } finally {
    await view.close();
  }
});

test("a view opened without start values has no window.sokSurface, and a page that reads it refuses to load", { timeout: 5000 }, async () => {
  const view = await openView("probe", { start: null, host: fixtures() });
  try {
    assert.equal(view.window.sokSurface, undefined);
    await assert.rejects(view.load(PAGE_START), { name: "TypeError", message: /reading 'declarations'/ });
  } finally {
    await view.close();
  }
});

test("the calls of the view are kept in the order in which the view made them", { timeout: 5000 }, async () => {
  const view = await openView("probe", { start: START, host: fixtures() });
  try {
    await view.bridge.calls.request("tab.title", "First");
    await view.bridge.calls.request("tab.footer", "Second");
    await view.bridge.calls.request("tab.title", "Third");
    await view.settled();
    assert.deepEqual(view.calls.filter(({ command }) => command.startsWith("tab.")), [
      { command: "tab.title", params: "First" },
      { command: "tab.footer", params: "Second" },
      { command: "tab.title", params: "Third" },
    ]);
  } finally {
    await view.close();
  }
});

const PAGE_FILES = new URL("./fixtures/plugin/pages/files.js", import.meta.url);
const PAGE_TIMERS = new URL("./fixtures/page-timers.js", import.meta.url);
const PAGE_DATA = new URL("./fixtures/page-data.js", import.meta.url);
const PAGE_DOCUMENT = new URL("./fixtures/page-document.js", import.meta.url);

test("a page fetches the files of its plugin relative to its module, and a path outside the plugin or a missing file is a 404", { timeout: 5000 }, async () => {
  const view = await openView("probe", { start: START, host: fixtures(), root: new URL("./fixtures/plugin/", import.meta.url) });
  try {
    const page = await view.load(PAGE_FILES);
    assert.deepEqual(await page.read("../diagnostics.json"), { status: 200, body: '{"plugin": "probe", "version": 1}\n' });
    assert.deepEqual(await page.read("../missing.json"), { status: 404, body: null });
    assert.deepEqual(await page.read("../../page-globals.js"), { status: 404, body: null });
    const served = await view.window.fetch("diagnostics.json");
    assert.equal(served.status, 200);
  } finally {
    await view.close();
  }
});

test("the timers and animation frames that a page starts are observed in view.observed.timers, and still run", { timeout: 5000 }, async () => {
  const view = await openView("probe", { start: START, host: fixtures() });
  try {
    const page = await view.load(PAGE_TIMERS);
    await page.done;
    assert.deepEqual(view.observed.timers, [
      { kind: "setTimeout", delay: 0 },
      { kind: "requestAnimationFrame", delay: null },
    ]);
  } finally {
    await view.close();
  }
});

test("a change that another view makes between the read and the replace of runtime.data.change is seen by the replace", { timeout: 5000 }, async () => {
  const view = await openView("probe", {
    start: START,
    host: fixtures({ onDataRead: (key, reads, write) => { if (key === "note" && reads === 1) write("other"); } }),
  });
  try {
    const page = await view.load(PAGE_DATA);
    await page.ready;
    assert.equal(await page.bump(), "other-page");
    await view.change.data("note", "external");
    await view.settled();
    assert.deepEqual(page.seen, ["note", "note", "note"]);
    assert.deepEqual(view.observed.data, [
      { key: "note", value: "other" },
      { key: "note", value: "other-page" },
      { key: "note", value: "external" },
    ]);
  } finally {
    await view.close();
  }
});

test("a page of the view receives the document-state and document-message events that the host pushes", { timeout: 5000 }, async () => {
  const view = await openView("probe", { start: START, host: fixtures() });
  try {
    const page = await view.load(PAGE_DOCUMENT);
    await page.ready;
    await view.push("document-message", { surface: "probe-surface", document: "page", message: "listening" });
    await view.push("document-state", { surface: "probe-surface", document: "page", state: { url: "https://example.invalid/" } });
    assert.deepEqual(page.received, [
      ["document-message", { surface: "probe-surface", document: "page", message: "listening" }],
      ["document-state", { surface: "probe-surface", document: "page", state: { url: "https://example.invalid/" } }],
    ]);
  } finally {
    await view.close();
  }
});

test("each open view binds its own window globals, and closing a view leaves the window of the view still open", { timeout: 5000 }, async () => {
  const first = await openView("probe", { start: START, host: fixtures() });
  const second = await openView("probe", { start: START, host: fixtures() });
  assert.equal(globalThis.window, second.window);
  await first.close();
  assert.equal(globalThis.window, second.window);
  await second.close();
  assert.equal(globalThis.window, undefined);
  const third = await openView("probe", { start: START, host: fixtures() });
  assert.equal(globalThis.window, third.window);
  await third.close();
});

test("document.adoptedStyleSheets takes constructed style sheets, and refuses any other value", { timeout: 5000 }, async () => {
  const view = await openView("probe", { start: START, host: fixtures() });
  try {
    const sheet = new view.window.CSSStyleSheet();
    sheet.replaceSync("p { color: red; }");
    view.window.document.adoptedStyleSheets = [sheet];
    assert.deepEqual(view.window.document.adoptedStyleSheets, [sheet]);
    assert.throws(() => { view.window.document.adoptedStyleSheets = ["p {}"]; }, TypeError);
  } finally {
    await view.close();
  }
});

const PAGE_CONTRIBUTION = new URL("./fixtures/page-contribution.js", import.meta.url);
// The installed plugins of a contribution: the view plugin probe declares the point language, and the plugin one contributes its module.
const contributionsOf = (modules) => [
  { id: "probe", package: "@fixture/probe", version: "1.0.0", manifest: { extends: { language: { version: "1.0.0", schema: { type: "object" } } } } },
  {
    id: "one",
    package: "@fixture/one",
    version: "1.0.0",
    manifest: { contributes: { "probe.language": Object.keys(modules).map((module) => ({ range: "^1.0.0", module, name: module })) } },
    modules,
  },
];

test("a module that the host answers for a contribution loads in the page and runs", { timeout: 5000 }, async () => {
  const modules = { "ui/one.js": new URL("./fixtures/contributions/one.js", import.meta.url).href };
  const view = await openView("probe", { start: START, host: fixtures({ contributions: contributionsOf(modules) }) });
  try {
    const page = await view.load(PAGE_CONTRIBUTION);
    assert.deepEqual(await page.loadContributions("language"), [{ name: "ui/one.js", label: "one contributed" }]);
  } finally {
    await view.close();
  }
});

test("an import of a contributed module whose file is missing rejects in the page with the file error of the loader", { timeout: 5000 }, async () => {
  const modules = { "ui/missing.js": new URL("./fixtures/contributions/missing.js", import.meta.url).href };
  const view = await openView("probe", { start: START, host: fixtures({ contributions: contributionsOf(modules) }) });
  try {
    const page = await view.load(PAGE_CONTRIBUTION);
    await assert.rejects(page.loadContributions("language"), { code: "ENOENT" });
  } finally {
    await view.close();
  }
});

test("a fixture that returns a promise holds the reply to the view until the test resolves the promise", { timeout: 5000 }, async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const view = await openView("probe", { start: START, host: fixtures({ sidecar: { "fixture-sidecar": () => held } }) });
  try {
    let answered = false;
    const reply = view.bridge.runtime.sidecar("fixture-sidecar").send("probe-surface", { n: 2 }).then((value) => { answered = true; return value; });
    for (let step = 0; step < 10; step += 1) await turn();
    assert.equal(answered, false, "the reply waits for the promise of the fixture");
    release({ echo: { n: 2 } });
    assert.deepEqual(await reply, { echo: { n: 2 } });
    await view.settled();
  } finally {
    await view.close();
  }
});

test("a declared fault of runtime.data.get refuses the read of the page with its message", { timeout: 5000 }, async () => {
  const view = await openView("probe", { start: START, host: fixtures({ faults: { "command.runtime.data.get": "the stored data is unreadable" } }) });
  try {
    const page = await view.load(PAGE_DATA);
    await page.ready;
    await assert.rejects(page.bump(), /the stored data is unreadable/);
  } finally {
    await view.close();
  }
});

test("the window of a view has the address of its page in the plugin, as the app serves the page", { timeout: 5000 }, async () => {
  const view = await openView("probe", { start: START, host: fixtures(), page: "ui/view.html" });
  try {
    assert.equal(view.window.location.href, "soksak://probe/ui/view.html");
    assert.equal(new view.window.URL("./studio/index.html", view.window.location.href).href, "soksak://probe/ui/studio/index.html");
  } finally {
    await view.close();
  }
});

// The host adds the surface bound to the view channel, so the record that the view sends names none
// (docs/spec/logging.md#view-record-delivery).
test("a record that a view writes through runtime.log names no surface, which the host adds", { timeout: 5000 }, async () => {
  const view = await openView("probe", { start: START, host: fixtures() });
  try {
    view.bridge.runtime.log.info("saved", { n: 1 });
    const record = await view.logged("plugin.probe.saved");
    assert.deepEqual(record.fields, { n: 1 });
  } finally {
    await view.close();
  }
});

test("a program run of the view reaches the program fixture with its arguments and the reply returns to the view", { timeout: 5000 }, async () => {
  const view = await openView("probe", {
    start: START,
    host: fixtures({ programs: { "probe-tool": (args) => ({ code: 0, stdout: args.join(" "), stderr: "", truncated: { stdout: false, stderr: false } }) } }),
  });
  const reply = await view.bridge.runtime.program.run("probe-tool", ["a", "b"]);
  assert.deepEqual(reply, { code: 0, stdout: "a b", stderr: "", truncated: { stdout: false, stderr: false } });
  assert.deepEqual(view.observed.programs, [{ name: "probe-tool", args: ["a", "b"] }]);
  await view.settled();
  await view.close();
});

test("a program run without a fixture rejects in the view and close names the route", { timeout: 5000 }, async () => {
  const view = await openView("probe", { start: START, host: fixtures() });
  await assert.rejects(view.bridge.runtime.program.run("probe-tool", []), /view host: program.probe-tool has no fixture/);
  await view.settled();
  await assert.rejects(view.close(), /view host: program.probe-tool has no fixture/);
});
