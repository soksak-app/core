import assert from "node:assert/strict";
import test from "node:test";
import { host, selectPageWire } from "@soksak/runtime";

// The host calls of the tab sessions (documentInteractionState, workspace tabSession, tabSessionPut, tabSessions) and the log batches
// of the page are answered by the page-wire case of each test (docs/spec/cases/page-wire/README.md). A case is selected before the
// modules are imported, because the page reads the host when it imports them.
selectPageWire("tab-session-import");
const { createDocumentRegions } = await import("../document-regions.js");
const { HostWorkspaceStore } = await import("../host-store.js");
const { createTabSessions, decodedBytes, SESSION_LIMIT, tabSessionCore } = await import("../tab-session.js");
const { flushEvents } = await import("../page-log.js");

// One start of the page: the document regions and the tab sessions over the host store.
function start(failures = []) {
  const regions = createDocumentRegions();
  const store = new HostWorkspaceStore(host);
  const sessions = createTabSessions({ store, failed: (error) => failures.push(error.message),
    interaction: (tab) => regions.interaction(tab), tabs: () => regions.tabs() });
  regions.useSessions((tab) => sessions.read(tab));
  return { regions, sessions, store };
}

// The lines that the page wrote to the application log, from the records of the log batches that it sent.
const reportedLines = (wire) => wire.calls
  .filter(({ name, payload }) => name === "log" && payload.action === "batch")
  .flatMap(({ payload }) => payload.events)
  .filter(({ event }) => event === "workbench.record.error")
  .map(({ fields }) => `${fields.where}: ${fields.text}`);

// The workspace calls of the tab sessions, as the store kinds that the page sent.
const workspaceCalls = (wire, kind) => wire.calls
  .filter(({ name, payload }) => name === "workspace" && payload.kind === kind)
  .map(({ payload }) => payload);

const at = (index, ...urls) => ({ index, entries: urls.map((url) => ({ url, title: url })) });

test("a session stored before a restart is passed to the first attach after it and to the attach after a restore", async () => {
  const wire = selectPageWire("tab-session-restart");
  const first = start();
  first.regions.attached("tab-a", "page");
  first.regions.attached("tab-a", "side");
  await first.sessions.capture("tab-a", "unload");
  assert.deepEqual(workspaceCalls(wire, "tabSessionPut").at(-1), { kind: "tabSessionPut", tab: "tab-a", regions: { page: { session: "AAAA" } } });
  // The restart: a new page over the same host state.
  const second = start();
  assert.deepEqual(await second.regions.attachRequest("tab-a", "page"), { document: "page", interactionState: "AAAA" });
  assert.deepEqual(await second.regions.attachRequest("tab-a", "page"), { document: "page" }, "a session is restored once");
  assert.deepEqual(await second.regions.attachRequest("tab-a", "side"), { document: "side" });
  assert.deepEqual(await second.regions.attachRequest("tab-b", "page"), { document: "page" }, "a tab without a file");
  assert.deepEqual(await second.regions.attach("tab-a", "fixture", "page", async () => null), { history: false });
  // An unload stores the session; the restore reads it for the attach of the restored surface.
  await second.sessions.capture("tab-a", "unload");
  second.regions.released("tab-a");
  second.regions.restore("tab-a");
  assert.deepEqual(await second.regions.attach("tab-a", "fixture", "page", async () => null), { history: true });
  assert.equal(await second.regions.restoredHistory("tab-a"), true);
  assert.equal(workspaceCalls(wire, "tabStatePut").length, 0, "a session write leaves tab-state.json unchanged");
  wire.finish();
});

test("a restore states whether its stored session holds a session history before a region of the tab attaches", async () => {
  const wire = selectPageWire("tab-session-restored-history");
  const { regions } = start();
  // A view attaches its regions after its mount ends, so the end of the restore reads the stored session, not the attaches.
  regions.restore("tab-a");
  assert.equal(await regions.restoredHistory("tab-a"), true, "the restore of a stored session history");
  regions.restore("tab-b");
  assert.equal(await regions.restoredHistory("tab-b"), false, "the restore of a tab without a stored session");
  await assert.rejects(regions.restoredHistory("tab-c"), { message: "tab tab-c has no read of its stored session" });
  wire.finish();
});

test("a session that the store refuses to read is logged and the region attaches without it", async () => {
  const wire = selectPageWire("tab-session-read-refused");
  const { regions } = start();
  assert.deepEqual(await regions.attachRequest("tab-a", "page"), { document: "page" });
  // The record leaves in the batch of the page log, which the flush waits for.
  await flushEvents();
  assert.deepEqual(reportedLines(wire), ["memory saver: tab tab-a: session read failed: tab-sessions/tab-a.json: tab session format 2 is not 1"]);
  wire.finish();
});

test("navigation commits of a tab are coalesced to one write per second; a title change is no commit", async () => {
  // The deadline and the due reads are the decisions of the core: a navigation of a tab is read one second after its first.
  const core = tabSessionCore();
  core.navigated("tab-a", "page", at(0, "https://a.test/"), 0);
  core.navigated("tab-a", "page", at(1, "https://a.test/", "https://a.test/2"), 0);
  core.navigated("tab-b", "page", at(0, "https://b.test/"), 0);
  assert.equal(core.deadline(), 1000, "one read per tab, one second after its first navigation");
  assert.deepEqual(core.due(999), []);
  assert.deepEqual(core.due(1000), [{ type: "read", tab: "tab-a", cause: "navigation" }, { type: "read", tab: "tab-b", cause: "navigation" }]);
  core.read("tab-a", "navigation");
  core.read("tab-b", "navigation");
  assert.equal(core.deadline(), null);
  core.navigated("tab-a", "page", { index: 1, entries: [{ url: "https://a.test/", title: "A" }, { url: "https://a.test/2", title: "renamed" }] }, 1000);
  assert.equal(core.deadline(), null, "a title change alone starts no read");

  // The shell: navigations queue no write, and the window save of a quit writes every tab with attached regions.
  const wire = selectPageWire("tab-session-coalesce");
  const { regions, sessions } = start();
  regions.attached("tab-a", "page");
  regions.attached("tab-b", "page");
  sessions.navigated("tab-a", "page", at(0, "https://a.test/"));
  sessions.navigated("tab-a", "page", at(1, "https://a.test/", "https://a.test/2"));
  sessions.navigated("tab-b", "page", at(0, "https://b.test/"));
  await sessions.idle();
  assert.deepEqual(workspaceCalls(wire, "tabSessionPut"), [], "no write before the flush or the deadline");
  await sessions.flush();
  assert.deepEqual(workspaceCalls(wire, "tabSessionPut").map((put) => put.tab), ["tab-a", "tab-b"]);
  const writes = wire.calls.length;
  sessions.navigated("tab-a", "page", { index: 1, entries: [{ url: "https://a.test/", title: "A" }, { url: "https://a.test/2", title: "renamed" }] });
  await sessions.idle();
  assert.deepEqual(wire.calls.slice(writes).filter(({ name }) => name === "workspace"), [], "a title change writes nothing");
  await sessions.flush();
  assert.deepEqual(workspaceCalls(wire, "tabSessionPut").map((put) => put.tab), ["tab-a", "tab-b", "tab-a", "tab-b"]);
  wire.finish();
});

// The read of the sessions names what asked for it: a navigation commit, the save of a window, or the unload of a tab.
test("each read of the sessions of a tab records its cause", async () => {
  const wire = selectPageWire("tab-session-cause");
  const core = tabSessionCore();
  core.navigated("tab-a", "page", { index: 0, entries: [{ url: "https://a.test/", title: "" }] }, 0);
  assert.deepEqual(core.due(1000), [{ type: "read", tab: "tab-a", cause: "navigation" }]);
  const reads = [...core.read("tab-a", "navigation"), ...core.read("tab-a", "flush"), ...core.read("tab-a", "unload")];
  assert.deepEqual(reads.filter((action) => action.type === "interaction").length, 3);
  assert.deepEqual(reads.filter((action) => action.type === "event").map((action) => [action.level, action.event, action.fields]), [
    ["debug", "workbench.tab.session.read", { tab: "tab-a", cause: "navigation" }],
    ["debug", "workbench.tab.session.read", { tab: "tab-a", cause: "flush" }],
    ["debug", "workbench.tab.session.read", { tab: "tab-a", cause: "unload" }],
  ]);
  assert.deepEqual(core.written("tab-a", 50, { page: { session: "AAAA" } }), [
    { type: "event", level: "debug", event: "workbench.tab.session.stored", fields: { tab: "tab-a", bytes: 50 } },
  ]);
  assert.throws(() => core.read("tab-a"), /cause/);
  const { sessions } = start();
  await assert.rejects(sessions.capture("tab-a"), /cause/);
  assert.deepEqual(wire.calls, [], "a read that names no cause sent a host call");
  wire.finish();
});

test("a region session over 1 MiB decoded is dropped with a warn event and the others are stored", async () => {
  const wire = selectPageWire("tab-session-large-region");
  const { regions, sessions } = start();
  const large = "A".repeat(Math.ceil(SESSION_LIMIT / 3) * 4);
  assert.equal(decodedBytes(large), SESSION_LIMIT + 2);
  assert.equal(decodedBytes("QQ=="), 1);
  // The decision of the core: the large region is dropped with its warn event, and the others are written.
  assert.deepEqual(tabSessionCore().regions("tab-a", { page: large, side: "AAAA" }), [
    { type: "event", level: "warn", event: "workbench.tab.session.dropped", fields: { tab: "tab-a", region: "page", bytes: SESSION_LIMIT + 2 } },
    { type: "write", tab: "tab-a", regions: { side: { session: "AAAA" } } },
  ]);
  regions.attached("tab-a", "page");
  regions.attached("tab-a", "side");
  await sessions.capture("tab-a", "unload");
  assert.deepEqual(workspaceCalls(wire, "tabSessionPut").at(-1), { kind: "tabSessionPut", tab: "tab-a", regions: { side: { session: "AAAA" } } });
  // A tab whose every region is over the limit keeps no file.
  await sessions.capture("tab-a", "unload");
  assert.deepEqual(workspaceCalls(wire, "tabSessionPut").at(-1), { kind: "tabSessionPut", tab: "tab-a", regions: null });
  wire.finish();
});

test("closing a tab removes its file after the layout write, and the reconcile removes the files of tabs in no layout", async () => {
  const wire = selectPageWire("tab-session-remove");
  const { regions, sessions } = start();
  for (const tab of ["tab-a", "tab-b", "tab-c"]) {
    regions.attached(tab, "page");
    await sessions.capture(tab, "unload");
  }
  await assert.rejects(sessions.removeAfter(Promise.reject(new Error("layout refused")), ["tab-a"]), /layout refused/);
  assert.equal(workspaceCalls(wire, "tabSessionPut").at(-1).regions !== null, true, "a refused layout write removes no file");
  await sessions.removeAfter(Promise.resolve(), ["tab-a"]);
  assert.deepEqual(workspaceCalls(wire, "tabSessionPut").at(-1), { kind: "tabSessionPut", tab: "tab-a", regions: null });
  // A later state of the closing region writes nothing.
  sessions.navigated("tab-a", "page", { index: 0, entries: [{ url: "https://a.test/", title: "" }] });
  const calls = wire.calls.length;
  await sessions.capture("tab-a", "unload");
  assert.equal(wire.calls.length, calls, "a later state of a closing region called the host");
  // The reconcile decision: each listed tab that no layout keeps is an orphan event and a removal.
  assert.deepEqual(tabSessionCore().reconcile(["tab-b", "tab-c"], (tab) => tab === "tab-b"), [
    { type: "event", level: "info", event: "workbench.tab.session.orphan", fields: { tab: "tab-c" } },
    { type: "write", tab: "tab-c", regions: null },
  ]);
  await sessions.reconcile((tab) => tab === "tab-b");
  assert.deepEqual(workspaceCalls(wire, "tabSessionPut").at(-1), { kind: "tabSessionPut", tab: "tab-c", regions: null });
  wire.finish();
});

test("a failed coalesced write is shown through the error display", async () => {
  const wire = selectPageWire("tab-session-write-failed");
  const failures = [];
  const { regions, sessions } = start(failures);
  regions.attached("tab-a", "page");
  sessions.navigated("tab-a", "page", { index: 0, entries: [{ url: "https://a.test/", title: "" }] });
  // The flush of the quit runs the read of the navigation now, and its write fails.
  await sessions.flush();
  await sessions.idle();
  assert.deepEqual(failures, ["tab session of tab-a: disk full"]);
  wire.finish();
});
