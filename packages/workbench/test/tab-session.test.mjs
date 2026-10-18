import assert from "node:assert/strict";
import test, { mock } from "node:test";

// The events of the page and the interactionState replies of the document regions, answered by each test.
const emitted = [];
const reports = [];
const answers = { documentInteractionState: async () => "" };
const actualLog = await import("../page-log.js");
mock.module("../page-log.js", { exports: { ...actualLog, emitEvent: (level, event, fields) => emitted.push({ level, event, fields }) } });
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
const { createTabSessions, decodedBytes, SESSION_LIMIT } = await import("../tab-session.js");

// The files of a configuration directory: tab-sessions/<tab>.json and tab-state.json, which a restart keeps.
function fakeFiles() {
  return { sessions: new Map(), tabState: null, tabStatePuts: 0 };
}

// A store with the workspace kinds tabSession, tabSessionPut, tabSessions and tabStatePut over files.
function fakeStore(files) {
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
  const store = fakeStore(files);
  const sessions = createTabSessions({ store, failed: (error) => failures.push(error.message),
    interaction: (tab) => regions.interaction(tab), tabs: () => regions.tabs() });
  regions.useSessions((tab) => sessions.read(tab));
  return { regions, sessions, store };
}

test.beforeEach(() => {
  emitted.length = 0;
  reports.length = 0;
});

test("a session stored before a restart is passed to the first attach after it and to the attach after a restore", async () => {
  const files = fakeFiles();
  const first = start(files);
  answers.documentInteractionState = async (_surface, document) => ({ page: "AAAA", side: "" })[document];
  first.regions.attached("tab-a", "page");
  first.regions.attached("tab-a", "side");
  await first.sessions.capture("tab-a");
  assert.deepEqual(files.sessions.get("tab-a"), { format: 1, regions: { page: { session: "AAAA" } } });
  assert.deepEqual(emitted, [{ level: "debug", event: "page.tab.session.stored", fields: { tab: "tab-a", bytes: 50 } }]);
  // The restart: a new page over the same files.
  const second = start(files);
  assert.deepEqual(await second.regions.attachRequest("tab-a", "page"), { document: "page", interactionState: "AAAA" });
  assert.deepEqual(await second.regions.attachRequest("tab-a", "page"), { document: "page" }, "a session is restored once");
  assert.deepEqual(await second.regions.attachRequest("tab-a", "side"), { document: "side" });
  assert.deepEqual(await second.regions.attachRequest("tab-b", "page"), { document: "page" }, "a tab without a file");
  assert.deepEqual(await second.regions.attach("tab-a", "page", async () => null), { history: false });
  assert.equal(second.regions.restoredHistory("tab-a"), false);
  // An unload stores the session; the restore reads it for the attach of the restored surface.
  answers.documentInteractionState = async () => "BBBB";
  await second.sessions.capture("tab-a");
  second.regions.released("tab-a");
  second.regions.restore("tab-a");
  assert.deepEqual(await second.regions.attach("tab-a", "page", async () => null), { history: true });
  assert.equal(second.regions.restoredHistory("tab-a"), true);
  assert.equal(files.tabStatePuts, 0, "a session write leaves tab-state.json unchanged");
});

test("a session that the store refuses to read is logged and the region attaches without it", async () => {
  const files = fakeFiles();
  const { regions, store } = start(files);
  store.tabSession = async () => { throw new Error("tab-sessions/tab-a.json: tab session format 2 is not 1"); };
  assert.deepEqual(await regions.attachRequest("tab-a", "page"), { document: "page" });
  assert.deepEqual(reports, ["memory saver: tab tab-a: session read failed: tab-sessions/tab-a.json: tab session format 2 is not 1"]);
});

test("navigation commits of a tab are coalesced to one write per second; a title change is no commit", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const files = fakeFiles();
  const { regions, sessions, store } = start(files);
  answers.documentInteractionState = async (surface) => `S-${surface}`;
  regions.attached("tab-a", "page");
  regions.attached("tab-b", "page");
  const at = (index, ...urls) => ({ index, entries: urls.map((url) => ({ url, title: url })) });
  sessions.navigated("tab-a", "page", at(0, "https://a.test/"));
  sessions.navigated("tab-a", "page", at(1, "https://a.test/", "https://a.test/2"));
  sessions.navigated("tab-b", "page", at(0, "https://b.test/"));
  t.mock.timers.tick(999);
  await sessions.idle();
  assert.deepEqual(store.puts, []);
  t.mock.timers.tick(1);
  await new Promise(setImmediate);
  await sessions.idle();
  assert.deepEqual(store.puts.map((put) => put.tab).sort(), ["tab-a", "tab-b"]);
  store.puts.length = 0;
  sessions.navigated("tab-a", "page", { index: 1, entries: [{ url: "https://a.test/", title: "A" }, { url: "https://a.test/2", title: "renamed" }] });
  t.mock.timers.tick(1000);
  await new Promise(setImmediate);
  await sessions.idle();
  assert.deepEqual(store.puts, []);
  // The window save of a quit writes every tab with attached regions.
  await sessions.flush();
  assert.deepEqual(store.puts.map((put) => put.tab).sort(), ["tab-a", "tab-b"]);
});

test("a region session over 1 MiB decoded is dropped with a warn event and the others are stored", async () => {
  const files = fakeFiles();
  const { regions, sessions } = start(files);
  const large = "A".repeat(Math.ceil(SESSION_LIMIT / 3) * 4);
  assert.equal(decodedBytes(large), SESSION_LIMIT + 2);
  assert.equal(decodedBytes("QQ=="), 1);
  answers.documentInteractionState = async (_surface, document) => ({ page: large, side: "AAAA" })[document];
  regions.attached("tab-a", "page");
  regions.attached("tab-a", "side");
  await sessions.capture("tab-a");
  assert.deepEqual(files.sessions.get("tab-a"), { format: 1, regions: { side: { session: "AAAA" } } });
  assert.deepEqual(emitted[0], { level: "warn", event: "page.tab.session.dropped",
    fields: { tab: "tab-a", region: "page", bytes: SESSION_LIMIT + 2 } });
  // A tab whose every region is over the limit keeps no file.
  answers.documentInteractionState = async () => large;
  await sessions.capture("tab-a");
  assert.equal(files.sessions.has("tab-a"), false);
});

test("closing a tab removes its file after the layout write, and the reconcile removes the files of tabs in no layout", async () => {
  const files = fakeFiles();
  const { regions, sessions } = start(files);
  answers.documentInteractionState = async () => "AAAA";
  for (const tab of ["tab-a", "tab-b", "tab-c"]) {
    regions.attached(tab, "page");
    await sessions.capture(tab);
  }
  await assert.rejects(sessions.removeAfter(Promise.reject(new Error("layout refused")), ["tab-a"]), /layout refused/);
  assert.equal(files.sessions.has("tab-a"), true, "a refused layout write removes no file");
  await sessions.removeAfter(Promise.resolve(), ["tab-a"]);
  assert.equal(files.sessions.has("tab-a"), false);
  // A later state of the closing region writes nothing.
  sessions.navigated("tab-a", "page", { index: 0, entries: [{ url: "https://a.test/", title: "" }] });
  await sessions.capture("tab-a");
  assert.equal(files.sessions.has("tab-a"), false);
  emitted.length = 0;
  await sessions.reconcile(new Set(["tab-b"]));
  assert.deepEqual([...files.sessions.keys()], ["tab-b"]);
  assert.deepEqual(emitted, [{ level: "info", event: "page.tab.session.orphan", fields: { tab: "tab-c" } }]);
});

test("a failed coalesced write is shown through the error display", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const failures = [];
  const { regions, sessions, store } = start(fakeFiles(), failures);
  store.tabSessionPut = async () => { throw new Error("disk full"); };
  answers.documentInteractionState = async () => "AAAA";
  regions.attached("tab-a", "page");
  sessions.navigated("tab-a", "page", { index: 0, entries: [{ url: "https://a.test/", title: "" }] });
  t.mock.timers.tick(1000);
  await new Promise(setImmediate);
  await sessions.idle();
  assert.deepEqual(failures, ["tab session of tab-a: disk full"]);
});
