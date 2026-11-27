// Checks the menus that open as native modals (transparent, without a backdrop) and the Help > Debug views (docs/spec/native-modals.md).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { APPS, holdCovered, MAIN_PAGE_APPS, open } from "@soksak/window-check/app.mjs";
import { fresh as prepare, holdDialogs } from "./fixture.mjs";
import { channelOtherSeqs, expectedTimeline, PAGE_ROWS } from "./debug-timeline-files.mjs";

// Functional paint checks explicitly render covered windows without activation.
// This preparation does not change production benchmark visibility requirements.
async function fresh(s, options) {
  const tab = await prepare(s, options);
  s.cleanup(await holdCovered(s));
  await s.presented();
  return tab;
}

/** Checks that the modal web view does not paint its own background. */
function transparent(modal) {
  assert.equal(modal.background.draws, false, "the native webview must not paint a background before its DOM");
  assert.equal(modal.background.alpha, 0, "the under-page background must also be transparent");
}

/** Checks that the background blur is applied to the main document and the documents of the visible plugin surfaces as enabled says. */
async function background(s, enabled) {
  await s.until("core.window.workbench", (workbench) => workbench.background === enabled,
    `the workbench background state must be ${enabled}`);
  for (const surface of await s.surfaces()) {
    // The host blurs the page of a view surface and its regions natively, and host.window reports the filter of each document
    // web view and image region as blurred (docs/spec/native-surfaces.md#regions); a module surface carries the CSS blur of its document.
    if (surface.composition === "view") {
      await s.until("host.window", (state) => {
        const documents = state.documents.filter((entry) => entry.surface === surface.surface);
        const regions = state.regions.filter((entry) => entry.surface === surface.surface);
        return documents.length > 0 && [...documents, ...regions].every((entry) => entry.blurred === enabled);
      }, `${surface.surface}: the native blur of its documents must match dialog visibility`);
      continue;
    }
    if (!surface.exposes.includes("status core.surface.document")) continue;
    await s.until("core.surface.document", (doc) => doc.readyState !== "loading"
      && doc.filter === (enabled ? "blur(3px)" : "none"),
    `${surface.surface}: background blur must match dialog visibility`, { surface: surface.surface });
  }
}

// These cases read the modal document (core.modal document), hold its first answer (diagnostics.modal.hold) or dispatch events
// to its elements, so they run on the applications that create modal web views (MAIN_PAGE_APPS).
for (const app of MAIN_PAGE_APPS) {

  test(`${app.name}: add and split menus are transparent and have no backdrop`, { timeout: 30000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const card = (await s.get("core.grid")).cards.find((c) => c.pane === 0).id;
    for (const menu of ["add", "split-x", "split-y"]) {
      const name = `core.card.${menu}`;
      await s.run("core.card.menu", { card, menu });
      const state = await s.until("host.window", (w) => w.modal?.id === "picker" && w.modal.shown,
        `${name} did not show its menu`);
      transparent(state.modal);
      await background(s, false);
      const { document } = await s.until("core.modal", (modal) => modal?.id === "picker" && modal.document !== null,
        `${name} menu did not render`);
      assert.equal(document.bodyBackground, "rgba(0, 0, 0, 0)", `${name} must not shade the background`);
      // A menu receives the keyboard focus when it opens, so the native Escape reaches the menu document.
      await s.press("Escape");
      await s.until("host.window", (w) => w.modal === null, `${name} must retain Escape cancellation`);
    }
  });
}

const HELP_TITLES = {
  ko: { menu: "도움말", debug: "디버그" },
  en: { menu: "Help", debug: "Debug" },
};

for (const app of Object.values(APPS)) {
  test(`${app.name}: Help > Debug records the state, lists the logs folder and refuses a path outside it`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const titles = HELP_TITLES[(await s.get("host.menu")).language];
    s.cleanup(() => s.run("core.debug.close"));
    // Opening the view writes a still capture of each window into logs/captures; the check removes the folders it caused.
    s.cleanup(async () => {
      for (const path of (await s.get("core.debug")).captures) s.trackRecording(dirname(path));
    });
    await s.run("host.menu.select", { menu: titles.menu, title: titles.debug });
    const opened = await s.until("core.debug", (debug) => debug.open && debug.recorded !== null && debug.entries.length > 0,
      "the debug view did not record the state and list the files");
    assert.equal(opened.error, null, "opening the debug view failed a step");
    assert.match(opened.recorded, /^logs\/state-\d{8}T\d{6}Z\.json$/);
    assert.ok(opened.entries.some((file) => file.path === opened.recorded), `the list does not contain ${opened.recorded}`);
    // The list shows the newest file first, and files of the same time by path.
    const expectedOrder = opened.entries.toSorted((left, right) => right.modified - left.modified || left.path.localeCompare(right.path));
    assert.deepEqual(opened.entries.map((file) => file.path), expectedOrder.map((file) => file.path), "the list is not newest first");
    assert.ok(opened.entries.every((file) => file.path.startsWith("logs/") && file.size >= 0 && file.modified > 0),
      `a listed file is outside logs/ or has no size and time: ${JSON.stringify(opened.entries)}`);
    assert.equal((await s.get("core.screen")).modal, "debug");
    await s.presented();
    const card = await s.rect("core.debug.card");
    assert.ok(card.width > 0 && card.height > 0, "the actual named debug card was not rendered");
    // The state file holds the host, the versions, the windows and the page statuses.
    const state = JSON.parse(readFileSync(join(s.app.configDir, opened.recorded), "utf8"));
    assert.equal(typeof state.time, "string", "the state file has no time");
    assert.equal(state.host, app.name);
    assert.ok(Array.isArray(state.windows), `the state file windows are not a list: ${JSON.stringify(state.windows)}`);
    assert.ok(state.versions.core && state.versions.macos && state.windows.length > 0 && Object.keys(state.workbench).length > 0,
      `the state file is incomplete: ${Object.keys(state)}`);
    // Viewing shows the whole content of a text file; the state file does not change while the view is open.
    const stateText = readFileSync(join(s.app.configDir, opened.recorded), "utf8");
    await s.run("core.debug.view", { path: opened.recorded });
    // A text opens scrolled to its end, where its newest lines are; the state file is taller than the view.
    const viewed = await s.until("core.debug", (debug) => debug.viewing !== null && debug.scroll > 0, "the debug view did not show the end of the file");
    assert.deepEqual(viewed.viewing, { path: opened.recorded, size: Buffer.byteLength(stateText), truncated: false, kind: "text", length: stateText.length, loaded: true });
    await s.run("core.debug.list");
    await s.until("core.debug", (debug) => debug.viewing === null, "the debug view did not return to the list");
    // A diagnostic build writes a still capture of each window when the view opens; viewing it shows an image.
    const capture = opened.entries.find((file) => file.path.endsWith(".png"));
    assert.ok(capture, `no capture is listed: ${JSON.stringify(opened.entries.map((file) => file.path))}`);
    await s.run("core.debug.view", { path: capture.path });
    // The image is shown when it has loaded, and only then the card has its height (docs/spec/debug.md#status).
    const image = await s.until("core.debug", (debug) => debug.viewing?.kind === "image" && debug.viewing.loaded,
      "the debug view did not show the loaded capture");
    assert.deepEqual({ path: image.viewing.path, size: image.viewing.size, length: image.viewing.length }, { path: capture.path, size: capture.size, length: 0 });
    // The modal has the height of the card with the loaded image: the image is shown whole (at its width of the card) inside the
    // modal and not cut to the first rows of pixels. The frame of the modal follows the load of the image, so the check waits for it.
    await s.presented();
    const picture = await s.rect("core.debug.image");
    const shown = await s.rect("core.debug.card");
    const cardFrame = { x: shown.document.x + shown.x, y: shown.document.y + shown.y, width: shown.width, height: shown.height };
    const pictureFrame = { x: picture.document.x + picture.x, y: picture.document.y + picture.y, width: picture.width, height: picture.height };
    assert.ok(cardFrame.height >= picture.height / 2, "the actual named debug card did not take the image height");
    assert.ok(picture.height >= 100, `the image of the capture is only ${picture.height} points high in the debug view`);
    assert.ok(pictureFrame.x >= cardFrame.x - 1 && pictureFrame.y >= cardFrame.y - 1
      && pictureFrame.x + pictureFrame.width <= cardFrame.x + cardFrame.width + 1
      && pictureFrame.y + pictureFrame.height <= cardFrame.y + cardFrame.height + 1,
      `the image is cut by the modal: image ${JSON.stringify(pictureFrame)}, modal ${JSON.stringify(cardFrame)}`);
    await s.run("core.debug.list");
    await assert.rejects(s.run("core.debug.save", { path: "settings.json" }),
      /debug: settings.json is not a file under logs\//);
    s.expectError(/^error workbench .*debug: settings.json is not a file under logs\//);
    await s.run("core.debug.close");
    await s.until("core.debug", (debug) => !debug.open, "the debug view did not close");
    assert.equal((await s.get("core.screen")).modal, null);
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: the debug timeline shows a page of the events of the event files and applies its filter`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const titles = HELP_TITLES[(await s.get("host.menu")).language];
    s.cleanup(() => s.run("core.debug.close"));
    s.cleanup(async () => {
      for (const path of (await s.get("core.debug")).captures) s.trackRecording(dirname(path));
    });
    await s.run("host.menu.select", { menu: titles.menu, title: titles.debug });
    await s.until("core.debug", (debug) => debug.open && debug.entries.length > 0, "the debug view did not list the files");
    await s.run("core.debug.timeline");
    const shown = await s.until("core.debug", (debug) => debug.timeline !== null && debug.timeline.held > 0,
      "the timeline did not show any row of the event files");
    assert.equal(shown.timeline.channel, "other");
    assert.ok(shown.timeline.held <= 2000, `the view holds ${shown.timeline.held} rows`);
    assert.equal(shown.error, null);
    // The filters read host.test.start, which the window check stores for each test and which passes every gate (docs/spec/logging.md#policy).
    await s.run("core.debug.timeline.filter", { layer: "host", text: "host.test.start" });
    const filtered = await s.until("core.debug", (debug) => debug.timeline.layer === "host" && debug.timeline.text === "host.test.start",
      "the filter was not applied");
    assert.ok(filtered.timeline.held > 0 && filtered.timeline.held <= shown.timeline.held, `the filter shows ${filtered.timeline.held} of ${shown.timeline.held} rows`);
    await s.run("core.debug.timeline.filter", { layer: "all", text: "", event: "no.such.event" });
    const none = await s.until("core.debug", (debug) => debug.timeline.event === "no.such.event", "the event filter was not applied");
    assert.equal(none.timeline.held, 0, "the query found a row of an event that does not exist");
    assert.equal(none.error, null);
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: the debug timeline selects rows, reports the count and the warning of the save, and saves the selected rows through host.dialog`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const titles = HELP_TITLES[(await s.get("host.menu")).language];
    s.cleanup(() => s.run("core.debug.close"));
    s.cleanup(async () => {
      for (const path of (await s.get("core.debug")).captures) s.trackRecording(dirname(path));
    });
    await s.run("host.menu.select", { menu: titles.menu, title: titles.debug });
    await s.until("core.debug", (debug) => debug.open && debug.entries.length > 0, "the debug view did not list the files");
    await s.run("core.debug.timeline");
    const shown = await s.until("core.debug", (debug) => debug.timeline !== null && debug.timeline.held > 1, "the timeline did not show rows");
    assert.equal(shown.timeline.selected, 0);
    assert.match(shown.timeline.warning, /입력한 글자/);
    await s.run("core.debug.timeline.select", { row: 0, selected: true });
    await s.run("core.debug.timeline.select", { row: 1, selected: true });
    await s.run("core.debug.timeline.select", { row: 1, selected: true });
    const two = await s.until("core.debug", (debug) => debug.timeline.selected === 2, "two selected rows were not reported");
    assert.equal(two.error, null);
    await s.run("core.debug.timeline.select", { row: 0, selected: false });
    await s.until("core.debug", (debug) => debug.timeline.selected === 1, "the unselected row was not reported");
    // The save of the selected row asks host.dialog for its place, which the check answers with a path in a folder of its own,
    // and writes the line of the row; a cancel answers no file (docs/spec/debug.md, docs/spec/exposure.md#dialogs).
    const folder = realpathSync(mkdtempSync(join(tmpdir(), "soksak-timeline-save-")));
    s.cleanup(() => rmSync(folder, { recursive: true, force: true }));
    const dialogs = await holdDialogs(s);
    let saving = s.run("core.debug.timeline.save");
    let request = await dialogs.asked(saving, "core.debug.timeline.save");
    assert.equal(request.kind, "save", `the save asked for ${JSON.stringify(request)}`);
    assert.match(request.suggestedName, /^soksak-timeline-\d{8}T\d{6}Z\.txt$/, `the save proposed ${JSON.stringify(request.suggestedName)}`);
    assert.equal((await s.get("host.window")).sheet, null, "the save showed a panel");
    const target = join(folder, request.suggestedName);
    await s.request("input.dialog.answer", { id: request.id, paths: [target] });
    assert.deepEqual(await saving, { saved: target });
    const lines = readFileSync(target, "utf8");
    assert.match(lines, /^[^\n]+\n$/, `the saved file holds ${JSON.stringify(lines)}, not the line of the one selected row`);
    saving = s.run("core.debug.timeline.save");
    request = await dialogs.asked(saving, "core.debug.timeline.save");
    await dialogs.end(() => s.request("input.dialog.answer", { id: request.id, cancel: true }));
    assert.equal((await saving)?.saved ?? null, null, "a cancelled save answered a file");
    assert.equal((await s.get("core.debug")).error, null);
    await assert.rejects(s.run("core.debug.timeline.select", { row: shown.timeline.held + 1_000_000, selected: true }), /is not one of the/);
    s.expectError(/^error workbench .*timeline row \d+ is not one of the \d+ rows/);
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: the debug timeline follows the event files, stops, and catches up when it resumes`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s, { log: { call: "debug" }, reads: ["workbench.command"] });
    const titles = HELP_TITLES[(await s.get("host.menu")).language];
    s.cleanup(() => s.run("core.debug.close"));
    s.cleanup(async () => {
      for (const path of (await s.get("core.debug")).captures) s.trackRecording(dirname(path));
    });
    await s.run("host.menu.select", { menu: titles.menu, title: titles.debug });
    await s.until("core.debug", (debug) => debug.open && debug.entries.length > 0, "the debug view did not list the files");
    await s.run("core.debug.timeline");
    // Each status names the positions of the page that showed the timeline (start) and of its last read (tail). The rows that it holds
    // are then the newest page of the event files up to start and every row after start up to tail, each once; the files keep their
    // rows, so the files read after the status give the same counts (docs/spec/debug.md#timeline-following).
    const matches = (debug, phase) => {
      const { start, tail, held, appended, omitted } = debug.timeline;
      const expected = expectedTimeline(channelOtherSeqs(s.app.configDir), start, tail, PAGE_ROWS);
      assert.equal(appended, expected.appended, `${phase}: the appended rows are not the rows of the files after ${JSON.stringify(start)} up to ${JSON.stringify(tail)}`);
      assert.equal(held, expected.first + appended - omitted, `${phase}: the held rows are not the first page and the appended rows`);
    };
    const shown = await s.until("core.debug", (debug) => debug.timeline !== null && debug.timeline.held > 0, "the timeline did not show any row");
    assert.equal(shown.timeline.following, true, "a new timeline does not follow");
    matches(shown, "shown");
    // A run command stores the event workbench.command, which the host writes and announces with debug-log-changed.
    await s.run("core.debug.timeline.select", { row: 0, selected: false });
    const grown = await s.until("core.debug", (debug) => debug.timeline.held > shown.timeline.held, "the timeline did not append the rows of a command");
    assert.ok(grown.timeline.appended > shown.timeline.appended, "the appended rows are not counted");
    matches(grown, "grown");
    assert.equal(grown.error, null);
    await s.run("core.debug.timeline.follow", { on: false });
    const stopped = await s.until("core.debug", (debug) => debug.timeline.following === false, "the timeline did not stop following");
    matches(stopped, "stopped");
    await s.run("core.debug.timeline.select", { row: 0, selected: false });
    await s.run("core.debug.timeline.select", { row: 0, selected: false });
    const held = await s.get("core.debug");
    assert.equal(held.timeline.held, stopped.timeline.held, "a stopped timeline appended rows");
    assert.deepEqual(held.timeline.tail, stopped.timeline.tail, "a stopped timeline read on");
    await s.run("core.debug.timeline.follow", { on: true });
    const resumed = await s.until("core.debug", (debug) => debug.timeline.following === true && debug.timeline.held > stopped.timeline.held,
      "the timeline did not catch up with the rows written while it was stopped");
    matches(resumed, "resumed");
    assert.equal(resumed.error, null);
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: the debug view filters the timeline by event name and shows a state file as a tree`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const titles = HELP_TITLES[(await s.get("host.menu")).language];
    s.cleanup(() => s.run("core.debug.close"));
    s.cleanup(async () => {
      for (const path of (await s.get("core.debug")).captures) s.trackRecording(dirname(path));
    });
    await s.run("host.menu.select", { menu: titles.menu, title: titles.debug });
    const opened = await s.until("core.debug", (debug) => debug.open && debug.recorded !== null && debug.entries.length > 0,
      "the debug view did not record the state and list the files");
    await s.run("core.debug.timeline");
    await s.until("core.debug", (debug) => debug.timeline !== null && debug.timeline.held > 0, "the timeline did not show any row");
    // The filters read host.test.start, which the window check stores for each test and which passes every gate (docs/spec/logging.md#policy).
    await s.run("core.debug.timeline.filter", { event: "host.test.start" });
    const exact = await s.until("core.debug", (debug) => debug.timeline.event === "host.test.start", "the event filter was not applied");
    await s.run("core.debug.timeline.filter", { event: "", event_prefix: "host.test" });
    const prefix = await s.until("core.debug", (debug) => debug.timeline.event_prefix === "host.test", "the prefix filter was not applied");
    assert.ok(exact.timeline.held > 0, "the event filter shows no row");
    assert.ok(prefix.timeline.held >= exact.timeline.held, `the prefix shows ${prefix.timeline.held} rows, fewer than the exact name`);
    await s.run("core.debug.list");
    await s.run("core.debug.state", { path: opened.recorded });
    const state = await s.until("core.debug", (debug) => debug.state !== null && debug.state.lines > 0, "the state file was not shown as a tree");
    assert.equal(state.state.path, opened.recorded);
    assert.equal(state.error, null);
  });
}
