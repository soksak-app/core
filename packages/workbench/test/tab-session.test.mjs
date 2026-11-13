import assert from "node:assert/strict";
import test, { mock } from "node:test";

// The interactionState replies of the document regions, answered by each test, and the reports of the page.
const reports = [];
const answers = { documentInteractionState: async () => "" };
const actualHost = await import("../host.js");
mock.module("../host.js", {
  exports: {
    ...actualHost,
    documents: {
      query: async () => ({ media: false, capture: false, form: false }),
      interactionState: (surface, document) => answers.documentInteractionState(surface, document),
    },
    report: (line) => reports.push(line),
  },
});
const { createDocumentRegions } = await import("../document-regions.js");
const { createTabSessions, decodedBytes, SESSION_LIMIT, tabSessionCore } = await import("../tab-session.js");

// The files of a configuration directory: tab-sessions/<tab>.json and tab-state.json, which a restart keeps.
function documentFiles() {
  return { sessions: new Map(), tabState: null, tabStatePuts: 0 };
}

// A store with the workspace kinds tabSession, tabSessionPut, tabSessions and tabStatePut over files.
function documentStore(files) {
  return {
    puts: [],
    tabSession: async (tab) => structuredClone(files.sessions.get(tab) ?? null),
    tabSessionPut: async function (tab, regions) {
      this.puts.push({ tab, regions: structuredClone(regions) });
      if (regions === null) {
        files.sessions.delete(tab);
        return null;
      }
      const document = { format: 1, regions: structuredClone(regions) };
      files.sessions.set(tab, document);
      return JSON.stringify(document).length;
    },
    tabSessions: async () => [...files.sessions.keys()].sort(),
    tabStatePut: async () => { files.tabStatePuts++; return 0; },
  };
}

// One start of the page: the document regions and the tab sessions over the files.
function start(files, failures = []) {
  const regions = createDocumentRegions();
  const store = documentStore(files);
  const sessions = createTabSessions({ store, failed: (error) => failures.push(error.message),
    interaction: (tab) => regions.interaction(tab), tabs: () => regions.tabs() });
  regions.useSessions((tab) => sessions.read(tab));
  return { regions, sessions, store };
}

const at = (index, ...urls) => ({ index, entries: urls.map((url) => ({ url, title: url })) });

test.beforeEach(() => {
  reports.length = 0;
});

test("a session stored before a restart is passed to the first attach after it and to the attach after a restore", async () => {
  const files = documentFiles();
  const first = start(files);
  answers.documentInteractionState = async (_surface, document) => ({ page: "AAAA", side: "" })[document];
  first.regions.attached("tab-a", "page");
  first.regions.attached("tab-a", "side");
  await first.sessions.capture("tab-a", "unload");
  assert.deepEqual(files.sessions.get("tab-a"), { format: 1, regions: { page: { session: "AAAA" } } });
  // The restart: a new page over the same files.
  const second = start(files);
  assert.deepEqual(await second.regions.attachRequest("tab-a", "page"), { document: "page", interactionState: "AAAA" });
  assert.deepEqual(await second.regions.attachRequest("tab-a", "page"), { document: "page" }, "a session is restored once");
  assert.deepEqual(await second.regions.attachRequest("tab-a", "side"), { document: "side" });
  assert.deepEqual(await second.regions.attachRequest("tab-b", "page"), { document: "page" }, "a tab without a file");
  assert.deepEqual(await second.regions.attach("tab-a", "fixture", "page", async () => null), { history: false });
  // An unload stores the session; the restore reads it for the attach of the restored surface.
  answers.documentInteractionState = async () => "BBBB";
  await second.sessions.capture("tab-a", "unload");
  second.regions.released("tab-a");
  second.regions.restore("tab-a");
  assert.deepEqual(await second.regions.attach("tab-a", "fixture", "page", async () => null), { history: true });
  assert.equal(await second.regions.restoredHistory("tab-a"), true);
  assert.equal(files.tabStatePuts, 0, "a session write leaves tab-state.json unchanged");
});

test("a restore states whether its stored session holds a session history before a region of the tab attaches", async () => {
  const files = documentFiles();
  files.sessions.set("tab-a", { format: 1, regions: { page: { session: "AAAA" } } });
  const { regions } = start(files);
  // A view attaches its regions after its mount ends, so the end of the restore reads the stored session, not the attaches.
  regions.restore("tab-a");
  assert.equal(await regions.restoredHistory("tab-a"), true, "the restore of a stored session history");
  regions.restore("tab-b");
  assert.equal(await regions.restoredHistory("tab-b"), false, "the restore of a tab without a stored session");
  await assert.rejects(regions.restoredHistory("tab-c"), { message: "tab tab-c has no read of its stored session" });
});

test("a session that the store refuses to read is logged and the region attaches without it", async () => {
  const files = documentFiles();
  const { regions, store } = start(files);
  store.tabSession = async () => { throw new Error("tab-sessions/tab-a.json: tab session format 2 is not 1"); };
  assert.deepEqual(await regions.attachRequest("tab-a", "page"), { document: "page" });
  assert.deepEqual(reports, ["memory saver: tab tab-a: session read failed: tab-sessions/tab-a.json: tab session format 2 is not 1"]);
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
  const files = documentFiles();
  const { regions, sessions, store } = start(files);
  answers.documentInteractionState = async (surface) => `S-${surface}`;
  regions.attached("tab-a", "page");
  regions.attached("tab-b", "page");
  sessions.navigated("tab-a", "page", at(0, "https://a.test/"));
  sessions.navigated("tab-a", "page", at(1, "https://a.test/", "https://a.test/2"));
  sessions.navigated("tab-b", "page", at(0, "https://b.test/"));
  await sessions.idle();
  assert.deepEqual(store.puts, [], "no write before the flush or the deadline");
  await sessions.flush();
  assert.deepEqual(store.puts.map((put) => put.tab).sort(), ["tab-a", "tab-b"]);
  store.puts.length = 0;
  sessions.navigated("tab-a", "page", { index: 1, entries: [{ url: "https://a.test/", title: "A" }, { url: "https://a.test/2", title: "renamed" }] });
  await sessions.idle();
  assert.deepEqual(store.puts, [], "a title change writes nothing");
  await sessions.flush();
  assert.deepEqual(store.puts.map((put) => put.tab).sort(), ["tab-a", "tab-b"]);
});

// The read of the sessions names what asked for it: a navigation commit, the save of a window, or the unload of a tab.
test("each read of the sessions of a tab records its cause", async () => {
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
  const { sessions } = start(documentFiles());
  await assert.rejects(sessions.capture("tab-a"), /cause/);
});

test("a region session over 1 MiB decoded is dropped with a warn event and the others are stored", async () => {
  const files = documentFiles();
  const { regions, sessions } = start(files);
  const large = "A".repeat(Math.ceil(SESSION_LIMIT / 3) * 4);
  assert.equal(decodedBytes(large), SESSION_LIMIT + 2);
  assert.equal(decodedBytes("QQ=="), 1);
  // The decision of the core: the large region is dropped with its warn event, and the others are written.
  assert.deepEqual(tabSessionCore().regions("tab-a", { page: large, side: "AAAA" }), [
    { type: "event", level: "warn", event: "workbench.tab.session.dropped", fields: { tab: "tab-a", region: "page", bytes: SESSION_LIMIT + 2 } },
    { type: "write", tab: "tab-a", regions: { side: { session: "AAAA" } } },
  ]);
  answers.documentInteractionState = async (_surface, document) => ({ page: large, side: "AAAA" })[document];
  regions.attached("tab-a", "page");
  regions.attached("tab-a", "side");
  await sessions.capture("tab-a", "unload");
  assert.deepEqual(files.sessions.get("tab-a"), { format: 1, regions: { side: { session: "AAAA" } } });
  // A tab whose every region is over the limit keeps no file.
  answers.documentInteractionState = async () => large;
  await sessions.capture("tab-a", "unload");
  assert.equal(files.sessions.has("tab-a"), false);
});

test("closing a tab removes its file after the layout write, and the reconcile removes the files of tabs in no layout", async () => {
  const files = documentFiles();
  const { regions, sessions } = start(files);
  answers.documentInteractionState = async () => "AAAA";
  for (const tab of ["tab-a", "tab-b", "tab-c"]) {
    regions.attached(tab, "page");
    await sessions.capture(tab, "unload");
  }
  await assert.rejects(sessions.removeAfter(Promise.reject(new Error("layout refused")), ["tab-a"]), /layout refused/);
  assert.equal(files.sessions.has("tab-a"), true, "a refused layout write removes no file");
  await sessions.removeAfter(Promise.resolve(), ["tab-a"]);
  assert.equal(files.sessions.has("tab-a"), false);
  // A later state of the closing region writes nothing.
  sessions.navigated("tab-a", "page", { index: 0, entries: [{ url: "https://a.test/", title: "" }] });
  await sessions.capture("tab-a", "unload");
  assert.equal(files.sessions.has("tab-a"), false);
  // The reconcile decision: each listed tab that no layout keeps is an orphan event and a removal.
  assert.deepEqual(tabSessionCore().reconcile(["tab-b", "tab-c"], (tab) => tab === "tab-b"), [
    { type: "event", level: "info", event: "workbench.tab.session.orphan", fields: { tab: "tab-c" } },
    { type: "write", tab: "tab-c", regions: null },
  ]);
  await sessions.reconcile((tab) => tab === "tab-b");
  assert.deepEqual([...files.sessions.keys()], ["tab-b"]);
});

test("a failed coalesced write is shown through the error display", async () => {
  const failures = [];
  const { regions, sessions, store } = start(documentFiles(), failures);
  store.tabSessionPut = async () => { throw new Error("disk full"); };
  answers.documentInteractionState = async () => "AAAA";
  regions.attached("tab-a", "page");
  sessions.navigated("tab-a", "page", { index: 0, entries: [{ url: "https://a.test/", title: "" }] });
  // The flush of the quit runs the read of the navigation now, and its write fails.
  await sessions.flush();
  await sessions.idle();
  assert.deepEqual(failures, ["tab session of tab-a: disk full"]);
});
