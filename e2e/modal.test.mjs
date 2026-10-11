// Checks the display order, the background, the input, the move, the resize and the removal of a modal.
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import test from "node:test";

import { APPS, open, recordingFolders } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";
import { frames, readFrame } from "@soksak/window-check/frame.mjs";

/** The address of a loopback server that serves one empty document. The check closes it when it ends. */
async function serveDocument(s) {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end("<!doctype html><title>modal</title>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  s.cleanup(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}/modal`;
}

/** Checks that the modal web view does not paint its own background. */
function transparent(modal) {
  assert.equal(modal.background.draws, false, "the native webview must not paint a background before its DOM");
  assert.equal(modal.background.alpha, 0, "the under-page background must also be transparent");
}

/** Checks that the settings modal covers the whole window above all native surfaces. */
function settingsAboveSurfaces(state) {
  const { modal } = state;
  assert.ok(modal && modal.id === "settings" && modal.shown, `settings must be shown: ${JSON.stringify(modal)}`);
  for (const surface of state.surfaces) {
    assert.ok(modal.order > surface.order, `native surface ${surface.id} covers settings: ${JSON.stringify(state.surfaces)}`);
  }
  for (const region of state.documents) {
    assert.ok(modal.order > region.order, `document region ${region.surface}/${region.document} covers settings`);
  }
  assert.equal(state.children, 0, "settings must not create a child OS window");
  transparent(modal);
  assert.deepEqual(modal.frame, { x: 0, y: 0, width: state.content.width, height: state.content.height },
    "the settings webview must cover background native content");
}

/** Checks that the background blur is applied to the main document and the documents of the visible plugin surfaces as enabled says. */
async function background(s, enabled) {
  await s.until("core.window.document", (doc) => doc.background === enabled,
    `the main document background state must be ${enabled}`);
  for (const surface of await s.surfaces()) {
    if (!surface.exposes.includes("status core.surface.document")) continue;
    await s.until("core.surface.document", (doc) => doc.readyState !== "loading"
      && doc.filter === (enabled ? "blur(3px)" : "none"),
    `${surface.surface}: background blur must match dialog visibility`, { surface: surface.surface });
  }
}

/** Opens the settings modal and waits until the document reports its render. */
async function openSettings(s) {
  await s.run("core.settings.open");
  return s.until("core.modal", (modal) => modal?.id === "settings" && modal.document !== null,
    "settings did not render");
}

/** Finds a settings modal control by name and key. */
async function control(s, name, key) {
  const { controls } = await s.until("core.settings-modal",
    (modal) => modal.controls.some((c) => c.name === name && c.key === key), `settings control ${key} did not appear`);
  return controls.find((c) => c.name === name && c.key === key);
}

async function openSidebars(s) {
  await openSettings(s);
  await control(s, "core.settings-modal.nav", "nav:sidebars");
  await s.run("core.settings-modal.nav", { section: "sidebars" });
  await control(s, "core.settings-modal.create", "sets:create");
}

/** Waits until the rectangle of the modal document equals the card rectangle of the main document. */
async function modalAt(s, card) {
  return s.until("core.modal", (modal) => ["x", "y", "width", "height"].every((k) => modal?.document?.rect[k] === card[k]),
    `the modal document did not move to ${JSON.stringify(card)}`);
}

const rectOf = ({ x, y, width, height }) => ({ x, y, width, height });

/** The mean brightness (0-255) of the samples of the frame at intervals of 8 pixels. */
function brightness(frame) {
  let sum = 0;
  let count = 0;
  for (let y = 0; y < frame.height; y += 8) {
    for (let x = 0; x < frame.width; x += 8) {
      const i = y * frame.stride + x * 4;
      sum += frame.data[i] + frame.data[i + 1] + frame.data[i + 2];
      count += 3;
    }
  }
  return sum / count;
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: the settings modal is on screen at the time presented reports after it is shown`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const { frames: directory } = await s.request("diagnostics.capture.start", {});
    s.cleanup(() => rmSync(directory, { recursive: true, force: true }));
    let displayed = 0;
    let stopped;
    try {
      await s.run("core.settings.open");
      s.cleanup(() => s.run("core.settings.close"));
      // open of core.settings-modal is a state of the main page. modal.shown of host.window reports whether the modal is on the screen.
      await s.until("host.window", (w) => w.modal?.id === "settings" && w.modal.shown, "settings was not shown");
      ({ displayed } = await s.presented());
    } finally {
      stopped = await s.request("diagnostics.capture.stop", { after: displayed ? displayed + 100 : 0 });
    }
    assert.equal(stopped.limited, false, "the recording reached its bounded buffer");
    assert.ok(stopped.longestGap <= 100, `the recording has a ${stopped.longestGap}ms gap`);
    const captured = frames(directory).map(readFrame);
    const first = captured[0];
    const after = captured.filter((frame) => frame.time >= displayed);
    assert.ok(first.time < displayed && after.length > 0,
      `the recording does not span the presented time ${displayed}: ${first.time}..${captured.at(-1).time}`);
    // The scrim of a dialog darkens the whole window. Every frame after the display time is darker than the frames before the opening.
    const before = brightness(first);
    for (const frame of after) {
      assert.ok(brightness(frame) < before * 0.9,
        `the frame at ${(frame.time - displayed).toFixed(1)}ms after the presented time shows no settings scrim: ` +
        `brightness ${brightness(frame).toFixed(1)} against ${before.toFixed(1)} before opening`);
    }
  });

  test(`${app.name}: an open modal's document receives the content the page updates`, { timeout: 30000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    await openSidebars(s);
    const { document } = await s.get("core.modal");
    assert.equal(document.filter, "none", "settings navigation must not copy the background blur into the dialog");
    assert.equal(document.bodyBackground, "rgba(0, 0, 0, 0)", "the modal body must remain transparent");
    assert.equal(document.scrimBackground, "rgba(0, 0, 0, 0.5)", "settings must draw one 50% scrim");
  });

  test(`${app.name}: a first modal answer that arrives after later changes keeps the moved position`, { timeout: 30000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    await s.request("diagnostics.modal.hold", { on: true });
    s.cleanup(() => s.request("diagnostics.modal.hold", { on: false }));
    await s.run("core.settings.open");
    await s.request("diagnostics.modal.held");
    // While the first reply is held, the content event draws the modal and the position event moves the modal.
    await s.run("core.settings-modal.nav", { section: "sidebars" });
    const shown = await s.until("core.modal", (modal) => modal?.document?.loaded === false,
      "the content event did not render the modal before its first answer");
    await s.run("core.settings-modal.move", { dx: 40, dy: 20 });
    const moved = await s.until("core.settings-modal",
      (modal) => modal.card.x === shown.document.rect.x + 40 && modal.card.y === shown.document.rect.y + 20,
      "core.settings-modal.move did not move the card by 40,20");
    await s.until("core.modal", (modal) => modal.document.rect.x === moved.card.x && modal.document.rect.y === moved.card.y,
      "the position event did not move the modal document");
    await s.request("diagnostics.modal.hold", { on: false });
    const loaded = await s.until("core.modal", (modal) => modal.document.loaded, "the modal document did not handle its first answer");
    assert.deepEqual([loaded.document.rect.x, loaded.document.rect.y], [moved.card.x, moved.card.y],
      "the first answer moved the modal document back");
    await s.run("core.settings.close");
  });

  test(`${app.name}: a card split while settings are open keeps settings above new surfaces`, { timeout: 30000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    await openSidebars(s);
    await s.presented();
    const before = await s.get("host.window");
    settingsAboveSurfaces(before);
    const old = new Set(before.surfaces.map((x) => x.id));
    await s.run("core.card.split", { card: "terminal", side: "right", plugin: "browser" });
    const after = await s.until("host.window",
      (state) => state.surfaces.some((x) => x.visible && !old.has(x.id)) && state.modal?.shown,
      "the split did not display a new native surface");
    assert.ok(after.surfaces.some((x) => !old.has(x.id)), "the split must create a new native surface");
    await s.presented();
    settingsAboveSurfaces(await s.get("host.window"));
  });

  test(`${app.name}: reloading the main document removes its settings webview`, { timeout: 30000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    await openSettings(s);
    await s.presented();
    settingsAboveSurfaces(await s.get("host.window"));
    const origin = (await s.get("core.window.document")).timeOrigin;
    await s.run("host.window.reload");
    await s.until("core.window.document", (doc) => doc.timeOrigin !== origin && doc.readyState === "complete",
      "the main document did not reload");
    await s.until("host.window", (state) => state.modal === null,
      "the old document's overlay survives after its owning DOM is gone");
    await background(s, false);
  });

  test(`${app.name}: settings blocks background input and closes only through its close button`, { timeout: 30000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const [browser] = await s.surfaces("browser");
    assert.ok(browser, "a browser surface must be visible");
    // A browser without an address hides the document region, so the check opens an address to show the document region.
    const url = await serveDocument(s);
    await s.run("browser.navigate", { url }, browser.surface);
    await s.until("browser.location", (at) => at.url === url && !at.loading, `the browser did not load ${url}`, { surface: browser.surface });
    await s.until("host.window", (w) => w.documents.some((d) => d.surface === browser.surface && d.document === "page" && d.visible),
      "the browser document region is not visible after the load");
    await openSettings(s);
    await s.presented();
    settingsAboveSurfaces(await s.get("host.window"));
    await background(s, true);
    // The right center of the browser surface is the document region of that surface.
    const frame = browser.applied;
    const point = { x: frame.x + frame.w - 4, y: frame.y + frame.h / 2 };
    const modalHit = await s.run("host.hit", point);
    assert.equal(modalHit.kind, "native", "native input must reach the settings webview");
    assert.equal(modalHit.identifier, "modal:settings", "native input must identify the settings webview");
    assert.ok(modalHit.view?.class, `the settings hit view must report its class: ${JSON.stringify(modalHit)}`);
    assert.ok(modalHit.view.frame.x <= point.x && point.x < modalHit.view.frame.x + modalHit.view.frame.width &&
      modalHit.view.frame.y <= point.y && point.y < modalHit.view.frame.y + modalHit.view.frame.height,
    `the settings hit view frame must contain ${JSON.stringify(point)}: ${JSON.stringify(modalHit.view)}`);

    // Presses inside the modal to put the keyboard focus on the modal document, then sends Escape.
    const card = await s.rect("core.settings-modal.card");
    await s.click(card.x + card.width / 2, card.y + card.height - 8);
    await s.press("Escape");
    await s.act("core.settings-modal.scrim", "dispatch", { event: { type: "pointerdown" } });
    await s.act("core.settings-modal.scrim", "dispatch", { event: { type: "keydown", key: "Escape" } });
    await s.presented();
    assert.equal((await s.get("core.settings-modal")).open, true, "background clicks and Escape must not dismiss settings");
    settingsAboveSurfaces(await s.get("host.window"));
    const { document } = await s.get("core.modal");
    assert.deepEqual([document.mode, document.htmlBackground, document.bodyBackground, document.scrimBackground],
      ["dialog", "rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0.5)"]);

    await s.act("core.settings-modal.close", "click");
    await s.until("host.window", (state) => state.modal === null, "settings did not close");
    await background(s, false);
    await s.presented();
    assert.deepEqual(await s.run("host.hit", point), { kind: "document", surface: browser.surface, document: "page" },
      "closing settings must restore native input to the browser document");
  });

  test(`${app.name}: add and split menus are transparent and have no backdrop`, { timeout: 30000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
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

  test(`${app.name}: moving settings and resizing the parent preserves its native coverage`, { timeout: 30000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    await openSettings(s);
    await s.presented();
    const before = await s.rect("core.settings-modal.card");
    await modalAt(s, rectOf(before));
    const grip = await s.rect("core.settings-modal.grip");
    const from = { x: grip.x + grip.width / 2, y: grip.y + grip.height / 2 };
    await s.pointer(from.x, from.y, "down");
    await s.pointer(from.x + 35, from.y + 15, "drag");
    await s.pointer(from.x + 70, from.y + 30, "drag");
    await s.pointer(from.x + 70, from.y + 30, "up");
    const moved = await s.until("core.modal",
      (modal) => modal.document.rect.x === before.x + 70 && modal.document.rect.y === before.y + 30,
      "dragging the settings header by 70,30 did not move the card by the same distance");
    assert.deepEqual(rectOf(await s.rect("core.settings-modal.card")), moved.document.rect);
    await s.presented();
    settingsAboveSurfaces(await s.get("host.window"));

    await s.run("host.window.resize", { width: 1000, height: 620 });
    const state = await s.until("host.window", (w) => w.content.width === 1000 && w.content.height === 620
      && w.modal?.frame?.width === 1000 && w.modal.frame.height === 620, "the window and settings did not resize");
    settingsAboveSurfaces(state);
    await s.until("core.window.document", (doc) => doc.width === 1000 && doc.height === 620,
      "the main document did not take the new size");
    await s.presented();
    const resized = rectOf(await s.rect("core.settings-modal.card"));
    assert.ok(resized.x >= 0 && resized.y >= 0 && resized.x + resized.width <= 1000 && resized.y + resized.height <= 620,
      `settings must stay inside the window: ${JSON.stringify(resized)}`);
    await modalAt(s, resized);
    await background(s, true);
  });
}

const HELP_TITLES = {
  ko: { menu: "도움말", debug: "디버그" },
  en: { menu: "Help", debug: "Debug" },
};

for (const app of Object.values(APPS)) {
  test(`${app.name}: Help > Debug records the state, lists the logs folder and refuses a path outside it`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const titles = HELP_TITLES[(await s.get("host.menu")).language];
    s.cleanup(() => s.run("core.debug.close"));
    // Opening the view writes a still capture of each window into logs/captures; the check removes the folders it caused.
    s.cleanup(() => {
      for (const folder of recordingFolders(s.app.configDir)) {
        if (!s.recordingsBefore.includes(folder)) rmSync(join(s.app.configDir, "logs", "captures", folder), { recursive: true, force: true });
      }
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
    await s.until("host.window", (w) => w.modal?.id === "debug" && w.modal.shown, "the debug view was not shown");
    // The state file holds the host, the versions, the windows and the page statuses.
    const state = JSON.parse(readFileSync(join(s.app.configDir, opened.recorded), "utf8"));
    assert.equal(state.host, app.name);
    assert.ok(state.versions.core && state.versions.macos && state.windows.length > 0 && state.page.length > 0,
      `the state file is incomplete: ${Object.keys(state)}`);
    // Viewing shows the whole content of a text file; the state file does not change while the view is open.
    const stateText = readFileSync(join(s.app.configDir, opened.recorded), "utf8");
    await s.run("core.debug.view", { path: opened.recorded });
    // A text opens scrolled to its end, where its newest lines are; the state file is taller than the view.
    const viewed = await s.until("core.debug", (debug) => debug.viewing !== null && debug.scroll > 0, "the debug view did not show the end of the file");
    assert.deepEqual(viewed.viewing, { path: opened.recorded, size: Buffer.byteLength(stateText), truncated: false, kind: "text", length: stateText.length });
    await s.run("core.debug.list");
    await s.until("core.debug", (debug) => debug.viewing === null, "the debug view did not return to the list");
    // A diagnostic build writes a still capture of each window when the view opens; viewing it shows an image.
    const capture = opened.entries.find((file) => file.path.endsWith(".png"));
    assert.ok(capture, `no capture is listed: ${JSON.stringify(opened.entries.map((file) => file.path))}`);
    await s.run("core.debug.view", { path: capture.path });
    const image = await s.until("core.debug", (debug) => debug.viewing?.kind === "image", "the debug view did not show the capture");
    assert.deepEqual({ path: image.viewing.path, size: image.viewing.size, length: image.viewing.length }, { path: capture.path, size: capture.size, length: 0 });
    // The modal has the height of the card with the loaded image: the image is shown whole (at its width of the card) inside the
    // modal and not cut to the first rows of pixels. The frame of the modal follows the load of the image, so the check waits for it.
    const picture = await s.rect("core.debug.image");
    const shown = await s.until("host.window", (host) => host.modal?.frame && host.modal.frame.height >= picture.height / 2,
      "the modal did not take the height of the card with the image");
    assert.ok(picture.height >= 100, `the image of the capture is only ${picture.height} points high in the debug view`);
    assert.ok(picture.y + picture.height <= shown.modal.frame.y + shown.modal.frame.height + 1,
      `the image is cut by the modal: image ${JSON.stringify(picture)}, modal ${JSON.stringify(shown.modal.frame)}`);
    await s.run("core.debug.list");
    await assert.rejects(s.run("core.debug.save", { path: "settings.json" }),
      /debug: settings.json is not a file under logs\//);
    s.expectError(/^error page .*debug: settings.json is not a file under logs\//);
    await s.run("core.debug.close");
    await s.until("core.debug", (debug) => !debug.open, "the debug view did not close");
    assert.equal((await s.get("core.screen")).modal, null);
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: the debug timeline shows a page of the events of the event files and applies its filter`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const titles = HELP_TITLES[(await s.get("host.menu")).language];
    s.cleanup(() => s.run("core.debug.close"));
    s.cleanup(() => {
      for (const folder of recordingFolders(s.app.configDir)) {
        if (!s.recordingsBefore.includes(folder)) rmSync(join(s.app.configDir, "logs", "captures", folder), { recursive: true, force: true });
      }
    });
    await s.run("host.menu.select", { menu: titles.menu, title: titles.debug });
    await s.until("core.debug", (debug) => debug.open && debug.entries.length > 0, "the debug view did not list the files");
    await s.run("core.debug.timeline");
    const shown = await s.until("core.debug", (debug) => debug.timeline !== null && debug.timeline.held > 0,
      "the timeline did not show any row of the event files");
    assert.equal(shown.timeline.channel, "other");
    assert.ok(shown.timeline.held <= 2000, `the view holds ${shown.timeline.held} rows`);
    assert.equal(shown.error, null);
    await s.run("core.debug.timeline.filter", { layer: "host", text: "host.app.event" });
    const filtered = await s.until("core.debug", (debug) => debug.timeline.layer === "host" && debug.timeline.text === "host.app.event",
      "the filter was not applied");
    assert.ok(filtered.timeline.held > 0 && filtered.timeline.held <= shown.timeline.held, `the filter shows ${filtered.timeline.held} of ${shown.timeline.held} rows`);
    await s.run("core.debug.timeline.filter", { layer: "all", text: "", event: "no.such.event" });
    const none = await s.until("core.debug", (debug) => debug.timeline.event === "no.such.event", "the event filter was not applied");
    assert.equal(none.timeline.held, 0, "the query found a row of an event that does not exist");
    assert.equal(none.error, null);
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: the debug timeline selects rows and reports the count and the warning of the save`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const titles = HELP_TITLES[(await s.get("host.menu")).language];
    s.cleanup(() => s.run("core.debug.close"));
    s.cleanup(() => {
      for (const folder of recordingFolders(s.app.configDir)) {
        if (!s.recordingsBefore.includes(folder)) rmSync(join(s.app.configDir, "logs", "captures", folder), { recursive: true, force: true });
      }
    });
    await s.run("host.menu.select", { menu: titles.menu, title: titles.debug });
    await s.until("core.debug", (debug) => debug.open && debug.entries.length > 0, "the debug view did not list the files");
    await s.run("core.debug.timeline");
    const shown = await s.until("core.debug", (debug) => debug.timeline !== null && debug.timeline.held > 1, "the timeline did not show rows");
    assert.equal(shown.timeline.selected, 0);
    assert.match(shown.timeline.warning, /입력한 글자/);
    // The save panel needs a person, so the check does not run core.debug.timeline.save.
    await s.run("core.debug.timeline.select", { row: 0, selected: true });
    await s.run("core.debug.timeline.select", { row: 1, selected: true });
    await s.run("core.debug.timeline.select", { row: 1, selected: true });
    const two = await s.until("core.debug", (debug) => debug.timeline.selected === 2, "two selected rows were not reported");
    assert.equal(two.error, null);
    await s.run("core.debug.timeline.select", { row: 0, selected: false });
    await s.until("core.debug", (debug) => debug.timeline.selected === 1, "the unselected row was not reported");
    await assert.rejects(s.run("core.debug.timeline.select", { row: shown.timeline.held + 1_000_000, selected: true }), /is not one of the/);
    s.expectError(/^error page .*timeline row \d+ is not one of the \d+ rows/);
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: the debug timeline follows the event files, stops, and catches up when it resumes`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const titles = HELP_TITLES[(await s.get("host.menu")).language];
    s.cleanup(() => s.run("core.debug.close"));
    s.cleanup(() => {
      for (const folder of recordingFolders(s.app.configDir)) {
        if (!s.recordingsBefore.includes(folder)) rmSync(join(s.app.configDir, "logs", "captures", folder), { recursive: true, force: true });
      }
    });
    await s.run("host.menu.select", { menu: titles.menu, title: titles.debug });
    await s.until("core.debug", (debug) => debug.open && debug.entries.length > 0, "the debug view did not list the files");
    await s.run("core.debug.timeline");
    const shown = await s.until("core.debug", (debug) => debug.timeline !== null && debug.timeline.held > 0, "the timeline did not show any row");
    assert.equal(shown.timeline.following, true, "a new timeline does not follow");
    assert.equal(shown.timeline.appended, 0);
    // A run command stores the event page.command, which the host writes and announces with debug-log-changed.
    await s.run("core.debug.timeline.select", { row: 0, selected: false });
    const grown = await s.until("core.debug", (debug) => debug.timeline.held > shown.timeline.held, "the timeline did not append the rows of a command");
    assert.ok(grown.timeline.appended > 0, "the appended rows are not counted");
    assert.equal(grown.error, null);
    await s.run("core.debug.timeline.follow", { on: false });
    const stopped = await s.until("core.debug", (debug) => debug.timeline.following === false, "the timeline did not stop following");
    await s.run("core.debug.timeline.select", { row: 0, selected: false });
    await s.run("core.debug.timeline.select", { row: 0, selected: false });
    const held = await s.get("core.debug");
    assert.equal(held.timeline.held, stopped.timeline.held, "a stopped timeline appended rows");
    await s.run("core.debug.timeline.follow", { on: true });
    const resumed = await s.until("core.debug", (debug) => debug.timeline.following === true && debug.timeline.held > stopped.timeline.held,
      "the timeline did not catch up with the rows written while it was stopped");
    assert.equal(resumed.error, null);
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: the debug view filters the timeline by event name and shows a state file as a tree`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const titles = HELP_TITLES[(await s.get("host.menu")).language];
    s.cleanup(() => s.run("core.debug.close"));
    s.cleanup(() => {
      for (const folder of recordingFolders(s.app.configDir)) {
        if (!s.recordingsBefore.includes(folder)) rmSync(join(s.app.configDir, "logs", "captures", folder), { recursive: true, force: true });
      }
    });
    await s.run("host.menu.select", { menu: titles.menu, title: titles.debug });
    const opened = await s.until("core.debug", (debug) => debug.open && debug.recorded !== null && debug.entries.length > 0,
      "the debug view did not record the state and list the files");
    await s.run("core.debug.timeline");
    await s.until("core.debug", (debug) => debug.timeline !== null && debug.timeline.held > 0, "the timeline did not show any row");
    await s.run("core.debug.timeline.filter", { event: "host.app.event" });
    const exact = await s.until("core.debug", (debug) => debug.timeline.event === "host.app.event", "the event filter was not applied");
    await s.run("core.debug.timeline.filter", { event: "", event_prefix: "host.app" });
    const prefix = await s.until("core.debug", (debug) => debug.timeline.event_prefix === "host.app", "the prefix filter was not applied");
    assert.ok(exact.timeline.held > 0, "the event filter shows no row");
    assert.ok(prefix.timeline.held >= exact.timeline.held, `the prefix shows ${prefix.timeline.held} rows, fewer than the exact name`);
    await s.run("core.debug.list");
    await s.run("core.debug.state", { path: opened.recorded });
    const state = await s.until("core.debug", (debug) => debug.state !== null && debug.state.lines > 0, "the state file was not shown as a tree");
    assert.equal(state.state.path, opened.recorded);
    assert.equal(state.error, null);
  });
}
