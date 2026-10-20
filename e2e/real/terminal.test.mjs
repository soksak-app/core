// Real-input-tier terminal check: selection, copy, paste and wheel of the terminal go through the path of a person's mouse and keyboard (window server, key window, menu key equivalents).
// Run it only with `pnpm -F @soksak/e2e verify:real` in a run that the user approved.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "../fixture.mjs";
import { frames, pixel, readFrame } from "@soksak/window-check/frame.mjs";
import { cellBackgrounds, ensureTerminals, isColor, readScreenUntil, selectionBackground } from "../terminal-screen.mjs";
import { pasteboardText, writePasteboard } from "@soksak/window-check/pasteboard.mjs";
import { LAUNCH, PROMPT } from "../fixture-tui.mjs";
import { activateFinder, appPid, bringFront, click, closeFinderWindow, dragPath, finderItemCenter, frontWindowAt, key, KEYS,
  dragPasteboard, openFinderWindow, post, postWithCursorSamples, requireTrusted, screenCenter, systemCursor } from "./hid.mjs";

// Center screen coordinate of one terminal cell.
function cellPoint(origin, session, column, row) {
  return { x: origin.x + (column + 0.5) * session.cellWidth, y: origin.y + (row + 0.5) * session.cellHeight };
}

// Reads the pixel at the center of one cell in the last displayed screen.
async function cellPixel(s, surface, session, column, row) {
  await s.request("diagnostics.capture.start", {});
  const displayed = await s.presented();
  const { frames: directory } = await s.request("diagnostics.capture.stop", { after: displayed.displayed });
  try {
    const files = frames(directory);
    assert.ok(files.length > 0, "the capture produced no frames");
    const frame = readFrame(files.at(-1));
    const region = (await s.get("host.window")).regions.find((item) => item.surface === surface && item.name === "view");
    return pixel(frame, Math.round((region.frame.x + (column + 0.5) * session.cellWidth) * frame.scale),
      Math.round((region.frame.y + (row + 0.5) * session.cellHeight) * frame.scale));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

// Finds the cells in the last displayed screen whose screen state is blank (except the cursor cell) and that hold a drawn pixel, and the margin to the right of the last column.
async function blankCellsWithPixels(s, surface) {
  const lines = await readScreenUntil(s, surface, () => true, "the screen did not read");
  const session = await s.get("terminal.session", surface);
  const cursor = await s.get("terminal.cursor", surface);
  await s.request("diagnostics.capture.start", {});
  const displayed = await s.presented();
  const { frames: directory } = await s.request("diagnostics.capture.stop", { after: displayed.displayed });
  try {
    const files = frames(directory);
    assert.ok(files.length > 0, "the capture produced no frames");
    const frame = readFrame(files.at(-1));
    const region = (await s.get("host.window")).regions.find((item) => item.surface === surface && item.name === "view");
    const x = (column) => Math.round((region.frame.x + column * session.cellWidth) * frame.scale);
    const y = (row) => Math.round((region.frame.y + row * session.cellHeight) * frame.scale);
    const background = pixel(frame, x(session.cols - 1) + 2, y(session.rows - 1) + 2);
    const inked = (x0, y0, x1, y1) => {
      let count = 0;
      for (let py = y0; py < y1; py++) for (let px = x0; px < x1; px++) {
        if (pixel(frame, px, py).some((channel, index) => Math.abs(channel - background[index]) > 40)) count++;
      }
      return count;
    };
    const cells = [];
    for (let row = 0; row < session.rows; row++) {
      const text = lines[row] ?? "";
      for (let column = 0; column < session.cols; column++) {
        if ((text[column] ?? " ") !== " " || (row === cursor.row && column === cursor.col)) continue;
        const count = inked(x(column), y(row), x(column + 1), y(row + 1));
        if (count > 0) cells.push({ row, column, count });
      }
      const margin = inked(x(session.cols), y(row), Math.round((region.frame.x + region.frame.width) * frame.scale), y(row + 1));
      if (margin > 0) cells.push({ row, column: "margin", count: margin });
    }
    return { cells, lines: lines.filter(Boolean) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

// Writes one line to the terminal and returns the row of that line and the screen origin. The check brings the window to the front and then sends real input.
async function prepare(t, app, line, { fullscreen = false } = {}) {
  requireTrusted();
  const s = await open(t, app);
  await fresh(s);
  const [terminal] = await ensureTerminals(s, 1);
  const surface = terminal.surface;
  if (fullscreen) {
    // A check that needs a screen wider than the terminal of the fixed layout makes the terminal card full screen and restores it when the check ends.
    const card = (await s.get("core.grid")).cards.find((item) => item.tabs.some((tab) => tab.id === surface)).id;
    const before = (await s.get("terminal.session", surface)).cols;
    await s.run("core.card.fullscreen", { card });
    s.cleanup(() => s.run("core.card.fullscreen", { card }));
    await s.until("terminal.session", (value) => value.cols > before, "the fullscreen terminal did not widen", { surface });
  }
  await s.run("terminal.input", { bytes: `clear; printf '${line}\\n'\r` }, surface);
  const lines = await readScreenUntil(s, surface, (screen) => screen.includes(line), `${line} did not render`);
  const session = await s.get("terminal.session", surface);
  const view = await s.rect("terminal.view", undefined, surface);
  const center = await bringFront(s, app, view);
  const origin = { x: center.x - view.width / 2, y: center.y - view.height / 2 };
  return { s, surface, session, origin, row: lines.indexOf(line) };
}

/** Limit (ms) from Command+V until the pasted text appears on the screen. */
const PASTE_LIMIT = 500;

const same = (a, b) => a.every((value, index) => Math.abs(value - b[index]) <= 8);

for (const app of Object.values(APPS)) {
  test(`${app.name}: a real click clears a terminal selection`, { timeout: 90000 }, async (t) => {
    const { s, surface, session, origin, row } = await prepare(t, app, "SELECTME");
    const blank = 10;
    const background = await cellPixel(s, surface, session, blank, row);

    const before = (await s.get("terminal.session", surface)).selectionReleases;
    const start = cellPoint(origin, session, 0, row);
    dragPath({ x: start.x - 0.3 * session.cellWidth, y: start.y }, cellPoint(origin, session, blank + 2, row));
    await s.until("terminal.session", (value) => value.selectionReleases === before + 1,
      "the sidecar did not answer the release of a real drag", { surface });
    const selected = await cellPixel(s, surface, session, blank, row);
    assert.ok(!same(selected, background), `the drag did not render a selection: ${selected} against ${background}`);

    click(cellPoint(origin, session, 30, row + 3).x, cellPoint(origin, session, 30, row + 3).y);
    await s.until("terminal.session", (value) => value.selectionReleases === before + 2,
      "the sidecar did not answer the release of a real click after a selection", { surface });
    const cleared = await cellPixel(s, surface, session, blank, row);
    assert.ok(same(cleared, background), `a click left the selection rendered: ${cleared} against ${background}`);
    assert.equal(pasteboardText(), "SELECTME", "the click changed the copied selection");
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a real click gives native focus to the clicked terminal and its card`, { timeout: 90000 }, async (t) => {
    requireTrusted();
    const s = await open(t, app);
    await fresh(s);
    const terminals = await ensureTerminals(s, 3);
    await s.presented();
    await bringFront(s, app, await s.rect("terminal.view", undefined, terminals[0].surface));
    for (const terminal of [...terminals, terminals[0]]) {
      const point = await screenCenter(s, await s.rect("terminal.view", undefined, terminal.surface));
      click(point.x, point.y);
      await s.until("core.grid", (grid) => grid.cards.some((card) => card.focused &&
        card.tabs.some((tab) => tab.id === terminal.surface)), `the card of ${terminal.surface} did not take focus`);
      const host = await s.until("host.window", (window) => window.responder?.surface === terminal.surface,
        `${terminal.surface} did not become the native first responder after a real click`);
      assert.deepEqual(host.regions.filter((region) => region.focused).map((region) => region.surface), [terminal.surface]);
    }
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a real Command+V pastes the clipboard text without another key`, { timeout: 90000 }, async (t) => {
    const { s, surface, origin, session, row } = await prepare(t, app, "PASTEHERE");
    const point = cellPoint(origin, session, 0, row + 1);
    click(point.x, point.y);
    await s.until("host.window", (window) => window.responder?.surface === surface, "the terminal did not take native focus");
    const marker = `PASTED${process.pid}`;
    writePasteboard([{ "public.utf8-plain-text": Buffer.from(marker).toString("base64") }]);
    const started = performance.now();
    key(KEYS.v, ["command"]);
    // key starts osascript, sends the event and returns. The time at which the key was sent lies between started and posted.
    const posted = performance.now();
    // The pasted text must appear on the screen without another key. Text that remains in the input-method document does not appear until the next key.
    await readScreenUntil(s, surface, (lines) => lines.some((line) => line.includes(marker)),
      "Command+V did not paste the clipboard text without another key");
    const elapsed = performance.now() - started;
    t.diagnostic(`${app.name}: Command+V text shown ${elapsed.toFixed(0)} ms after the post started and ` +
      `${(performance.now() - posted).toFixed(0)} ms after it returned`);
    // Text that stayed in the input-method document did not appear for several seconds until another trigger committed it (V5-42).
    assert.ok(elapsed <= PASTE_LIMIT, `Command+V text appeared ${elapsed.toFixed(0)} ms after the key (limit ${PASTE_LIMIT} ms)`);
    assert.equal((await s.get("terminal.session", surface)).error, undefined);
  });
}

// A 1x1 PNG. Pasting it stores it as an owned file in the clipboard folder of the configuration directory.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64");

for (const app of Object.values(APPS)) {
  test(`${app.name}: a real Command+V pastes a clipboard image as a quoted owned path`, { timeout: 90000 }, async (t) => {
    const { s, surface, origin, session, row } = await prepare(t, app, "IMAGEHERE");
    const point = cellPoint(origin, session, 0, row + 1);
    click(point.x, point.y);
    await s.until("host.window", (window) => window.responder?.surface === surface, "the terminal did not take native focus");
    writePasteboard([{ "public.png": PNG.toString("base64") }]);
    key(KEYS.v, ["command"]);
    // A long path wraps at the terminal width, so the lines are joined when read.
    const quoted = /'([^']*\/pasted-image-[^'/]*\.png)'/;
    const lines = await readScreenUntil(s, surface, (screen) => quoted.test(screen.join("")),
      "Command+V did not paste the clipboard image as a quoted path");
    const saved = quoted.exec(lines.join(""))[1];
    s.cleanup(() => rmSync(saved, { force: true }));
    assert.equal(dirname(saved), join(realpathSync(app.configDir), "clipboard"), `the image is not owned by the configuration: ${saved}`);
    assert.deepEqual(readFileSync(saved), PNG, "the saved image differs from the clipboard PNG");
    assert.equal((await s.get("terminal.session", surface)).error, undefined);
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a real drag copies the selection and Command+C copies it again`, { timeout: 90000 }, async (t) => {
    const { s, surface, session, origin, row } = await prepare(t, app, "COPYME");
    writePasteboard([{ "public.utf8-plain-text": Buffer.from("BEFORE-COPY").toString("base64") }]);
    const before = (await s.get("terminal.session", surface)).selectionReleases;
    // A selection covers a cell only when the pointer passes the middle of that cell, so the press happens near the left edge of the first cell.
    const start = cellPoint(origin, session, 0, row);
    dragPath({ ...start, x: start.x - 0.3 * session.cellWidth }, cellPoint(origin, session, 5, row));
    await s.until("terminal.session", (value) => value.selectionReleases === before + 1,
      "the sidecar did not answer the release of a real drag", { surface });
    await s.until("terminal.session", () => pasteboardText() === "COPYME",
      `the drag selection did not reach the general pasteboard (it holds ${JSON.stringify(pasteboardText())})`, { surface });
    // After another application changes the clipboard, Command+C copies the selection again.
    writePasteboard([{ "public.utf8-plain-text": Buffer.from("CHANGED").toString("base64") }]);
    key(KEYS.c, ["command"]);
    await s.until("terminal.session", () => pasteboardText() === "COPYME",
      `Command+C did not copy the selection (the pasteboard holds ${JSON.stringify(pasteboardText())})`, { surface });
    assert.equal((await s.get("terminal.session", surface)).error, undefined);
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a real wheel scrolls the scrollback and a key returns to the newest output`, { timeout: 90000 }, async (t) => {
    const { s, surface, session, origin } = await prepare(t, app, "WHEELSTART");
    await s.run("terminal.input", { bytes: "i=0; while [ $i -lt 60 ]; do printf 'ROW%02d\\n' $i; i=$((i+1)); done\r" }, surface);
    const filled = await readScreenUntil(s, surface, (lines) => lines.some((line) => line === "ROW59"), "the rows did not render");
    const top = filled.find((line) => line.trim());
    const point = cellPoint(origin, session, 3, 3);
    post([{ type: "move", x: point.x, y: point.y }, { type: "wheel", x: point.x, y: point.y, lines: 5 }]);
    // The event monitor of the app converts a line wheel into a view wheel, so the number of moved lines is only reported.
    const scrolled = await s.until("terminal.session", (value) => value.scrollback?.offset > 0,
      "a real wheel did not move the viewport toward older output", { surface });
    t.diagnostic(`${app.name}: a five-line wheel moved the viewport ${scrolled.scrollback.offset} of ${scrolled.scrollback.history} lines`);
    const lines = await readScreenUntil(s, surface, (screen) => !screen.includes("ROW59"), "the viewport still shows the newest row");
    assert.notEqual(lines.find((line) => line.trim()), top, "the top row did not change");
    // Input returns to the newest output. After focus is given, the Escape key, which is unrelated to the input method, is sent.
    click(point.x, point.y);
    await s.until("host.window", (window) => window.responder?.surface === surface, "the terminal did not take native focus");
    key(KEYS.escape);
    await s.until("terminal.session", (value) => value.scrollback?.offset === 0,
      "a key did not return the viewport to the newest output", { surface });
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a real wheel on the alternate screen scrolls the program instead of the scrollback`, { timeout: 90000 }, async (t) => {
    const { s, surface, session, origin } = await prepare(t, app, "LESSSTART");
    s.cleanup(() => s.run("terminal.input", { bytes: "q" }, surface));
    await s.run("terminal.input", { bytes: "i=0; while [ $i -lt 200 ]; do printf 'ITEM%03d\\n' $i; i=$((i+1)); done | less\r" }, surface);
    await readScreenUntil(s, surface, (lines) => lines[0] === "ITEM000", "less did not show the first item");
    const point = cellPoint(origin, session, 3, 3);
    // Scrolling toward the newest output makes less scroll down.
    post([{ type: "move", x: point.x, y: point.y }, { type: "wheel", x: point.x, y: point.y, lines: -3 }]);
    const lines = await readScreenUntil(s, surface, (screen) => screen[0] !== "ITEM000" && /^ITEM\d{3}$/.test(screen[0]),
      "a wheel on the alternate screen did not scroll less");
    t.diagnostic(`${app.name}: less shows ${lines[0]} at the top after the wheel`);
    assert.equal((await s.get("terminal.session", surface)).scrollback.offset, 0, "the wheel moved the scrollback viewport");
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a real drag that leaves the view selects to the nearest cell`, { timeout: 90000 }, async (t) => {
    const { s, surface, session, origin, row } = await prepare(t, app, "LEFTEDGE");
    writePasteboard([{ "public.utf8-plain-text": Buffer.from("BEFORE").toString("base64") }]);
    const before = (await s.get("terminal.session", surface)).selectionReleases;
    // A drag that selects the start of a line easily moves the pointer out of the left side of the view.
    const start = cellPoint(origin, session, 5, row);
    dragPath(start, { x: origin.x - 20, y: start.y });
    await s.until("terminal.session", (value) => value.selectionReleases === before + 1,
      "the sidecar did not answer the release of a drag that left the view", { surface });
    await s.until("terminal.session", () => pasteboardText() === "LEFTED",
      `the drag did not select to the first cell (the pasteboard holds ${JSON.stringify(pasteboardText())})`, { surface });
    assert.equal((await s.get("terminal.session", surface)).error, undefined);
  });
}

// Characters drawn as a selection on the screen. The selected cell is drawn with the selection background of the theme and a screen cell carries no color, so the background pixel of the cell is read.
async function selectedCharacters(s, surface, row) {
  await s.run("terminal.screen.read", {}, surface);
  const lines = await s.get("terminal.screen", surface);
  const { cols } = await s.get("terminal.session", surface);
  const selection = await selectionBackground(s);
  const shown = await cellBackgrounds(s, surface, Array.from({ length: cols }, (_, col) => ({ col, row })));
  return Array.from({ length: cols }, (_, col) => col)
    .filter((col) => isColor(shown[col], selection))
    .map((col) => lines[row][col]?.ch ?? " ").join("").trimEnd();
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a real drag, Command+C, and Command+V paste exactly the characters shown as selected`, { timeout: 180000 }, async (t) => {
    const line = "0123456789ABCDEFGHIJ";
    const { s, surface, session, origin, row } = await prepare(t, app, line);
    const view = await s.rect("terminal.view", undefined, surface);
    const cases = [
      ["forward", cellPoint(origin, session, 2, row), cellPoint(origin, session, 8, row)],
      ["backward", cellPoint(origin, session, 12, row), cellPoint(origin, session, 4, row)],
      ["past the left edge", cellPoint(origin, session, 6, row), { x: origin.x - 20, y: cellPoint(origin, session, 0, row).y }],
      ["past the right edge", cellPoint(origin, session, 15, row), { x: origin.x + view.width + 20, y: cellPoint(origin, session, 0, row).y }],
    ];
    for (const [name, from, to] of cases) {
      const before = (await s.get("terminal.session", surface)).selectionReleases;
      dragPath(from, to);
      await s.until("terminal.session", (value) => value.selectionReleases === before + 1,
        `the sidecar did not answer the ${name} drag`, { surface });
      await s.until("host.window", (window) => window.responder?.surface === surface, "the terminal did not take native focus");
      const shown = await selectedCharacters(s, surface, row);
      assert.ok(shown.length > 0, `the ${name} drag showed no selected characters`);
      key(KEYS.c, ["command"]);
      key(KEYS.v, ["command"]);
      const pasted = await readScreenUntil(s, surface, (lines) => lines.some((text) => text.startsWith("sh-3.2$ ") && text.length > 8),
        `the ${name} selection was not pasted`);
      const typed = pasted.find((text) => text.startsWith("sh-3.2$ ") && text.length > 8).slice(8);
      t.diagnostic(`${app.name} ${name}: shown ${JSON.stringify(shown)} pasted ${JSON.stringify(typed)}`);
      assert.equal(typed, shown, `the ${name} drag pasted other characters than it showed as selected`);
      // Clears the pasted input line (Control+U).
      key(32, ["control"]);
      await readScreenUntil(s, surface, (lines) => !lines.some((text) => text.startsWith("sh-3.2$ ") && text.length > 8),
        "the pasted input was not cleared");
    }
  });
}

// Displayed pixel at one screen coordinate.
async function screenPixel(s, point) {
  await s.request("diagnostics.capture.start", {});
  const displayed = await s.presented();
  const { frames: directory } = await s.request("diagnostics.capture.stop", { after: displayed.displayed });
  try {
    const files = frames(directory);
    assert.ok(files.length > 0, "the capture produced no frames");
    const frame = readFrame(files.at(-1));
    const { frame: window } = await s.get("host.window");
    return pixel(frame, Math.round((point.x - window.x) * frame.scale), Math.round((point.y - window.y) * frame.scale));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a terminal with history shows a scrollbar whose thumb moves the viewport when dragged`, { timeout: 120000 }, async (t) => {
    const { s, surface, session, origin } = await prepare(t, app, "BARSTART");
    await s.run("terminal.input", { bytes: "i=0; while [ $i -lt 80 ]; do printf 'ROW%02d\\n' $i; i=$((i+1)); done\r" }, surface);
    await readScreenUntil(s, surface, (lines) => lines.some((line) => line === "ROW79"), "the rows did not render");
    const newest = await s.until("terminal.session", (value) => value.scrollback?.history > 0 && value.scrollback.offset === 0,
      "the output did not exceed the screen", { surface });

    // With a history, the scrollbar is visible even before scrolling and the handle is at the very bottom of the track.
    const track = await s.rect("terminal.scrollbar", undefined, surface);
    const bottomThumb = await s.rect("terminal.scrollbar.thumb", undefined, surface);
    assert.ok(track.width > 0 && bottomThumb.height >= 16, `the scrollbar is not shown with history: ${JSON.stringify({ track, bottomThumb })}`);
    assert.ok(Math.abs(bottomThumb.y + bottomThumb.height - (track.y + track.height)) <= 1,
      `the thumb is not at the bottom at the newest output: ${JSON.stringify({ track, bottomThumb })}`);

    // Dragging the handle to the very top shows the oldest history.
    const trackTop = (await screenCenter(s, track)).y - track.height / 2;
    const start = await screenCenter(s, bottomThumb);
    dragPath(start, { x: start.x, y: trackTop - 30 });
    const top = await s.until("terminal.session", (value) => value.scrollback.offset === value.scrollback.history,
      "dragging the thumb to the top did not show the oldest history", { surface });
    t.diagnostic(`${app.name}: history ${newest.scrollback.history}, top offset ${top.scrollback.offset}`);
    const topThumb = await screenCenter(s, await s.rect("terminal.scrollbar.thumb", undefined, surface));
    const withThumb = await screenPixel(s, topThumb);

    // Dragging to the very bottom returns to the newest output. The pixel at the upper position must differ after the handle has left.
    dragPath(topThumb, { x: topThumb.x, y: trackTop + track.height + 30 });
    await s.until("terminal.session", (value) => value.scrollback.offset === 0,
      "dragging the thumb to the bottom did not return to the newest output", { surface });
    const withoutThumb = await screenPixel(s, topThumb);
    assert.ok(!same(withThumb, withoutThumb),
      `the thumb was not drawn: the same point shows ${withThumb} with the thumb and ${withoutThumb} without it`);
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: text stays drawn in every frame while a real wheel scrolls`, { timeout: 120000 }, async (t) => {
    const { s, surface, session, origin } = await prepare(t, app, "FLICKER");
    await s.run("terminal.input", { bytes: "i=0; while [ $i -lt 200 ]; do printf 'LINE%03d text text text text\\n' $i; i=$((i+1)); done\r" }, surface);
    await readScreenUntil(s, surface, (lines) => lines.some((line) => line.startsWith("LINE199")), "the lines did not render");
    const region = (await s.get("host.window")).regions.find((item) => item.surface === surface && item.name === "view");
    const point = cellPoint(origin, session, 3, 3);
    await s.request("diagnostics.capture.start", {});
    const steps = [{ type: "move", x: point.x, y: point.y }];
    for (let i = 0; i < 8; i++) steps.push({ type: "wheel", x: point.x, y: point.y, lines: 2, wait: 40 });
    for (let i = 0; i < 8; i++) steps.push({ type: "wheel", x: point.x, y: point.y, lines: -2, wait: 40 });
    // Sends many small pixel movements at short intervals like a trackpad.
    for (let i = 0; i < 60; i++) steps.push({ type: "wheel", unit: "pixel", x: point.x, y: point.y, lines: i < 30 ? 5 : -5, wait: 8 });
    post(steps);
    const displayed = await s.presented();
    const { frames: directory } = await s.request("diagnostics.capture.stop", { after: displayed.displayed });
    try {
      const files = frames(directory);
      assert.ok(files.length > 10, `the recording has only ${files.length} frames`);
      // Glyph pixels: counts the bright pixels inside the terminal area (without the scrollbar column) at every line interval.
      // To interpret frames in which the glyphs disappeared, it records the colors at the center of the area and at the card header above the area together.
      const samples = [];
      const counts = files.map((file) => {
        const frame = readFrame(file);
        samples.push({
          center: pixel(frame, Math.round((region.frame.x + region.frame.width / 2) * frame.scale), Math.round((region.frame.y + region.frame.height / 2) * frame.scale)).join(","),
          above: pixel(frame, Math.round((region.frame.x + 20) * frame.scale), Math.round((region.frame.y - 12) * frame.scale)).join(","),
        });
        let count = 0;
        const left = Math.round(region.frame.x * frame.scale), top = Math.round(region.frame.y * frame.scale);
        const right = Math.round((region.frame.x + region.frame.width - 12) * frame.scale);
        const bottom = Math.round((region.frame.y + region.frame.height) * frame.scale);
        for (let y = top; y < bottom; y += 2) for (let x = left; x < right; x += 2) {
          if (pixel(frame, x, y).every((value) => value > 150)) count++;
        }
        return count;
      });
      t.diagnostic(`${app.name}: text pixels per frame min ${Math.min(...counts)} max ${Math.max(...counts)} over ${counts.length} frames`);
      const first = counts[0];
      const dropped = counts.map((count, index) => [index, count, samples[index], samples[index - 1] ?? null])
        .filter(([, count]) => count < first / 2);
      assert.deepEqual(dropped, [], `frames lost most of their text while scrolling (first frame ${first} text pixels): ${JSON.stringify(dropped)}`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: scrollbar settings change the drawn track width, thumb color, and shape`, { timeout: 120000 }, async (t) => {
    const { s, surface } = await prepare(t, app, "BARSETTINGS");
    await s.run("terminal.input", { bytes: "i=0; while [ $i -lt 60 ]; do printf 'ROW%02d\\n' $i; i=$((i+1)); done\r" }, surface);
    await readScreenUntil(s, surface, (lines) => lines.some((line) => line === "ROW59"), "the rows did not render");
    await s.until("terminal.session", (value) => value.scrollback?.history > 0, "the output did not exceed the screen", { surface });
    const set = (key, value) => s.run("core.settings.change", { key: `terminal.scrollbar.${key}`, value, scope: "common" });
    await set("width", 20);
    await set("thumb", "#ff0000");
    await set("track", "#0000ff");
    await set("shape", "square");
    const track = await s.rect("terminal.scrollbar", undefined, surface);
    assert.equal(track.width, 20, `the track width setting was not applied: ${JSON.stringify(track)}`);
    const thumbRect = await s.rect("terminal.scrollbar.thumb", undefined, surface);
    const center = await screenCenter(s, thumbRect);
    const corner = { x: center.x - thumbRect.width / 2 + 1, y: center.y - thumbRect.height / 2 + 1 };
    const near = (actual, expected) => actual.every((value, index) => Math.abs(value - expected[index]) <= 24);
    const drawn = await screenPixel(s, center);
    assert.ok(near(drawn, [255, 0, 0]), `the thumb color setting was not drawn: ${drawn}`);
    const squareCorner = await screenPixel(s, corner);
    assert.ok(near(squareCorner, [255, 0, 0]), `a square thumb does not fill its corner: ${squareCorner}`);
    await set("shape", "rounded");
    const roundCorner = await screenPixel(s, corner);
    assert.ok(near(roundCorner, [0, 0, 255]), `a rounded thumb corner does not show the track color: ${roundCorner}`);
    const trackPixel = await screenPixel(s, { x: center.x, y: center.y - thumbRect.height / 2 - 4 });
    t.diagnostic(`${app.name}: thumb ${drawn}, square corner ${squareCorner}, rounded corner ${roundCorner}, track ${trackPixel}`);
  });
}

// The check that opens a link opens an example.com tab in the default browser of the user. It runs only in a run that the user approved.
const LINK = "https://example.com/soksak-link-check";

for (const app of Object.values(APPS)) {
  test(`${app.name}: a real Command-click on an OSC 8 link opens it through the host and a plain click does not`, { timeout: 90000 }, async (t) => {
    const { s, surface, session, origin, row } = await prepare(t, app, "LINKROW");
    await s.run("terminal.input", { bytes: `clear; printf '\\033]8;;${LINK}\\007LINKTEXT\\033]8;;\\007\\n'\r` }, surface);
    const lines = await readScreenUntil(s, surface, (screen) => screen.includes("LINKTEXT"), "the link did not render");
    const linkRow = lines.indexOf("LINKTEXT");
    const point = cellPoint(origin, session, 3, linkRow);
    const log = await s.transcript();
    s.cleanup(() => log.stop());
    // A move without a press reports a hand-shaped pointer and the link under the pointer.
    const cells = (await s.get("terminal.screen", surface))[linkRow].slice(0, 8).map((cell) => cell.link ?? null);
    assert.deepEqual(cells, Array(8).fill(LINK), "the screen does not carry the link on its cells");
    // The pointer enters the link cell from a cell outside the link. A move to the same point does not report the move to the page.
    const outside = cellPoint(origin, session, 20, linkRow);
    post([{ type: "move", x: outside.x, y: outside.y }, { type: "move", x: point.x, y: point.y }]);
    await s.until("terminal.session", (value) => value.link === LINK,
      `the hovered link was not reported at ${JSON.stringify(point)} (view origin ${JSON.stringify(origin)})`, { surface });
    click(point.x, point.y);
    await s.until("terminal.session", (value) => value.selectionReleases > session.selectionReleases,
      "the plain click did not end as a selection click", { surface });
    assert.equal(log.lines.some((line) => line.startsWith("host linkOpen")), false, "a plain click opened the link");
    click(point.x, point.y, ["command"]);
    const opened = await log.until((all) => all.some((line) => line.startsWith("host linkOpen") && line.includes(LINK) && / -> /.test(line)),
      "the host did not answer a linkOpen request", 10000);
    const answer = opened.find((line) => line.startsWith("host linkOpen"));
    assert.doesNotMatch(answer, /error|reject/i, `the host rejected the link: ${answer}`);
    assert.equal((await s.get("terminal.session", surface)).error ?? null, null, "the link open left a session error");
  });
}

// Wheel scroll measurement. Line i has one '#' in column i % 97. Reading the column of '#' in the top row of each recorded frame
// gives the line that the frame showed modulo 97, and the difference between neighboring frames gives the number of moved lines.
const MARKS = 97;

function topMark(frame, region, session) {
  const top = Math.round(region.frame.y * frame.scale);
  const bottom = Math.round((region.frame.y + session.cellHeight) * frame.scale);
  let best = null;
  let bestCount = 0;
  for (let column = 0; column < MARKS; column++) {
    const left = Math.round((region.frame.x + column * session.cellWidth) * frame.scale);
    const right = Math.round((region.frame.x + (column + 1) * session.cellWidth) * frame.scale);
    let count = 0;
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
      if (pixel(frame, x, y).every((value) => value > 150)) count++;
    }
    if (count > bestCount) { best = column; bestCount = count; }
  }
  return bestCount >= 4 ? best : null;
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a real wheel over a long history is shown without lag, stalls, or reversal`, { timeout: 240000 }, async (t) => {
    const { s, surface, session, origin } = await prepare(t, app, "WHEELSTART", { fullscreen: true });
    assert.ok(session.cols > MARKS, `the terminal has ${session.cols} columns; the check needs more than ${MARKS}`);
    await s.run("terminal.input", {
      bytes: "clear; awk 'BEGIN{for(i=0;i<100000;i++) printf \"%\" (i%97+1) \"s\\n\", \"#\"}'; printf 'WHEELREADY\\n'\r",
    }, surface);
    const writeStart = performance.now();
    await s.run("terminal.screen.read", {}, surface);
    await s.until("terminal.screen", (rows) => rows.some((row) => row.map((cell) => cell.ch ?? " ").join("").trim() === "WHEELREADY"),
      "100,000 lines were not written", { surface, timeout: 180000 });
    const writeMs = Math.round(performance.now() - writeStart);
    t.diagnostic(`${app.name}: 100,000 lines were written and shown in ${writeMs} ms`);
    const history = (await s.get("terminal.session", surface)).scrollback.history;
    const region = (await s.get("host.window")).regions.find((item) => item.surface === surface && item.name === "view");
    const point = cellPoint(origin, session, 50, 5);
    post([{ type: "move", x: point.x, y: point.y }]);
    await s.request("diagnostics.capture.start", {});
    // Sends 3 lines every 16 ms, 120 times, like a person who keeps turning the wheel.
    const steps = [];
    for (let i = 0; i < 120; i++) steps.push({ type: "wheel", x: point.x, y: point.y, lines: 3 });
    const sent = post(steps);
    const displayed = await s.presented();
    const { frames: directory } = await s.request("diagnostics.capture.stop", { after: displayed.displayed });
    try {
      const final = (await s.get("terminal.session", surface)).scrollback.offset;
      const files = frames(directory);
      assert.ok(files.length > 30, `the recording has only ${files.length} frames`);
      const shown = [];
      let previous = null;
      let moved = 0;
      let backward = 0;
      let largest = 0;
      for (const file of files) {
        const frame = readFrame(file);
        const mark = topMark(frame, region, session);
        assert.notEqual(mark, null, `frame at ${frame.time} ms shows no line mark in the top row`);
        if (previous !== null) {
          // Scrolling up decreases the top line number. Mapping the difference into (-48, 48] gives the number of moved lines.
          let delta = ((previous - mark) % MARKS + MARKS) % MARKS;
          if (delta > MARKS / 2) delta -= MARKS;
          if (delta < 0) backward++;
          largest = Math.max(largest, Math.abs(delta));
          moved += delta;
        }
        previous = mark;
        shown.push({ time: frame.time, moved });
      }
      const inputStart = sent[0];
      const inputEnd = sent.at(-1);
      const firstMove = shown.find((item) => item.moved > 0);
      const settled = shown.find((item) => item.moved === moved);
      // Longest time during which the screen did not change while the input continued.
      let stall = 0;
      let changedAt = firstMove?.time ?? inputStart;
      for (let index = 1; index < shown.length; index++) {
        if (shown[index].time > inputEnd) break;
        if (shown[index].moved !== shown[index - 1].moved) changedAt = shown[index].time;
        else stall = Math.max(stall, shown[index].time - changedAt);
      }
      const intervals = shown.slice(1).map((item, index) => item.time - shown[index].time);
      const report = {
        writeMs, history, final, displayedLines: moved, frames: shown.length,
        inputMs: Math.round(inputEnd - inputStart),
        startLagMs: firstMove ? Math.round(firstMove.time - inputStart) : null,
        endLagMs: Math.round(settled.time - inputEnd),
        longestStallMs: Math.round(stall),
        largestStepLines: largest, backwardFrames: backward,
        medianFrameMs: intervals.sort((a, b) => a - b)[Math.floor(intervals.length / 2)],
      };
      t.diagnostic(`${app.name}: ${JSON.stringify(report)}`);
      assert.equal(moved, final, `the display moved ${moved} lines but the viewport is at ${final}: ${JSON.stringify(report)}`);
      assert.equal(backward, 0, `the display moved backward: ${JSON.stringify(report)}`);
      assert.ok(report.startLagMs !== null && report.startLagMs <= 50, `the first wheel event was shown late: ${JSON.stringify(report)}`);
      assert.ok(report.endLagMs <= 50, `the last wheel event was shown late: ${JSON.stringify(report)}`);
      assert.ok(report.longestStallMs <= 50, `the display stalled while the wheel turned: ${JSON.stringify(report)}`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: the scrollbar thumb shows an open hand and a closed hand while it is dragged`, { timeout: 120000 }, async (t) => {
    const { s, surface, origin, session } = await prepare(t, app, "CURSORSTART");
    await s.run("terminal.input", { bytes: "i=0; while [ $i -lt 80 ]; do printf 'ROW%02d\\n' $i; i=$((i+1)); done\r" }, surface);
    await readScreenUntil(s, surface, (lines) => lines.some((line) => line === "ROW79"), "the rows did not render");
    await s.until("terminal.session", (value) => value.scrollback?.history > 0, "the output did not exceed the screen", { surface });
    const thumb = await screenCenter(s, await s.rect("terminal.scrollbar.thumb", undefined, surface));
    const text = cellPoint(origin, session, 3, 2);
    // The pointer enters the handle from above the glyphs. Reads the system cursor after it is displayed.
    post([{ type: "move", x: text.x, y: text.y }, { type: "move", x: thumb.x, y: thumb.y }]);
    await s.presented();
    assert.equal(systemCursor(), "openHand", "the pointer over the scrollbar thumb is not an open hand");
    // When the window becomes the key window again, AppKit rebuilds the cursor rects. The window is activated again while the pointer stays on the handle.
    activateFinder();
    await s.until("host.window", (window) => window.active === false, "the application stayed active");
    await bringFront(s, app, await s.rect("terminal.scrollbar.thumb", undefined, surface));
    await s.presented();
    assert.equal(systemCursor(), "openHand", "the pointer over the scrollbar thumb is not an open hand after the window became key");
    post([{ type: "down", x: thumb.x, y: thumb.y }, { type: "drag", x: thumb.x, y: thumb.y - 10 }, { type: "drag", x: thumb.x, y: thumb.y - 20 }]);
    await s.presented();
    const dragging = systemCursor();
    post([{ type: "up", x: thumb.x, y: thumb.y - 20 }]);
    assert.equal(dragging, "closedHand", "the pointer while the thumb is dragged is not a closed hand");
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: slow pointer movement over terminal text`, { timeout: 90000 }, async (t) => {
    const { s, surface, session, origin, row } = await prepare(t, app, "CURSORSHAPE");
    const first = cellPoint(origin, session, 4, row);
    const view = await s.rect("terminal.view", undefined, surface);
    const hit = await s.run("host.hit", { x: view.x + 4.5 * session.cellWidth, y: view.y + (row + 0.5) * session.cellHeight });
    const { active, responder } = await s.get("host.window");
    t.diagnostic(`${app.name}: pointer hit ${JSON.stringify(hit)}, window ${JSON.stringify({ active, responder })}`);
    post([{ type: "move", x: first.x, y: first.y }]);
    const steps = [];
    for (let step = 0; step < 600; step++) {
      steps.push({ type: "move", x: first.x + Math.sin(step * 0.05) * session.cellWidth * 0.7, y: first.y, wait: 16 });
    }
    const cursors = postWithCursorSamples(steps);
    t.diagnostic(`${app.name}: slow terminal pointer samples ${JSON.stringify(cursors)}`);
    assert.ok(cursors.iBeam === steps.length * 4 && cursors.arrow === 0 && cursors.other === 0 && cursors.missing === 0,
      `terminal pointer flickered during smooth movement: ${JSON.stringify(cursors)}`);
  });

  test(`${app.name}: dividers and card icons show their cursors after moves, focus changes, and terminal output`, { timeout: 180000 }, async (t) => {
    const { s, surface, origin, session } = await prepare(t, app, "CURSORS");
    const grid = await s.get("core.grid");
    const dividers = [];
    for (let index = 0; ; index++) {
      const rect = await s.rect("core.divider", index).catch(() => null);
      if (!rect) break;
      dividers.push(rect);
    }
    const vertical = dividers.find((rect) => rect.height > rect.width * 4);
    assert.ok(vertical, `no vertical divider in ${JSON.stringify(dividers)}`);
    const divider = await screenCenter(s, vertical);
    const close = await screenCenter(s, await s.rect("core.card.close", 0));
    const text = cellPoint(origin, session, 3, 2);
    const read = async (point) => {
      post([{ type: "move", x: text.x, y: text.y }, { type: "move", x: point.x, y: point.y }]);
      await s.presented();
      return systemCursor();
    };
    const seen = {};
    seen.dividerAfterText = await read(divider);
    seen.closeAfterText = await read(close);
    // While the terminal keeps printing (while the native surface is updated), reads the cursor over the divider several times.
    await s.run("terminal.input", { bytes: "i=0; while [ $i -lt 3000 ]; do echo line$i; i=$((i+1)); done\r" }, surface);
    post([{ type: "move", x: divider.x, y: divider.y }]);
    seen.dividerDuringOutput = [];
    for (let i = 0; i < 5; i++) {
      await s.presented();
      seen.dividerDuringOutput.push(systemCursor());
    }
    // Gives focus to another card while the pointer stays on the divider. Each card records its kind and responder together.
    seen.focus = [];
    for (const card of grid.cards.filter((item) => item.tabs.length)) {
      await s.run("core.card.focus", { card: card.id });
      await s.presented();
      const plugin = card.tabs.find((tab) => tab.id === card.active)?.plugin;
      seen.focus.push({ card: card.id, plugin, cursor: systemCursor(), responder: (await s.get("host.window")).responder });
    }
    seen.dividerAfterFocus = seen.focus.find((item) => item.cursor !== "resizeLeftRight")?.cursor ?? "resizeLeftRight";
    // Gives focus to each card while the pointer stays on the icon.
    post([{ type: "move", x: close.x - 3, y: close.y }, { type: "move", x: close.x, y: close.y }]);
    await s.presented();
    // When focus changes the card width, the icon can leave from under the pointer. The cursor must be a hand if the icon stays under the pointer
    // and must not be a hand if it left.
    seen.closeAfterFocus = [];
    for (const card of grid.cards.filter((item) => item.tabs.length)) {
      await s.run("core.card.focus", { card: card.id });
      await s.presented();
      const now = await s.rect("core.card.close", 0);
      const at = await screenCenter(s, now);
      const under = Math.abs(at.x - close.x) <= now.width / 2 && Math.abs(at.y - close.y) <= now.height / 2;
      seen.closeAfterFocus.push({ card: card.id, under, cursor: systemCursor() });
    }
    // When the divider leaves while the pointer stays on the divider, the resize cursor must leave too.
    post([{ type: "move", x: divider.x, y: divider.y - 3 }, { type: "move", x: divider.x, y: divider.y }]);
    await s.presented();
    const line = (await s.get("core.grid")).cards.find((card) => card.active === surface)?.c1;
    // The divider rectangle is in document coordinates and the grid lines are in board coordinates.
    const current = await s.get("core.grid");
    const moveFrom = current.lines.x;
    const center = vertical.x + vertical.width / 2 - current.plane.x;
    const index = moveFrom.findIndex((position) => Math.abs(position - center) <= 4);
    assert.ok(index > 0, `the hovered divider is not a grid line: ${JSON.stringify({ lines: moveFrom, vertical, line })}`);
    await s.run("core.boundary.move", { axis: "x", line: index, position: moveFrom[index] + 80 });
    await s.presented();
    await s.presented();
    seen.afterDividerLeft = systemCursor();
    await s.run("core.boundary.move", { axis: "x", line: index, position: moveFrom[index] });
    t.diagnostic(`${app.name}: ${JSON.stringify(seen)}`);
    assert.ok(seen.closeAfterFocus.every((item) => (item.cursor === "pointingHand") === item.under),
      `close icon after focus changes: ${JSON.stringify(seen)}`);
    assert.ok(seen.closeAfterFocus.some((item) => item.under), `the icon never stayed under the pointer: ${JSON.stringify(seen)}`);
    assert.ok(!["resizeLeftRight", "columnResize"].includes(seen.afterDividerLeft), `the resize cursor stayed after the divider left: ${JSON.stringify(seen)}`);
    const resize = ["resizeLeftRight", "columnResize"];
    assert.ok(resize.includes(seen.dividerAfterText), `divider after text: ${JSON.stringify(seen)}`);
    assert.equal(seen.closeAfterText, "pointingHand", `close icon after text: ${JSON.stringify(seen)}`);
    assert.ok(seen.dividerDuringOutput.every((name) => resize.includes(name)), `divider during output: ${JSON.stringify(seen)}`);
    assert.ok(resize.includes(seen.dividerAfterFocus), `divider after a focus change: ${JSON.stringify(seen)}`);
  });

  test(`${app.name}: a real pointer move is reported with ?1003 and a real Shift drag selects while ?1002 is on`, { timeout: 90000 }, async (t) => {
    const { s, surface, session, origin, row } = await prepare(t, app, "SHIFTSELECT");
    // Reads the input COUNT bytes in raw mode and writes them as R<ID>:<hexadecimal>. It uses %s so that the characters of the command line differ from the display.
    const read = async (id, on, count, off) => {
      await s.run("terminal.input", { bytes: `printf '${on}'; stty raw -echo; printf 'WAIT%s\\r\\n' ${id}; ` +
        `R=$(dd bs=1 count=${count} 2>/dev/null | od -An -tx1 | tr -d ' \\n'); stty sane; printf '${off}'; printf 'R%s:%s\\n' ${id} "$R"\r` }, surface);
      await readScreenUntil(s, surface, (lines) => lines.some((line) => line.startsWith(`WAIT${id}`)), `${id} did not start reading`);
    };
    const result = async (id) => {
      const lines = await readScreenUntil(s, surface, (screen) => screen.some((line) => line.startsWith(`R${id}:`)), `${id} did not finish`);
      return Buffer.from(lines.find((line) => line.startsWith(`R${id}:`)).slice(`R${id}:`.length).trim(), "hex").toString("latin1");
    };

    // ?1003: reports a pointer that moved without a button when the cell changes.
    const motion = "\x1b[<35;10;5M";
    await read("MOTION", "\\033[?1003h\\033[?1006h", motion.length, "\\033[?1003l\\033[?1006l");
    post([{ type: "move", ...cellPoint(origin, session, 9, 4) }]);
    assert.equal(await result("MOTION"), motion, "?1003 did not report a real pointer move");

    // Even in ?1002, a drag with Shift pressed is not reported and selects text. The Z written afterward must be the first byte of the PTY.
    await read("SHIFT", "\\033[?1002h\\033[?1006h", 1, "\\033[?1002l\\033[?1006l");
    const before = (await s.get("terminal.session", surface)).selectionReleases;
    // A selection covers a cell only when the pointer passes the middle of that cell, so the press happens near the left edge of the first cell and the release passes the middle of the last cell
    // (docs/spec/terminal-runtime.md).
    const from = { ...cellPoint(origin, session, 0, row), x: cellPoint(origin, session, 0, row).x - 0.3 * session.cellWidth };
    const to = { ...cellPoint(origin, session, 4, row), x: cellPoint(origin, session, 4, row).x + 0.3 * session.cellWidth };
    const steps = [{ type: "move", ...from, modifiers: ["shift"] }, { type: "down", ...from, modifiers: ["shift"] }];
    for (let i = 1; i <= 8; i++) steps.push({ type: "drag", x: from.x + (to.x - from.x) * i / 8, y: from.y, modifiers: ["shift"] });
    steps.push({ type: "up", ...to, modifiers: ["shift"] });
    post(steps);
    await s.until("terminal.session", (value) => value.selectionReleases === before + 1,
      "the sidecar did not answer the release of the Shift drag", { surface });
    await s.until("terminal.session", () => pasteboardText() === "SHIFT", "the Shift drag did not copy the selection", { surface });
    await s.run("terminal.input", { bytes: "Z" }, surface);
    assert.equal(await result("SHIFT"), "Z", "the Shift drag was reported to the program");
  });

  test(`${app.name}: a real Shift drag selects while ?1003 motion reporting is on`, { timeout: 90000 }, async (t) => {
    const { s, surface, session, origin, row } = await prepare(t, app, "SHIFT1003");
    const read = async (id, on, count, off) => {
      await s.run("terminal.input", { bytes: `printf '${on}'; stty raw -echo; printf 'WAIT%s\\r\\n' ${id}; ` +
        `R=$(dd bs=1 count=${count} 2>/dev/null | od -An -tx1 | tr -d ' \\n'); stty sane; printf '${off}'; printf 'R%s:%s\\n' ${id} "$R"\r` }, surface);
      await readScreenUntil(s, surface, (lines) => lines.some((line) => line.startsWith(`WAIT${id}`)), `${id} did not start reading`);
    };
    const result = async (id) => {
      const lines = await readScreenUntil(s, surface, (screen) => screen.some((line) => line.startsWith(`R${id}:`)), `${id} did not finish`);
      return Buffer.from(lines.find((line) => line.startsWith(`R${id}:`)).slice(`R${id}:`.length).trim(), "hex").toString("latin1");
    };
    // A full-screen TUI often uses ?1003: with Shift pressed, motion reporting stays active but Shift owns text selection.
    await read("SHIFT1003", "\\033[?1003h\\033[?1006h", 1, "\\033[?1003l\\033[?1006l");
    const before = (await s.get("terminal.session", surface)).selectionReleases;
    const start = cellPoint(origin, session, 0, row);
    const from = { ...start, x: start.x - 0.3 * session.cellWidth };
    const end = cellPoint(origin, session, 4, row);
    const to = { ...end, x: end.x + 0.3 * session.cellWidth };
    // ?1003 also reports moves without a press, so no hover move is added. The read is 1 byte, so the motion report of the hover
    // would consume that byte. Keeping only press, drag and release proves that the first byte is Z.
    const steps = [{ type: "down", ...from, modifiers: ["shift"] }];
    for (let i = 1; i <= 8; i++) steps.push({ type: "drag", x: from.x + (to.x - from.x) * i / 8, y: from.y, modifiers: ["shift"] });
    steps.push({ type: "up", ...to, modifiers: ["shift"] });
    post(steps);
    await s.until("terminal.session", (value) => value.selectionReleases === before + 1,
      "the sidecar did not answer the release of the Shift drag in ?1003", { surface });
    await s.until("terminal.session", (value) => value.mouse.reported === false && value.mouse.bytes === null,
      "the Shift drag was reported to the ?1003 program", { surface });
    await s.until("terminal.session", () => pasteboardText() === "SHIFT",
      `the ?1003 Shift drag did not copy the selection (the pasteboard holds ${JSON.stringify(pasteboardText())})`, { surface });
    await s.run("terminal.input", { bytes: "Z" }, surface);
    assert.equal(await result("SHIFT1003"), "Z", "the ?1003 Shift drag was reported to the program");
  });

  test(`${app.name}: a real plain pointer press reaches the PTY while ?1003 motion reporting is on`, { timeout: 90000 }, async (t) => {
    const { s, surface, session, origin, row } = await prepare(t, app, "PLAIN1003");
    const hover = `\x1b[<35;80;${row + 1}M`;
    const press = `\x1b[<0;1;${row + 1}M`;
    const on = "\\033[?1003h\\033[?1006h";
    const off = "\\033[?1003l\\033[?1006l";
    const read = async (id, expected) => {
      await s.run("terminal.input", { bytes: `printf '${on}'; stty raw -echo; printf 'WAIT%s\\r\\n' ${id}; ` +
        `R=$(dd bs=1 count=${expected.length} 2>/dev/null | od -An -tx1 | tr -d ' \\n'); stty sane; ` +
        `printf '${off}'; printf 'R%s:%s\\n' ${id} "$R"\r` }, surface);
      await readScreenUntil(s, surface, (lines) => lines.some((line) => line.startsWith(`WAIT${id}`)),
        `the plain ?1003 PTY reader ${id} did not start`);
      return () => readScreenUntil(s, surface, (screen) => screen.some((line) => line.startsWith(`R${id}:`)),
        `the plain ?1003 PTY reader ${id} did not finish`).then((lines) =>
        Buffer.from(lines.find((line) => line.startsWith(`R${id}:`)).slice(`R${id}:`.length).trim(), "hex").toString("latin1"));
    };
    const start = cellPoint(origin, session, 0, row);
    const hoverPoint = cellPoint(origin, session, 79, row);
    const first = await read("PLAIN1003PRESS", hover + press);
    post([{ type: "move", ...hoverPoint }, { type: "down", ...start }]);
    assert.equal(await first(), hover + press, "plain ?1003 press bytes differed");
    const end = cellPoint(origin, session, 1, row);
    const motion = `\x1b[<32;2;${row + 1}M`;
    const release = `\x1b[<0;2;${row + 1}m`;
    const second = await read("PLAIN1003DRAG", motion + release);
    post([{ type: "drag", ...end }, { type: "up", ...end }]);
    assert.equal(await second(), motion + release, "plain ?1003 drag bytes differed");
    await s.run("terminal.input", { bytes: "\x1b[?1003l\x1b[?1006l" }, surface);
  });

  test(`${app.name}: a fixture TUI plain drag reaches the PTY`, { timeout: 90000 }, async (t) => {
    const { s, surface } = await prepare(t, app, "TUI");
    await s.run("terminal.input", { bytes: LAUNCH }, surface);
    await readScreenUntil(s, surface, (lines) => lines.some((line) => line.includes(PROMPT)),
      "the fixture TUI prompt did not appear");
    const session = await s.get("terminal.session", surface);
    const view = await s.rect("terminal.view", undefined, surface);
    const center = await bringFront(s, app, view);
    const origin = { x: center.x - view.width / 2, y: center.y - view.height / 2 };
    const row = Math.max(1, Math.floor(session.rows / 2));
    const from = { x: origin.x + session.cellWidth, y: origin.y + (row + 0.5) * session.cellHeight };
    const to = { x: origin.x + session.cellWidth * 5, y: from.y };
    dragPath(from, to, 8);
    await s.until("terminal.session", (value) => value.mouse.phase === "up",
      "the fixture TUI drag did not reach the terminal release", { surface });
    const result = await s.get("terminal.session", surface);
    const window = await s.get("host.window");
    assert.equal(window.active, true);
    assert.equal(window.key, true);
    assert.equal(result.mouse.reported, true, "the fixture TUI did not report the plain drag");
    assert.equal(result.mouse.written, true, "the fixture TUI did not write the plain drag to the PTY");
    assert.match(result.mouse.bytes ?? "", /^[A-Za-z0-9+/]+=*$/, "the fixture TUI PTY bytes were not recorded");
    assert.equal(result.error, undefined);
  });

  test(`${app.name}: a fixture TUI Shift drag selects visible prompt text`, { timeout: 120000 }, async (t) => {
    const { s, surface } = await prepare(t, app, "TUISHIFT");
    await s.run("terminal.input", { bytes: LAUNCH }, surface);
    const lines = await readScreenUntil(s, surface, (value) => value.some((line) => line.includes(PROMPT)),
      "the fixture TUI prompt did not appear for Shift selection");
    const row = lines.findIndex((line) => line.includes(PROMPT));
    const line = lines[row];
    const startColumn = line.indexOf(PROMPT);
    assert.ok(startColumn >= 0, `the fixture TUI prompt text was not found in ${JSON.stringify(line)}`);
    const endColumn = startColumn + PROMPT.length - 1;
    const session = await s.get("terminal.session", surface);
    const view = await s.rect("terminal.view", undefined, surface);
    const center = await bringFront(s, app, view);
    const origin = { x: center.x - view.width / 2, y: center.y - view.height / 2 };
    const point = (column) => cellPoint(origin, session, column, row);
    const startPoint = { ...point(startColumn), x: point(startColumn).x - 0.3 * session.cellWidth };
    const endPoint = { ...point(endColumn), x: point(endColumn).x + 0.3 * session.cellWidth };
    const before = (await s.get("terminal.session", surface)).selectionReleases;
    post([
      { type: "move", ...startPoint, modifiers: ["shift"] },
      { type: "down", ...startPoint, modifiers: ["shift"] },
      ...Array.from({ length: 8 }, (_, index) => ({
        type: "drag",
        x: startPoint.x + (endPoint.x - startPoint.x) * (index + 1) / 8,
        y: startPoint.y,
        modifiers: ["shift"],
      })),
      { type: "up", ...endPoint, modifiers: ["shift"] },
    ]);
    await s.until("terminal.session", (value) => value.selectionReleases === before + 1,
      "the fixture TUI Shift drag did not release a selection", { surface });
    await s.until("terminal.session", (value) => value.error === undefined,
      "the fixture TUI Shift drag reported a terminal error", { surface });
    assert.equal(pasteboardText(), PROMPT, `the fixture TUI Shift drag copied ${JSON.stringify(pasteboardText())}`);
  });

  test(`${app.name}: a fixture TUI drag repeats after a third point and card focus round trip`, { timeout: 180000 }, async (t) => {
    const { s, surface } = await prepare(t, app, "TUIROUNDTRIP");
    await s.run("terminal.input", { bytes: LAUNCH }, surface);
    const lines = await readScreenUntil(s, surface, (value) => value.some((line) => line.includes(PROMPT)),
      "the fixture TUI prompt did not appear for the round-trip drag");
    const row = lines.findIndex((line) => line.includes(PROMPT));
    const startColumn = lines[row].indexOf(PROMPT);
    const session = await s.get("terminal.session", surface);
    const view = await s.rect("terminal.view", undefined, surface);
    const center = await bringFront(s, app, view);
    const origin = { x: center.x - view.width / 2, y: center.y - view.height / 2 };
    const point = (column) => cellPoint(origin, session, column, row);
    const from = { ...point(startColumn), x: point(startColumn).x - 0.3 * session.cellWidth };
    const to = { ...point(startColumn + 8), x: point(startColumn + 8).x + 0.3 * session.cellWidth };
    const third = point(startColumn + 18);
    const grid = await s.get("core.grid");
    const owner = grid.cards.find((item) => item.tabs.some((tab) => tab.id === surface));
    const other = grid.cards.find((item) => item.id !== owner?.id && item.id !== "left");
    assert.ok(owner && other, `round-trip requires two cards: ${JSON.stringify(grid)}`);
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await s.get("terminal.session", surface);
      dragPath(from, to, 12);
      await s.until("terminal.session", (value) => value.mouse.phase === "up" || value.error !== undefined,
        `round-trip ${attempt + 1}: first drag did not finish`, { surface });
      const first = await s.get("terminal.session", surface);
      const firstWindow = await s.get("host.window");
      assert.equal(first.error, undefined, `round-trip ${attempt + 1}: first drag error ${first.error}`);
      assert.equal(first.mouse.reported, true,
        `round-trip ${attempt + 1}: first drag was not reported; before=${JSON.stringify(before)} window=${JSON.stringify(firstWindow)}`);

      // After the successful drag, a click at a third point and an immediate retry follow.
      click(third.x, third.y);
      dragPath(from, to, 12);
      await s.until("terminal.session", (value) => value.mouse.phase === "up" || value.error !== undefined,
        `round-trip ${attempt + 1}: third-point retry did not finish`, { surface });
      const repeated = await s.get("terminal.session", surface);
      if (repeated.error !== undefined || repeated.mouse.reported !== true || repeated.mouse.written !== true) {
        // Only after the direct retry fails, the check goes through another card, returns and retries.
        await s.run("core.card.focus", { card: other.id });
        await s.until("core.grid", (value) => value.cards.some((item) => item.id === other.id && item.focused),
          `round-trip ${attempt + 1}: other card did not focus`);
        await s.run("core.card.focus", { card: owner.id });
        await s.until("core.grid", (value) => value.cards.some((item) => item.id === owner.id && item.focused),
          `round-trip ${attempt + 1}: the fixture TUI card did not refocus`);
        click(from.x, from.y);
        await s.until("host.window", (value) => value.regions.some((region) => region.surface === surface && region.focused),
          `round-trip ${attempt + 1}: the fixture TUI input did not regain native focus`);
        dragPath(from, to, 12);
        await s.until("terminal.session", (value) => value.mouse.phase === "up" || value.error !== undefined,
          `round-trip ${attempt + 1}: card retry did not finish`, { surface });
        const recovered = await s.get("terminal.session", surface);
        t.diagnostic(JSON.stringify({ attempt: attempt + 1, failedDirectRetry: repeated, recovery: recovered }));
      }
      const repeatedWindow = await s.get("host.window");
      assert.equal(repeated.error, undefined, `round-trip ${attempt + 1}: repeated drag error ${repeated.error}`);
      assert.equal(repeated.mouse.reported, true,
        `round-trip ${attempt + 1}: repeated drag was not reported; window=${JSON.stringify(repeatedWindow)}`);
      assert.equal(repeated.mouse.written, true, `round-trip ${attempt + 1}: repeated drag was not written to PTY`);
    }
  });

  test(`${app.name}: real keypad keys send SS3 sequences in application keypad mode and characters otherwise`, { timeout: 90000 }, async (t) => {
    const { s, surface, session, origin } = await prepare(t, app, "KEYPAD");
    // The key goes to the terminal area that has the focus.
    const focus = cellPoint(origin, session, 2, 0);
    click(focus.x, focus.y);
    await s.until("host.window", (window) => window.regions.some((region) => region.surface === surface && region.focused),
      "the click did not give the terminal region native focus");
    const read = async (id, on, count, off) => {
      await s.run("terminal.input", { bytes: `printf '${on}'; stty raw -echo; printf 'WAIT%s\\r\\n' ${id}; ` +
        `R=$(dd bs=1 count=${count} 2>/dev/null | od -An -tx1 | tr -d ' \\n'); stty sane; printf '${off}'; printf 'R%s:%s\\n' ${id} "$R"\r` }, surface);
      await readScreenUntil(s, surface, (lines) => lines.some((line) => line.startsWith(`WAIT${id}`)), `${id} did not start reading`);
    };
    const result = async (id) => {
      const lines = await readScreenUntil(s, surface, (screen) => screen.some((line) => line.startsWith(`R${id}:`)), `${id} did not finish`);
      return Buffer.from(lines.find((line) => line.startsWith(`R${id}:`)).slice(`R${id}:`.length).trim(), "hex").toString("latin1");
    };
    // Key code 87 is keypad 5 and 76 is keypad Enter.
    const keypad = () => { key(87); key(76); };
    await read("APPLICATION", "\\033=", 6, "\\033>");
    keypad();
    assert.equal(await result("APPLICATION"), "\x1bOu\x1bOM", "ESC = did not select the application keypad");
    await read("NUMERIC", "\\033>", 2, "");
    keypad();
    assert.equal(await result("NUMERIC"), "5\r", "ESC > did not select the numeric keypad");
  });

  test(`${app.name}: clicking a real tab notice of a terminal out of view selects its tab`, { timeout: 60000 }, async (t) => {
    requireTrusted();
    const s = await open(t, app);
    await fresh(s);
    const [shown, hidden] = await ensureTerminals(s, 2);
    const cardOf = (grid, surface) => grid.cards.find((card) => card.tabs.some((tab) => tab.id === surface));
    await s.run("core.card.focus", { card: cardOf(await s.get("core.grid"), shown.surface).id });
    await s.until("core.grid", (grid) => cardOf(grid, shown.surface).focused, "the first terminal card did not take focus");
    await s.run("terminal.input", { bytes: "printf '\\033]9;PRESS-NOTICE\\007'\r" }, hidden.surface);
    await s.until("core.grid", (grid) => cardOf(grid, hidden.surface).tabs.find((item) => item.id === hidden.surface).notice === "PRESS-NOTICE",
      "the terminal out of view did not show a tab notice", { timeout: 10000 });
    const grid = await s.get("core.grid");
    const index = grid.cards.flatMap((card) => card.tabs).findIndex((item) => item.id === hidden.surface);
    assert.ok(index >= 0, "the hidden terminal tab is not rendered");
    const tab = await s.rect("core.card.tab", index);
    const center = await bringFront(s, app, tab);
    post([{ type: "move", ...center }, { type: "down", ...center }, { type: "up", ...center }]);
    await s.until("core.grid", (grid) => cardOf(grid, hidden.surface).active === hidden.surface,
      "clicking the tab notice did not select its tab");
    await s.run("core.card.focus", { card: cardOf(await s.get("core.grid"), hidden.surface).id });
    await s.until("core.grid", (grid) => cardOf(grid, hidden.surface).focused,
      "the selected tab's card did not take focus");
  });

  test(`${app.name}: a real Finder drag of a file and of an image pastes their quoted paths without executing`, { timeout: 90000 }, async (t) => {
    requireTrusted();
    const s = await open(t, app);
    await fresh(s);
    const [terminal] = await ensureTerminals(s, 1);
    const surface = terminal.surface;
    await readScreenUntil(s, surface, (lines) => lines.some((line) => line.includes("$")), "shell prompt missing");
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "soksak-drop ")));
    s.cleanup(() => rmSync(directory, { recursive: true, force: true }));
    writeFileSync(join(directory, "drop me.txt"), "text");
    writeFileSync(join(directory, "drop.png"), PNG);
    const view = await s.rect("terminal.view", undefined, surface);
    const initial = (await s.get("host.window")).frame;
    const screen = (await s.get("host.screens")).find((item) => initial.x >= item.x && initial.x < item.x + item.width);
    assert.ok(screen, "the terminal window is not on a visible screen");
    const rightAlignedX = screen.visible.x + screen.visible.width - initial.width;
    await s.run("host.window.move", { x: rightAlignedX, y: initial.y });
    await s.until("host.window", (window) => window.frame.x === rightAlignedX, "the terminal window did not move to the visible right edge");
    let target = await bringFront(s, app, view);
    // The Finder window is placed under the terminal area, inside the app window. The drop point is not covered.
    const { frame } = await s.get("host.window");
    const top = Math.round(target.y + view.height / 2 + 30);
    const bounds = { x: Math.round(frame.x + 20), y: top, width: 500, height: Math.min(220, Math.round(frame.y + frame.height) - top) };
    const finder = openFinderWindow(directory, bounds);
    s.cleanup(() => closeFinderWindow(finder));
    // The drag starts in the Finder window. Finder is brought to the front, but the drop point must be in the app window.
    activateFinder();
    // Another Finder window can be open on the desktop. The check does not assume that the center of this terminal view is not covered
    // and picks an exposed point.
    const pid = appPid(app);
    const candidates = [];
    for (let row = 1; row < 8; row++) {
      for (let column = 1; column < 10; column++) {
        candidates.push({
          x: Math.round(target.x - view.width / 2 + view.width * column / 10),
          y: Math.round(target.y - view.height / 2 + view.height * row / 8),
        });
      }
    }
    target = candidates.find((point) => frontWindowAt(point.x, point.y)?.pid === pid);
    assert.ok(target, "no exposed point in the terminal view is available for the Finder drop");
    for (const name of ["drop me.txt", "drop.png"]) {
      let from;
      await new Promise((resolve, reject) => {
        const deadline = Date.now() + 1000;
        const poll = () => {
          activateFinder();
          from = finderItemCenter(name);
          if (frontWindowAt(from.x, from.y)?.owner === "Finder") return resolve();
          if (Date.now() >= deadline) return reject(new Error(`${name} Finder item did not become frontmost`));
          setTimeout(() => {
            try { poll(); } catch (error) { reject(error); }
          }, 50);
        };
        poll();
      });
      const front = frontWindowAt(from.x, from.y);
      assert.equal(front?.owner, "Finder", `${name} is not in the frontmost window at ${from.x},${from.y}: ${JSON.stringify(front)}`);
      const board = dragPasteboard();
      // Finder recognizes a drag only when a person presses and then pauses briefly.
      const steps = [{ type: "move", ...from }, { type: "down", ...from, wait: 300 }];
      for (let i = 1; i <= 20; i++) {
        steps.push({ type: "drag", x: from.x + (target.x - from.x) * i / 20, y: from.y + (target.y - from.y) * i / 20 });
      }
      steps.push({ type: "up", ...target });
      post(steps);
      const quoted = `'${join(directory, name).replaceAll("'", "'\\''")}'`;
      const lines = await readScreenUntil(s, surface, (screen) => screen.join("").includes(name),
        `the drop of ${name} did not paste it`).catch(async (error) => {
        const screen = await s.get("terminal.screen", surface);
        const state = await s.get("terminal.session", surface);
        throw new Error(`${error.message.split(" (status")[0]}; screen: ${JSON.stringify(screen.map((row) => row.map((cell) => cell.ch ?? " ").join("").trimEnd()).filter(Boolean))}; ` +
          `session error: ${JSON.stringify(state.error)}; core.drop: ${JSON.stringify(await s.get("core.drop"))}; frontmost at the target: ${JSON.stringify(frontWindowAt(target.x, target.y))}; ` +
          `drag pasteboard before ${JSON.stringify(board)} after ${JSON.stringify(dragPasteboard())}; from ${JSON.stringify(from)} to ${JSON.stringify(target)}`);
      });
      assert.ok(lines.join("").includes(quoted), `the drop of ${name} pasted ${JSON.stringify(lines.filter((line) => line.includes("drop")))} instead of ${quoted}`);
      assert.ok(!lines.some((line) => line.includes("command not found")), "a drop must not execute a command");
      const drop = await s.get("core.drop");
      assert.deepEqual({ surface: drop.surface, command: drop.command, error: drop.error, urls: drop.urls.map((url) => decodeURIComponent(new URL(url).pathname)) },
        { surface, command: "terminal.drop", error: null, urls: [join(directory, name)] }, `core.drop ${JSON.stringify(drop)}`);
      // Clears the pasted input line. After that, a blank cell on the screen must also be blank in the picture. The drop leaves nothing in the window.
      await s.run("terminal.input", { bytes: "\u0015" }, surface);
      await readScreenUntil(s, surface, (screen) => !screen.join("").includes(name), `the input line of ${name} was not cleared`);
      const residue = await blankCellsWithPixels(s, surface);
      assert.deepEqual(residue.cells.slice(0, 20), [], `after the drop of ${name}, ${residue.cells.length} blank cells hold pixels; ` +
        `screen ${JSON.stringify(residue.lines)}`);
    }
  });
}
