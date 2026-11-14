// The debug view shows the events of the event files as a timeline that pages through the query of the host: the rows, the filters,
// the older pages, the following, the status, the bound controls and the shown errors (docs/spec/debug.md#timeline). The host calls and the
// notices of each test are the page-wire case of the test (docs/spec/cases/page-wire/README.md): the replies of `logQuery` are the pages that the
// host answers (rows, next, tail, scanned, rejected) for the request that the case records.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as timelineModule from "../debug-timeline.js";
import { HOLD_LIMIT, PAGE_ROWS } from "../debug-timeline.js";
import { openDebugView } from "./support/debug-document.mjs";

/** The requests of the host call `logQuery` that the page sent, in order. */
const queriesOf = (wire) => wire.calls.filter((call) => call.name === "logQuery").map((call) => call.payload);
/** The requests of the host call `debugSaveText` that the page sent, in order. */
const savesOf = (wire) => wire.calls.filter((call) => call.name === "debugSaveText").map((call) => call.payload);
/** The text of the error display of the view, or null when none is shown. */
const shownText = () => document.querySelector('[data-error="debug"]')?.textContent ?? null;
const shownWhere = () => document.querySelector('[data-error="debug"]')?.dataset.error ?? null;
const settled = () => new Promise((resolve) => setImmediate(resolve));
/** The notice `debug-log-changed` of a file reaches the listener of the page, whose queries end before the next turn. */
const changed = async (wire) => {
  wire.deliverNotice();
  await settled();
};

const WARNING = "저장한 파일에는 입력한 글자가 들어 있을 수 있다.";
const rowsText = () => [...document.querySelectorAll('[data-expose="core.debug.timeline.row"]')].map((r) => r.textContent);
const names = () => rowsText().map((text) => text.split(" ")[3]);

test("the timeline asks for the newest page and shows it oldest first with the status of the pages", async () => {
  const { ui, wire, close } = await openDebugView("debug-timeline-ui-newest");
  try {
    await ui.showDebugTimeline();
    assert.deepEqual(queriesOf(wire), [{ channel: "other", level: "trace", order: "desc", limit: PAGE_ROWS }]);
    assert.deepEqual(names(), ["log.open", "host.window.created", "workbench.call.slow"]);
    assert.deepEqual(ui.debugState().timeline, {
      following: true, appended: 0, held: 3, older: false, omitted: 0, context: 0, selected: 0, warning: WARNING,
      start: { "host-a": 3 }, tail: { "host-a": 3 }, channel: "other", level: "trace", class: "", layer: "all", text: "", event: "", event_prefix: "", surface: "", session: "", cid: "", run: "", from: "", to: "",
    });
    assert.equal(document.querySelector('[data-key="timeline-older"]').hidden, true);
    assert.equal(document.querySelector('[data-expose="core.debug.timeline.omitted"]').hidden, true);
    ui.listDebugFiles();
    assert.equal(ui.debugState().timeline, null);
  } finally {
    await close();
  }
  wire.finish();
});

test("a log of more rows than a page opens as one page and the older pages come in front of it", async () => {
  const { ui, wire, close } = await openDebugView("debug-timeline-ui-older");
  try {
    await ui.showDebugTimeline();
    assert.equal(rowsText().length, PAGE_ROWS, "the page drew more than a page");
    assert.match(rowsText().at(-1), /n=1299$/);
    assert.match(rowsText()[0], /n=800$/);
    assert.equal(ui.debugState().timeline.older, true);
    assert.equal(document.querySelector('[data-key="timeline-older"]').hidden, false);
    await ui.olderDebugTimeline();
    assert.equal(rowsText().length, 2 * PAGE_ROWS);
    assert.match(rowsText()[0], /n=300$/);
    assert.deepEqual(queriesOf(wire).at(-1).after, { ts_us: 900, role: "host", boot: "a", seq: 801 });
    assert.equal(queriesOf(wire).at(-1).order, "desc");
    await ui.olderDebugTimeline();
    assert.equal(rowsText().length, 1300);
    assert.equal(ui.debugState().timeline.older, false);
    const requests = queriesOf(wire).length;
    await ui.olderDebugTimeline();
    assert.equal(queriesOf(wire).length, requests, "a timeline without an older row asked again");
    assert.equal(document.querySelector('[data-key="timeline-older"]').hidden, true);
  } finally {
    await close();
  }
  wire.finish();
});

test("the view holds at most 2000 rows and refuses an older page beyond them with an error", async () => {
  const { ui, wire, close } = await openDebugView("debug-timeline-ui-hold-limit");
  try {
    await ui.showDebugTimeline();
    for (let page = 0; page < 3; page += 1) await ui.olderDebugTimeline();
    assert.equal(rowsText().length, HOLD_LIMIT);
    assert.equal(queriesOf(wire).at(-1).limit, HOLD_LIMIT - 3 * PAGE_ROWS, "the last page asks only for the room that is left");
    assert.equal(ui.debugState().timeline.older, true);
    await assert.rejects(ui.olderDebugTimeline(), /the timeline holds 2000 rows; narrow the filter or the time/);
    assert.match(ui.debugState().error, /^older: the timeline holds 2000 rows/);
    assert.equal(shownWhere(), "debug");
    assert.equal(rowsText().length, HOLD_LIMIT);
  } finally {
    await close();
  }
  wire.finish();
});

test("the filter asks the host for the newest page again with the members of the filter", async () => {
  const { ui, wire, close } = await openDebugView("debug-timeline-ui-filter");
  try {
    await ui.showDebugTimeline();
    await ui.filterDebugTimeline({ level: "warn" });
    assert.deepEqual(queriesOf(wire).at(-1), { channel: "other", level: "warn", order: "desc", limit: PAGE_ROWS });
    assert.deepEqual(names(), ["workbench.call.slow"]);
    await ui.filterDebugTimeline({ level: "trace", layer: "host", text: "WINDOW", from: "1970-01-01T00:00:00.000020Z", to: "1970-01-01T00:00:00.000020Z" });
    assert.deepEqual(queriesOf(wire).at(-1), { channel: "other", level: "trace", layer: "host", text: "WINDOW", from_us: 20, to_us: 20, order: "desc", limit: PAGE_ROWS });
    assert.deepEqual(names(), ["host.window.created"]);
    assert.equal(ui.debugState().timeline.layer, "host");
    assert.equal(ui.debugState().timeline.held, 1);
    await ui.filterDebugTimeline({ channel: "all", event_prefix: "host.window", class: "input", run: "r1", cid: "c1", surface: "s", session: "x", event: "" });
    assert.deepEqual(queriesOf(wire).at(-1), { channel: "all", level: "trace", layer: "host", text: "WINDOW", class: "input", event_prefix: "host.window", surface: "s", session: "x", cid: "c1", run: "r1", from_us: 20, to_us: 20, order: "desc", limit: PAGE_ROWS });
    await assert.rejects(async () => ui.filterDebugTimeline({}), /timeline filter needs channel, level, class, layer, text, event, event_prefix, surface, session, cid, run, from, to/);
    await assert.rejects(async () => ui.filterDebugTimeline({ colour: "red" }), /timeline filter has no member colour/);
    await assert.rejects(ui.filterDebugTimeline({ from: "yesterday" }), /log query from "yesterday" is not a UTC time like 2026-10-08T22:53:20\.123456Z/);
    assert.equal(ui.debugState().timeline.from, "1970-01-01T00:00:00.000020Z", "a refused filter changed the filter");
    assert.equal(ui.debugState().timeline.held, 0);
  } finally {
    await close();
  }
  wire.finish();
});

test("a query that the host refuses is shown through the error display and the shown rows stay", async () => {
  const { ui, wire, close } = await openDebugView("debug-timeline-ui-refused");
  try {
    await ui.showDebugTimeline();
    await assert.rejects(ui.filterDebugTimeline({ level: "loud" }), /log query level "loud" is not one of/);
    assert.match(ui.debugState().error, /^filter: log query level "loud" is not one of error, warn, info, debug, trace/);
    assert.equal(shownWhere(), "debug");
    assert.equal(ui.debugState().timeline.level, "trace");
    assert.deepEqual(names(), ["log.open", "host.window.created", "workbench.call.slow"]);
  } finally {
    await close();
  }
  wire.finish();
});

test("a file that the query rejected is shown through the error display beside the rows of the other files", async () => {
  const { ui, wire, close } = await openDebugView("debug-timeline-ui-rejected-file");
  try {
    await ui.showDebugTimeline();
    assert.deepEqual(names(), ["log.open", "host.window.created", "workbench.call.slow"]);
    assert.equal(shownWhere(), "debug");
    assert.equal(shownText(), "rejected: logs/files-old.jsonl: schema 2 is not 3");
    assert.equal(ui.debugState().error, null, "a rejected file is no failed step");
    await assert.rejects(ui.filterDebugTimeline({ level: "loud" }));
    assert.match(shownText(), /^filter: log query level "loud"/);
    assert.match(shownText(), /\nrejected: logs\/files-old\.jsonl: schema 2 is not 3$/);
  } finally {
    await close();
  }
  wire.finish();
});

test("a page without the list of the rejected files is refused", async () => {
  const { ui, wire, close } = await openDebugView("debug-timeline-ui-no-rejected-list");
  try {
    await assert.rejects(ui.showDebugTimeline(), /without rows, a tail and the rejected files/);
  } finally {
    await close();
  }
  wire.finish();
});

test("a query that fails when the timeline is shown leaves no timeline and shows the error with its file", async () => {
  const { ui, wire, close } = await openDebugView("debug-timeline-ui-show-fails");
  try {
    await assert.rejects(ui.showDebugTimeline(), /logs\/host-a\.jsonl:2: not JSON: broken/);
    assert.match(ui.debugState().error, /^timeline: logs\/host-a\.jsonl:2:/);
    assert.equal(shownWhere(), "debug");
    assert.equal(ui.debugState().timeline, null);
  } finally {
    await close();
  }
  wire.finish();
});

test("every interactive element of the timeline points to a declared command and has an element name", async () => {
  const { ui, wire, close } = await openDebugView("debug-timeline-ui-controls");
  try {
    await ui.showDebugTimeline();
    const controls = [...document.querySelectorAll(".dbg-card button, .dbg-card input, .dbg-card select")];
    for (const el of controls) {
      assert.ok(el.dataset.command, `${el.outerHTML} has no command`);
      assert.ok(el.dataset.expose, `${el.outerHTML} has no element name`);
    }
    assert.equal(document.querySelector('[data-expose="core.debug.timeline.older"]').dataset.command, "core.debug.timeline.older");
    const filters = [...document.querySelectorAll(".dbg-card__timeline [data-set]")];
    assert.deepEqual(filters.map((el) => el.dataset.set).toSorted(), ["channel", "cid", "class", "event", "event_prefix", "from", "layer", "level", "run", "session", "surface", "text", "to"]);
    for (const el of filters) {
      assert.equal(el.dataset.command, "core.debug.timeline.filter");
      assert.equal(el.dataset.value, el.dataset.set);
      assert.equal(el.dataset.expose, `core.debug.timeline.${el.dataset.set.replace("_", "-")}`);
    }
  } finally {
    await close();
  }
  wire.finish();
});

test("the layer choices of the timeline are every layer of the event contract, the workbench included, and the declarations list the same", async () => {
  const { ui, wire, close } = await openDebugView("debug-timeline-ui-layers");
  try {
    await ui.showDebugTimeline();
    const layers = ["all", "native", "host", "workbench", "page", "plugin", "sidecar", "sok"];
    const select = document.querySelector('[data-expose="core.debug.timeline.layer"]');
    assert.deepEqual([...select.querySelectorAll("option")].map((option) => option.value), layers);
    const exposure = JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8"));
    const status = exposure.exposes.status.find(({ name }) => name === "core.debug");
    const command = exposure.exposes.commands.find(({ name }) => name === "core.debug.timeline.filter");
    assert.deepEqual(status.schema.properties.timeline.properties.layer.enum, layers);
    assert.deepEqual(command.params.properties.layer.enum, layers);
    await ui.filterDebugTimeline({ layer: "workbench" });
    assert.equal(ui.debugState().timeline.layer, "workbench");
  } finally {
    await close();
  }
  wire.finish();
});

test("rows are selected and unselected by index, and the status reports the count and the warning", async () => {
  const { ui, wire, close } = await openDebugView("debug-timeline-ui-select");
  try {
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
  } finally {
    await close();
  }
  wire.finish();
});

test("a selection stays on its row when the filter changes and when older rows come in front", async () => {
  const { ui, wire, close } = await openDebugView("debug-timeline-ui-selection-kept");
  try {
    await ui.showDebugTimeline();
    ui.selectDebugRow(499, true);
    await ui.olderDebugTimeline();
    const picks = [...document.querySelectorAll('[data-expose="core.debug.timeline.select"]')];
    assert.equal(picks.findIndex((el) => el.closest("[data-selected]").dataset.selected === "true"), 699);
    await ui.filterDebugTimeline({ level: "info" });
    assert.equal(ui.debugState().timeline.selected, 1);
    const again = [...document.querySelectorAll('[data-expose="core.debug.timeline.select"]')];
    assert.equal(again.findIndex((el) => el.closest("[data-selected]").dataset.selected === "true"), 499);
  } finally {
    await close();
  }
  wire.finish();
});

test("the selected rows are saved in timeline order as one text, also those that the filter hides", async () => {
  const { ui, wire, close } = await openDebugView("debug-timeline-ui-save-selected");
  try {
    await ui.showDebugTimeline();
    ui.selectDebugRow(2, true);
    ui.selectDebugRow(1, true);
    await ui.filterDebugTimeline({ level: "warn" });
    assert.deepEqual(await ui.saveDebugRows(), { saved: "/chosen/timeline.txt" });
    const saves = savesOf(wire);
    assert.equal(saves.length, 1);
    assert.match(saves[0].name, /^soksak-timeline-\d{8}T\d{6}Z\.txt$/);
    assert.deepEqual(saves[0].text.split("\n"), [
      "1970-01-01T00:00:00.000020Z debug host host.window.created window=w1",
      '1970-01-01T00:00:00.000030Z warn workbench workbench.call.slow name="windows.list"',
      "",
    ]);
    assert.deepEqual(ui.debugState().operation, { action: "save-rows", path: saves[0].name, state: "done" });
  } finally {
    await close();
  }
  wire.finish();
});

test("a cancelled save panel leaves no error and an empty selection is refused with an error", async () => {
  const { ui, wire, close } = await openDebugView("debug-timeline-ui-save-cancelled");
  try {
    await ui.showDebugTimeline();
    await assert.rejects(ui.saveDebugRows(), /no timeline row is selected/);
    assert.match(ui.debugState().error, /^save-rows: no timeline row is selected/);
    assert.equal(shownWhere(), "debug");
    ui.selectDebugRow(0, true);
    assert.deepEqual(await ui.saveDebugRows(), { saved: null });
    assert.equal(ui.debugState().error, null);
    ui.listDebugFiles();
    await assert.rejects(ui.saveDebugRows(), /the debug timeline is not shown/);
  } finally {
    await close();
  }
  wire.finish();
});

test("a changed event file adds the rows after the tail in time order, also a row with an earlier clock, and keeps the filter and the selection", async () => {
  const { ui, wire, close } = await openDebugView("debug-timeline-ui-follow-changed");
  try {
    await ui.showDebugTimeline();
    ui.selectDebugRow(2, true);
    await ui.filterDebugTimeline({ layer: "host" });
    const before = queriesOf(wire).length;
    // The host wrote two rows: the row of seq 5 has a clock earlier than the newest held row, and it is the row that only `since` finds.
    await changed(wire);
    assert.equal(queriesOf(wire).length, before + 1);
    assert.deepEqual(queriesOf(wire).at(-1), { channel: "other", level: "trace", layer: "host", order: "asc", limit: PAGE_ROWS, since: { "host-a": 3 } });
    const status = ui.debugState().timeline;
    assert.equal(status.held, 4);
    assert.equal(status.appended, 2);
    // The appended rows are the rows after the tail of the page that showed the timeline, up to the tail of the last read.
    assert.deepEqual([status.start, status.tail], [{ "host-a": 3 }, { "host-a": 5 }]);
    assert.equal(status.layer, "host");
    assert.equal(status.selected, 1);
    assert.deepEqual(names(), ["log.open", "host.window.created", "host.late.row", "host.app.event"]);
    await ui.filterDebugTimeline({ layer: "all" });
    assert.equal(ui.debugState().timeline.selected, 1);
    assert.equal(ui.debugState().error, null);
  } finally {
    await close();
  }
  wire.finish();
});

test("following pages through the rows that grew until none is left and asks again from the first tail", async () => {
  const { ui, wire, close } = await openDebugView("debug-timeline-ui-follow-pages");
  try {
    await ui.showDebugTimeline();
    await changed(wire);
    const asked = queriesOf(wire).slice(-2);
    assert.deepEqual(asked.map((request) => request.order), ["asc", "asc"]);
    assert.equal(asked[0].after, undefined);
    assert.equal(asked[1].after.seq, 10 + PAGE_ROWS - 1);
    assert.deepEqual(asked[1].since, { "host-a": 3 }, "every page of one read asks after the same tail");
    assert.equal(ui.debugState().timeline.held, 3 + PAGE_ROWS + 20);
    assert.equal(ui.debugState().timeline.appended, PAGE_ROWS + 20);
    const calls = queriesOf(wire).length;
    await changed(wire);
    assert.deepEqual(queriesOf(wire)[calls].since, { "host-a": 10 + PAGE_ROWS + 19 });
    assert.equal(ui.debugState().timeline.held, 3 + PAGE_ROWS + 20, "a read that found nothing changed the rows");
  } finally {
    await close();
  }
  wire.finish();
});

test("the rows beyond the hold limit leave the view from the old end and are counted", async () => {
  const { ui, wire, close } = await openDebugView("debug-timeline-ui-follow-hold-limit");
  try {
    await ui.showDebugTimeline();
    await changed(wire);
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
  } finally {
    await close();
  }
  wire.finish();
});

test("a notice of a file that is not an event file reads nothing, and a notice without a timeline too", async () => {
  const { ui, wire, close } = await openDebugView("debug-timeline-ui-follow-other-files");
  try {
    await changed(wire);
    assert.equal(queriesOf(wire).length, 0, "a notice while no timeline is shown asked");
    await ui.showDebugTimeline();
    const calls = queriesOf(wire).length;
    await changed(wire);
    await changed(wire);
    assert.equal(queriesOf(wire).length, calls);
  } finally {
    await close();
  }
  wire.finish();
});

test("stopping follows no more queries and resuming asks for what grew while stopped", async () => {
  const { ui, wire, close } = await openDebugView("debug-timeline-ui-follow-stopped");
  try {
    await ui.showDebugTimeline();
    await ui.followDebugTimeline(false);
    assert.equal(ui.debugState().timeline.following, false);
    const button = document.querySelector('[data-expose="core.debug.timeline.follow"]');
    assert.equal(button.dataset.command, "core.debug.timeline.follow");
    assert.deepEqual(JSON.parse(button.dataset.params), { on: true });
    const calls = queriesOf(wire).length;
    await changed(wire);
    assert.equal(queriesOf(wire).length, calls);
    assert.equal(ui.debugState().timeline.held, 3);
    await ui.followDebugTimeline(true);
    assert.equal(ui.debugState().timeline.following, true);
    assert.equal(ui.debugState().timeline.held, 4);
    assert.equal(ui.debugState().timeline.appended, 1);
    assert.deepEqual(JSON.parse(button.dataset.params), { on: false });
    await assert.rejects(ui.followDebugTimeline("yes"), /timeline follow must be a boolean, found "yes"/);
    ui.listDebugFiles();
    await assert.rejects(ui.followDebugTimeline(true), /the debug timeline is not shown/);
  } finally {
    await close();
  }
  wire.finish();
});

test("a query that fails while following stops following and is shown with its file and line", async () => {
  const { ui, wire, close } = await openDebugView("debug-timeline-ui-follow-fails");
  try {
    await ui.showDebugTimeline();
    await changed(wire);
    assert.match(ui.debugState().error, /^follow: logs\/host-a\.jsonl:4: not JSON: broken/);
    assert.equal(shownWhere(), "debug");
    assert.equal(ui.debugState().timeline.following, false);
    assert.equal(ui.debugState().timeline.held, 3);
  } finally {
    await close();
  }
  wire.finish();
});

test("the timeline asks at each notice without a pause of its own and loses no row", async () => {
  const { ui, wire, close } = await openDebugView("debug-timeline-ui-follow-each-notice");
  try {
    await ui.showDebugTimeline();
    // The rate of the notices is bounded by the host (docs/spec/debug.md#following), so the view has no timer: the second notice is
    // answered at once and asks for what grew meanwhile. The timeline module has no timer of its own, and the host bounds the notices
    // by contract (docs/spec/debug.md#following), so each notice is answered by its own query.
    assert.equal("FOLLOW_INTERVAL_MS" in timelineModule, false, "the view keeps an interval of its own");
    await changed(wire);
    await changed(wire);
    assert.equal(ui.debugState().timeline.held, 5, "a row that grew was not added");
  } finally {
    await close();
  }
  wire.finish();
});

test("the context of a row brings its neighbours in key order whatever the filter is, marks them, and a new filter removes them", async () => {
  const { ui, wire, close } = await openDebugView("debug-timeline-ui-context");
  try {
    await ui.showDebugTimeline();
    await ui.filterDebugTimeline({ level: "warn" });
    assert.deepEqual(rowsText().map((text) => text.split(" ")[0].slice(0, 25)).length, 5, "the five rows of level warn");
    const calls = queriesOf(wire).length;
    // The third shown row is the event of seq 5; its two neighbours on each side are asked for.
    await ui.contextDebugRow(2);
    assert.deepEqual(queriesOf(wire).slice(calls), [{ channel: "other", around: { ts_us: 50, role: "host", boot: "a", seq: 5 }, earlier: timelineModule.CONTEXT_ROWS, later: timelineModule.CONTEXT_ROWS }]);
    const texts = rowsText();
    assert.equal(texts.length, 10, "the five rows of level warn and the five neighbours that the filter left out, which are all the others");
    assert.deepEqual(texts.filter((text) => text.startsWith("  ")).length, 5);
    assert.equal(ui.debugState().timeline.context, 5);
    assert.equal(ui.debugState().timeline.held, 10);
    // The row at the cursor and the rows that pass the filter are not context.
    assert.equal(texts.filter((text) => !text.startsWith("  ")).length, 5);
    const button = document.querySelector('[data-key="context:2"]');
    assert.equal(button.dataset.command, "core.debug.timeline.context");
    await ui.filterDebugTimeline({ level: "warn" });
    assert.equal(ui.debugState().timeline.context, 0, "a new filter shows its own rows only");
    assert.equal(rowsText().length, 5);
    await assert.rejects(ui.contextDebugRow(99), /timeline row 99 is not one of the 5 rows/);
    ui.listDebugFiles();
    await assert.rejects(ui.contextDebugRow(0), /the debug timeline is not shown/);
  } finally {
    await close();
  }
  wire.finish();
});

test("a row that a context query brought in and that following reads again stops being context", async () => {
  const { ui, wire, close } = await openDebugView("debug-timeline-ui-context-followed");
  try {
    await ui.showDebugTimeline();
    await ui.contextDebugRow(2);
    assert.equal(ui.debugState().timeline.context, 1, "the row that came after the tail is context");
    await changed(wire);
    assert.equal(ui.debugState().timeline.context, 0);
    assert.equal(rowsText().length, 4);
    assert.equal(rowsText().filter((text) => text.startsWith("  ")).length, 0);
  } finally {
    await close();
  }
  wire.finish();
});

test("the saved lines of selected rows are the lines of the events, also for a row that is only context", async () => {
  const { ui, wire, close } = await openDebugView("debug-timeline-ui-save-context");
  try {
    await ui.showDebugTimeline();
    await ui.filterDebugTimeline({ level: "warn" });
    await ui.contextDebugRow(2);
    const contextIndex = rowsText().findIndex((text) => text.startsWith("  "));
    ui.selectDebugRow(contextIndex, true);
    await ui.saveDebugRows();
    const saved = savesOf(wire);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].text.startsWith(" "), false, "the saved line has no indent");
    assert.equal(saved[0].text.split("\n").filter(Boolean).length, 1);
  } finally {
    await close();
  }
  wire.finish();
});
