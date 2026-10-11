// The debug view shows the events of the event files as a timeline that pages through the query of the host: the rows, the filters,
// the older pages, the following, the status, the bound controls and the shown errors (docs/spec/debug.md#timeline).
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import { FOLLOW_INTERVAL_MS, HOLD_LIMIT, PAGE_ROWS } from "../debug-timeline.js";

const LEVELS = ["error", "warn", "info", "debug", "trace"];

/** A row of the answer of the host: the process, the file and the event. */
const row = (seq, ts_us, name = "host.app.event", extra = {}, role = "host", boot = "a") => ({
  role, boot, file: `logs/${role}-${boot}.jsonl`, offset: seq * 100,
  event: { ts_us, seq, level: "info", layer: "host", event: name, fields: {}, ...extra },
});
const rowId = (r) => `${r.role}-${r.boot}:${r.event.seq}`;
const SMALL = [
  row(1, 10, "log.open", { fields: { schema: 2, boot: "a" } }),
  row(2, 20, "host.window.created", { level: "debug", window: "w1" }),
  row(3, 30, "page.call.slow", { level: "warn", layer: "page", fields: { name: "windows.list" } }),
];

/** The reference of the query that the fake host runs: it filters, orders by the key and cuts one page like the host does. */
function answer(rows, request) {
  const least = LEVELS.indexOf(request.level ?? "trace");
  const text = (request.text ?? "").toLowerCase();
  const matches = (r) => LEVELS.indexOf(r.event.level) <= least
    && (request.layer === undefined || r.event.layer === request.layer)
    && (request.event === undefined || r.event.event === request.event)
    && (request.event_prefix === undefined || r.event.event === request.event_prefix || r.event.event.startsWith(`${request.event_prefix}.`))
    && (request.surface === undefined || (r.event.surface ?? r.event.fields?.surface) === request.surface)
    && (request.cid === undefined || (r.event.cids ?? []).includes(request.cid))
    && (request.from_us === undefined || r.event.ts_us >= request.from_us)
    && (request.to_us === undefined || r.event.ts_us <= request.to_us)
    && (text === "" || JSON.stringify(r.event).toLowerCase().includes(text))
    && (request.since?.[`${r.role}-${r.boot}`] === undefined || r.event.seq > request.since[`${r.role}-${r.boot}`]);
  const key = (r) => [r.event.ts_us, r.role, r.boot, r.event.seq];
  const compare = (a, b) => { const [x, y] = [key(a), key(b)]; for (let i = 0; i < 4; i += 1) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1; return 0; };
  const ascending = (request.order ?? "asc") === "asc";
  let found = rows.filter(matches).toSorted(compare);
  if (!ascending) found.reverse();
  if (request.after !== undefined) {
    const after = { role: request.after.role, boot: request.after.boot, event: { ts_us: request.after.ts_us, seq: request.after.seq } };
    found = found.filter((r) => (ascending ? compare(r, after) > 0 : compare(r, after) < 0));
  }
  const limit = request.limit ?? 500;
  const page = found.slice(0, limit);
  const tail = {};
  for (const r of rows) tail[`${r.role}-${r.boot}`] = Math.max(tail[`${r.role}-${r.boot}`] ?? 0, r.event.seq);
  const next = found.length > limit ? { ts_us: page.at(-1).event.ts_us, role: page.at(-1).role, boot: page.at(-1).boot, seq: page.at(-1).event.seq } : null;
  return { rows: page, next, tail, scanned: { files: 1, segments: 1, read: 1, lines: found.length, rebuilt: 0 } };
}

/** A host whose event files hold `rows`: the host call `logQuery` answers with the reference and records each request. */
function served(rows) {
  const log = { rows: [...rows], requests: [], failure: null };
  const query = async (request) => {
    log.requests.push(structuredClone(request));
    if (log.failure !== null) throw log.failure;
    return answer(log.rows, request);
  };
  return Object.assign(query, { log });
}

async function openView(t, { query, saveText = async () => ({ saved: null }) }) {
  const dom = new JSDOM("<body><div id=plane></div></body>");
  globalThis.document = dom.window.document;
  globalThis.CSS = { escape: (value) => value };
  const shown = [];
  const hidden = [];
  const listeners = [];
  t.mock.module("../host.js", { namedExports: {
    native: false,
    debug: { record: async () => ({ path: "logs/state.json" }), files: async () => [], read: async () => ({}), query, onChanged: (listener) => { listeners.push(listener); return Promise.resolve(() => {}); }, save: async () => {}, saveAll: async () => {}, saveText },
    overlay: { show: () => {}, update: () => {}, place: () => {}, hide: () => {} },
  } });
  t.mock.module("../compositor.js", { namedExports: { standIn: () => {} } });
  t.mock.module("../icons.js", { namedExports: { icon: () => "" } });
  t.mock.module("../commands.js", { namedExports: {
    commandOf: () => null,
    delegate: () => {},
    mark: (el, name, params, valueName) => {
      el.dataset.command = name;
      el.dataset.params = JSON.stringify(params ?? {});
      if (valueName) el.dataset.value = valueName;
    },
    run: async () => {},
  } });
  t.mock.module("../exposure.js", { namedExports: { registry: { list: () => ({ status: [] }), registrants: () => [], handle: async () => ({}) } } });
  t.mock.module("../shown-errors.js", { namedExports: {
    hideError: (element, where) => hidden.push(where),
    showError: (element, where, text) => { element.textContent = text; shown.push({ where, text }); },
  } });
  const ui = await import(`../debug-ui.js?timeline-${Math.random()}`);
  document.getElementById("plane").getBoundingClientRect = () => ({ left: 0, top: 0 });
  await ui.openDebug();
  t.after(() => { ui.closeDebug(); dom.window.close(); });
  /** Delivers the host event `debug-log-changed` for a file to every listener of the page and waits for the queries it starts. */
  const changed = async (path, size = 1) => {
    await Promise.all(listeners.map((listener) => listener({ path, size })));
  };
  return { ui, shown, hidden, changed };
}

const WARNING = "저장한 파일에는 입력한 글자가 들어 있을 수 있다.";
const rowsText = () => [...document.querySelectorAll('[data-expose="core.debug.timeline.row"]')].map((r) => r.textContent);
const names = () => rowsText().map((text) => text.split(" ")[3]);

test("the timeline asks for the newest page and shows it oldest first with the status of the pages", async (t) => {
  const query = served(SMALL);
  const { ui } = await openView(t, { query });
  await ui.showDebugTimeline();
  assert.deepEqual(query.log.requests, [{ channel: "other", level: "trace", order: "desc", limit: PAGE_ROWS }]);
  assert.deepEqual(names(), ["log.open", "host.window.created", "page.call.slow"]);
  assert.deepEqual(ui.debugState().timeline, {
    following: true, appended: 0, held: 3, older: false, omitted: 0, selected: 0, warning: WARNING,
    channel: "other", level: "trace", class: "", layer: "all", text: "", event: "", event_prefix: "", surface: "", session: "", cid: "", run: "", from: "", to: "",
  });
  assert.equal(document.querySelector('[data-key="timeline-older"]').hidden, true);
  assert.equal(document.querySelector('[data-expose="core.debug.timeline.omitted"]').hidden, true);
  ui.listDebugFiles();
  assert.equal(ui.debugState().timeline, null);
});

test("a log of more rows than a page opens as one page and the older pages come in front of it", async (t) => {
  const many = Array.from({ length: 1300 }, (_, index) => row(index + 1, 100 + index, "host.fixture.row", { fields: { n: index } }));
  const query = served(many);
  const { ui } = await openView(t, { query });
  await ui.showDebugTimeline();
  assert.equal(rowsText().length, PAGE_ROWS, "the page drew more than a page");
  assert.match(rowsText().at(-1), /n=1299$/);
  assert.match(rowsText()[0], /n=800$/);
  assert.equal(ui.debugState().timeline.older, true);
  assert.equal(document.querySelector('[data-key="timeline-older"]').hidden, false);
  await ui.olderDebugTimeline();
  assert.equal(rowsText().length, 2 * PAGE_ROWS);
  assert.match(rowsText()[0], /n=300$/);
  assert.deepEqual(query.log.requests.at(-1).after, { ts_us: 900, role: "host", boot: "a", seq: 801 });
  assert.equal(query.log.requests.at(-1).order, "desc");
  await ui.olderDebugTimeline();
  assert.equal(rowsText().length, 1300);
  assert.equal(ui.debugState().timeline.older, false);
  const requests = query.log.requests.length;
  await ui.olderDebugTimeline();
  assert.equal(query.log.requests.length, requests, "a timeline without an older row asked again");
  assert.equal(document.querySelector('[data-key="timeline-older"]').hidden, true);
});

test("the view holds at most 2000 rows and refuses an older page beyond them with an error", async (t) => {
  const many = Array.from({ length: 3000 }, (_, index) => row(index + 1, 100 + index, "host.fixture.row", { fields: { n: index } }));
  const query = served(many);
  const { ui, shown } = await openView(t, { query });
  await ui.showDebugTimeline();
  for (let page = 0; page < 3; page += 1) await ui.olderDebugTimeline();
  assert.equal(rowsText().length, HOLD_LIMIT);
  assert.equal(query.log.requests.at(-1).limit, HOLD_LIMIT - 3 * PAGE_ROWS, "the last page asks only for the room that is left");
  assert.equal(ui.debugState().timeline.older, true);
  await assert.rejects(ui.olderDebugTimeline(), /the timeline holds 2000 rows; narrow the filter or the time/);
  assert.match(ui.debugState().error, /^older: the timeline holds 2000 rows/);
  assert.equal(shown.at(-1).where, "debug");
  assert.equal(rowsText().length, HOLD_LIMIT);
});

test("the filter asks the host for the newest page again with the members of the filter", async (t) => {
  const query = served(SMALL);
  const { ui } = await openView(t, { query });
  await ui.showDebugTimeline();
  await ui.filterDebugTimeline({ level: "warn" });
  assert.deepEqual(query.log.requests.at(-1), { channel: "other", level: "warn", order: "desc", limit: PAGE_ROWS });
  assert.deepEqual(names(), ["page.call.slow"]);
  await ui.filterDebugTimeline({ level: "trace", layer: "host", text: "WINDOW", from: "1970-01-01T00:00:00.000020Z", to: "1970-01-01T00:00:00.000020Z" });
  assert.deepEqual(query.log.requests.at(-1), { channel: "other", level: "trace", layer: "host", text: "WINDOW", from_us: 20, to_us: 20, order: "desc", limit: PAGE_ROWS });
  assert.deepEqual(names(), ["host.window.created"]);
  assert.equal(ui.debugState().timeline.layer, "host");
  assert.equal(ui.debugState().timeline.held, 1);
  await ui.filterDebugTimeline({ channel: "all", event_prefix: "host.window", class: "input", run: "r1", cid: "c1", surface: "s", session: "x", event: "" });
  assert.deepEqual(query.log.requests.at(-1), { channel: "all", level: "trace", layer: "host", text: "WINDOW", class: "input", event_prefix: "host.window", surface: "s", session: "x", cid: "c1", run: "r1", from_us: 20, to_us: 20, order: "desc", limit: PAGE_ROWS });
  await assert.rejects(async () => ui.filterDebugTimeline({}), /timeline filter needs channel, level, class, layer, text, event, event_prefix, surface, session, cid, run, from, to/);
  await assert.rejects(async () => ui.filterDebugTimeline({ colour: "red" }), /timeline filter has no member colour/);
  await assert.rejects(ui.filterDebugTimeline({ from: "yesterday" }), /log query from "yesterday" is not a UTC time like 2026-10-08T22:53:20\.123456Z/);
  assert.equal(ui.debugState().timeline.from, "1970-01-01T00:00:00.000020Z", "a refused filter changed the filter");
  assert.equal(ui.debugState().timeline.held, 0);
});

test("a query that the host refuses is shown through the error display and the shown rows stay", async (t) => {
  const query = served(SMALL);
  const { ui, shown } = await openView(t, { query });
  await ui.showDebugTimeline();
  query.log.failure = new Error('log query level "loud" is not one of error, warn, info, debug, trace');
  await assert.rejects(ui.filterDebugTimeline({ level: "loud" }), /log query level "loud" is not one of/);
  assert.match(ui.debugState().error, /^filter: log query level "loud" is not one of error, warn, info, debug, trace/);
  assert.equal(shown.at(-1).where, "debug");
  assert.equal(ui.debugState().timeline.level, "trace");
  assert.deepEqual(names(), ["log.open", "host.window.created", "page.call.slow"]);
});

test("a query that fails when the timeline is shown leaves no timeline and shows the error with its file", async (t) => {
  const query = served(SMALL);
  query.log.failure = new Error("logs/host-a.jsonl:2: not JSON: broken");
  const { ui, shown } = await openView(t, { query });
  await assert.rejects(ui.showDebugTimeline(), /logs\/host-a\.jsonl:2: not JSON: broken/);
  assert.match(ui.debugState().error, /^timeline: logs\/host-a\.jsonl:2:/);
  assert.equal(shown.at(-1).where, "debug");
  assert.equal(ui.debugState().timeline, null);
});

test("every interactive element of the timeline points to a declared command and has a dom name", async (t) => {
  const { ui } = await openView(t, { query: served(SMALL) });
  await ui.showDebugTimeline();
  const controls = [...document.querySelectorAll(".dbg-card button, .dbg-card input, .dbg-card select")];
  for (const el of controls) {
    assert.ok(el.dataset.command, `${el.outerHTML} has no command`);
    assert.ok(el.dataset.expose, `${el.outerHTML} has no dom name`);
  }
  assert.equal(document.querySelector('[data-expose="core.debug.timeline.older"]').dataset.command, "core.debug.timeline.older");
  const filters = [...document.querySelectorAll(".dbg-card__timeline [data-set]")];
  assert.deepEqual(filters.map((el) => el.dataset.set).toSorted(), ["channel", "cid", "class", "event", "event_prefix", "from", "layer", "level", "run", "session", "surface", "text", "to"]);
  for (const el of filters) {
    assert.equal(el.dataset.command, "core.debug.timeline.filter");
    assert.equal(el.dataset.value, el.dataset.set);
    assert.equal(el.dataset.expose, `core.debug.timeline.${el.dataset.set.replace("_", "-")}`);
  }
});

const savedTexts = () => {
  const saves = [];
  return { saves, saveText: async (request) => { saves.push(request); return { saved: "/chosen/timeline.txt" }; } };
};

test("rows are selected and unselected by index, and the status reports the count and the warning", async (t) => {
  const { ui } = await openView(t, { query: served(SMALL) });
  await ui.showDebugTimeline();
  ui.selectDebugRow(2, true);
  ui.selectDebugRow(2, true);
  ui.selectDebugRow(0, true);
  assert.equal(ui.debugState().timeline.selected, 2);
  const picks = [...document.querySelectorAll('[data-expose="core.debug.timeline.select"]')];
  assert.deepEqual(picks.map((el) => el.closest("[data-selected]")?.dataset.selected ?? "none"), ["true", "false", "true"]);
  ui.selectDebugRow(2, false);
  assert.equal(ui.debugState().timeline.selected, 1);
  assert.throws(() => ui.selectDebugRow(3, true), /timeline row 3 is not one of the 3 rows/);
  assert.throws(() => ui.selectDebugRow(0, "yes"), /timeline selected must be a boolean, found "yes"/);
  assert.throws(() => ui.selectDebugRow(-1, true), /timeline row -1 is not one of the 3 rows/);
  assert.equal(document.querySelector('[data-expose="core.debug.timeline.warning"]').textContent, ui.debugState().timeline.warning);
});

test("a selection stays on its row when the filter changes and when older rows come in front", async (t) => {
  const many = Array.from({ length: 700 }, (_, index) => row(index + 1, 100 + index, "host.fixture.row", { fields: { n: index } }));
  const { ui } = await openView(t, { query: served(many) });
  await ui.showDebugTimeline();
  ui.selectDebugRow(499, true);
  await ui.olderDebugTimeline();
  const picks = [...document.querySelectorAll('[data-expose="core.debug.timeline.select"]')];
  assert.equal(picks.findIndex((el) => el.closest("[data-selected]").dataset.selected === "true"), 699);
  await ui.filterDebugTimeline({ level: "info" });
  assert.equal(ui.debugState().timeline.selected, 1);
  const again = [...document.querySelectorAll('[data-expose="core.debug.timeline.select"]')];
  assert.equal(again.findIndex((el) => el.closest("[data-selected]").dataset.selected === "true"), 499);
});

test("the selected rows are saved in timeline order as one text, also those that the filter hides", async (t) => {
  const { saves, saveText } = savedTexts();
  const { ui } = await openView(t, { query: served(SMALL), saveText });
  await ui.showDebugTimeline();
  ui.selectDebugRow(2, true);
  ui.selectDebugRow(1, true);
  await ui.filterDebugTimeline({ level: "warn" });
  assert.deepEqual(await ui.saveDebugRows(), { saved: "/chosen/timeline.txt" });
  assert.equal(saves.length, 1);
  assert.match(saves[0].name, /^soksak-timeline-\d{8}T\d{6}Z\.txt$/);
  assert.deepEqual(saves[0].text.split("\n"), [
    "1970-01-01T00:00:00.000020Z debug host host.window.created window=w1",
    '1970-01-01T00:00:00.000030Z warn page page.call.slow name="windows.list"',
    "",
  ]);
  assert.deepEqual(ui.debugState().operation, { action: "save-rows", path: saves[0].name, state: "done" });
});

test("a cancelled save panel leaves no error and an empty selection is refused with an error", async (t) => {
  const { ui, shown } = await openView(t, { query: served(SMALL), saveText: async () => ({ saved: null }) });
  await ui.showDebugTimeline();
  await assert.rejects(ui.saveDebugRows(), /no timeline row is selected/);
  assert.match(ui.debugState().error, /^save-rows: no timeline row is selected/);
  assert.equal(shown.at(-1).where, "debug");
  ui.selectDebugRow(0, true);
  assert.deepEqual(await ui.saveDebugRows(), { saved: null });
  assert.equal(ui.debugState().error, null);
  ui.listDebugFiles();
  await assert.rejects(ui.saveDebugRows(), /the debug timeline is not shown/);
});

test("a changed event file adds the rows after the tail in time order, also a row with an earlier clock, and keeps the filter and the selection", async (t) => {
  const query = served(SMALL);
  const { ui, changed } = await openView(t, { query });
  await ui.showDebugTimeline();
  ui.selectDebugRow(2, true);
  await ui.filterDebugTimeline({ layer: "host" });
  const before = query.log.requests.length;
  // The row of seq 5 has a clock earlier than the newest held row, and it is the row that only `since` finds.
  query.log.rows.push(row(4, 40, "host.app.event"), row(5, 25, "host.late.row"));
  await changed("logs/host-a.jsonl");
  assert.equal(query.log.requests.length, before + 1);
  assert.deepEqual(query.log.requests.at(-1), { channel: "other", level: "trace", layer: "host", order: "asc", limit: PAGE_ROWS, since: { "host-a": 3 } });
  const status = ui.debugState().timeline;
  assert.equal(status.held, 4);
  assert.equal(status.appended, 2);
  assert.equal(status.layer, "host");
  assert.equal(status.selected, 1);
  assert.deepEqual(names(), ["log.open", "host.window.created", "host.late.row", "host.app.event"]);
  await ui.filterDebugTimeline({ layer: "all" });
  assert.equal(ui.debugState().timeline.selected, 1);
  assert.equal(ui.debugState().error, null);
});

test("following pages through the rows that grew until none is left and asks again from the first tail", async (t) => {
  const query = served(SMALL);
  const { ui, changed } = await openView(t, { query });
  await ui.showDebugTimeline();
  const grown = Array.from({ length: PAGE_ROWS + 20 }, (_, index) => row(10 + index, 1000 + index, "host.grown.row"));
  query.log.rows.push(...grown);
  await changed("logs/host-a.jsonl");
  const asked = query.log.requests.slice(-2);
  assert.deepEqual(asked.map((request) => request.order), ["asc", "asc"]);
  assert.equal(asked[0].after, undefined);
  assert.equal(asked[1].after.seq, 10 + PAGE_ROWS - 1);
  assert.deepEqual(asked[1].since, { "host-a": 3 }, "every page of one read asks after the same tail");
  assert.equal(ui.debugState().timeline.held, 3 + PAGE_ROWS + 20);
  assert.equal(ui.debugState().timeline.appended, PAGE_ROWS + 20);
  const calls = query.log.requests.length;
  await changed("logs/host-a.jsonl");
  assert.deepEqual(query.log.requests[calls].since, { "host-a": 10 + PAGE_ROWS + 19 });
  assert.equal(ui.debugState().timeline.held, 3 + PAGE_ROWS + 20, "a read that found nothing changed the rows");
});

test("the rows beyond the hold limit leave the view from the old end and are counted", async (t) => {
  const query = served(SMALL);
  const { ui, changed } = await openView(t, { query });
  await ui.showDebugTimeline();
  const grown = Array.from({ length: HOLD_LIMIT }, (_, index) => row(10 + index, 1000 + index, "host.grown.row", { fields: { n: index } }));
  query.log.rows.push(...grown);
  await changed("logs/host-a.jsonl");
  const status = ui.debugState().timeline;
  assert.equal(status.held, HOLD_LIMIT);
  assert.equal(status.omitted, 3);
  assert.equal(status.older, true);
  assert.equal(status.appended, HOLD_LIMIT);
  assert.match(rowsText().at(-1), new RegExp(`n=${HOLD_LIMIT - 1}$`));
  assert.match(rowsText()[0], /n=0$/);
  const label = document.querySelector('[data-expose="core.debug.timeline.omitted"]');
  assert.equal(label.hidden, false);
  assert.match(label.textContent, /앞쪽 3행은 보관하지 않음/);
  assert.equal(document.querySelector('[data-key="timeline-older"]').hidden, false);
});

test("a notice of a file that is not an event file reads nothing, and a notice without a timeline too", async (t) => {
  const query = served(SMALL);
  const { ui, changed } = await openView(t, { query });
  await changed("logs/host-a.jsonl");
  assert.equal(query.log.requests.length, 0, "a notice while no timeline is shown asked");
  await ui.showDebugTimeline();
  const calls = query.log.requests.length;
  await changed("logs/host-a.stderr");
  await changed("logs/state-20261009T010203Z.json");
  assert.equal(query.log.requests.length, calls);
});

test("stopping follows no more queries and resuming asks for what grew while stopped", async (t) => {
  const query = served(SMALL);
  const { ui, changed } = await openView(t, { query });
  await ui.showDebugTimeline();
  await ui.followDebugTimeline(false);
  assert.equal(ui.debugState().timeline.following, false);
  const button = document.querySelector('[data-expose="core.debug.timeline.follow"]');
  assert.equal(button.dataset.command, "core.debug.timeline.follow");
  assert.deepEqual(JSON.parse(button.dataset.params), { on: true });
  const calls = query.log.requests.length;
  query.log.rows.push(row(8, 60));
  await changed("logs/host-a.jsonl");
  assert.equal(query.log.requests.length, calls);
  assert.equal(ui.debugState().timeline.held, 3);
  await ui.followDebugTimeline(true);
  assert.equal(ui.debugState().timeline.following, true);
  assert.equal(ui.debugState().timeline.held, 4);
  assert.equal(ui.debugState().timeline.appended, 1);
  assert.deepEqual(JSON.parse(button.dataset.params), { on: false });
  await assert.rejects(ui.followDebugTimeline("yes"), /timeline follow must be a boolean, found "yes"/);
  ui.listDebugFiles();
  await assert.rejects(ui.followDebugTimeline(true), /the debug timeline is not shown/);
});

test("a query that fails while following stops following and is shown with its file and line", async (t) => {
  const query = served(SMALL);
  const { ui, shown, changed } = await openView(t, { query });
  await ui.showDebugTimeline();
  query.log.failure = new Error("logs/host-a.jsonl:4: not JSON: broken");
  await changed("logs/host-a.jsonl");
  assert.match(ui.debugState().error, /^follow: logs\/host-a\.jsonl:4: not JSON: broken/);
  assert.equal(shown.at(-1).where, "debug");
  assert.equal(ui.debugState().timeline.following, false);
  assert.equal(ui.debugState().timeline.held, 3);
});

test("the timeline follows a file that grows all the time with a pause between two updates and loses no row", async (t) => {
  const query = served(SMALL);
  const { ui, changed } = await openView(t, { query });
  await ui.showDebugTimeline();
  const stamps = [];
  const original = query.log.requests.push.bind(query.log.requests);
  query.log.requests.push = (request) => { stamps.push(performance.now()); return original(request); };
  // The page redraws every row at each update, so a file that grows at every moment would keep the page busy for ever: the
  // second update waits until the interval since the first one ended, and it asks for what grew meanwhile.
  query.log.rows.push(row(4, 40));
  await changed("logs/host-a.jsonl");
  query.log.rows.push(row(5, 50));
  await changed("logs/host-a.jsonl");
  assert.equal(stamps.length >= 2, true, `the host was asked ${stamps.length} times after the file grew`);
  assert.ok(stamps.at(-1) - stamps[0] >= FOLLOW_INTERVAL_MS - 50, `the updates are ${stamps.at(-1) - stamps[0]} ms apart, less than ${FOLLOW_INTERVAL_MS} ms`);
  assert.equal(ui.debugState().timeline.held, 5, "a row that grew was not added");
});
