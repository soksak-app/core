// Helper with which a window check prepares the terminal surface and reads the screen glyphs.
import assert from "node:assert/strict";
import { rmSync } from "node:fs";

import { frames, pixel, readFrame } from "@soksak/window-check/frame.mjs";

export function textLines(screen) {
  assert.ok(screen && Array.isArray(screen.lines), `invalid terminal screen: ${JSON.stringify(screen)}`);
  return screen.lines.map((row) => row.map((cell) => {
    assert.ok(Number.isInteger(cell.width) && cell.width >= 0, "cell width is required");
    return cell.ch === undefined ? " ".repeat(cell.width) : cell.ch;
  }).join("").trimEnd());
}

/**
 * Whether the rows show the command `echo <marker>` followed directly by its output `<marker>`. A terminal narrower than
 * the command wraps it and its output over rows, so the rows are compared joined and without spaces: the marker holds no
 * space, and the output still has to follow the command.
 */
export function echoed(lines, marker) {
  return lines.join("").replace(/\s+/g, "").includes(`echo${marker}${marker}`);
}

export async function readScreenUntil(session, surface, predicate, message) {
  // Reads the current screen once and waits for the later output by notification. A resize is also reflected in this read.
  await session.run("terminal.screen.read", {}, surface);
  const screen = await session.until("terminal.screen",
    (lines) => predicate(textLines({ lines })), message, { surface });
  return textLines({ lines: screen });
}

export async function ensureTerminals(session, count) {
  // The terminal card of the fixture starts with the first terminal tab active. Before measuring the visible native terminal surface,
  // the declared terminal is selected. Waiting for an inactive tab would turn a mistake in test preparation
  // into a false runtime failure.
  const initialGrid = await session.get("core.grid");
  const terminalTab = initialGrid.cards.flatMap((card) => card.tabs)
    .find((tab) => tab.plugin === "terminal");
  assert.ok(terminalTab, "the fixture has no terminal tab");
  const owner = initialGrid.cards.find((card) => card.tabs.some((tab) => tab.id === terminalTab.id));
  if (owner?.active !== terminalTab.id) await session.run("core.tab.select", { tab: terminalTab.id });
  await session.until(
    "core.surfaces",
    (surfaces) => surfaces.some((item) => item.visible && item.plugin === "terminal"),
    "the fixture terminal did not register before splitting",
  );
  let terminals = (await session.surfaces("terminal")).length;
  while (terminals < count) {
    // Splits the largest terminal card along its longer side. The fixed sidebar and the card sidebar take space, so splitting in only one direction
    // would hit the minimum size rule.
    const grid = await session.get("core.grid");
    const [card] = grid.cards.filter((item) => item.active && item.tabs.some((tab) => tab.plugin === "terminal"))
      .sort((a, b) => b.w * b.h - a.w * a.h);
    assert.ok(card, "a visible terminal card was not found for splitting");
    await session.run("core.card.split", { card: card.id, side: card.w >= card.h ? "right" : "bottom", plugin: "terminal" });
    await session.until(
      "core.surfaces",
      (surfaces) => surfaces.filter((item) => item.visible && item.plugin === "terminal").length >= terminals + 1,
      `terminal count did not reach ${terminals + 1}`
    );
    terminals = (await session.get("core.surfaces"))
      .filter((item) => item.visible && item.plugin === "terminal").length;
  }
  await session.until(
    "core.surfaces",
    (surfaces) => {
      const visible = surfaces.filter((item) => item.visible && item.plugin === "terminal");
      return visible.length >= count && visible.every((item) =>
        item.exposes.includes("status terminal.session"));
    },
    `terminal native surfaces did not reach ${count} with terminal.session registered`
  );
  return session.surfaces("terminal");
}

/**
 * Terminal background for pixel measurement. The terminal draws with the card color (--card), so the background alone cannot be distinguished from the card.
 * The check changes the default background to this color with OSC 11, which a program writes, so that only the places the native raster painted take this color.
 */
export const MEASURED_BACKGROUND = [30, 30, 30];

/** Changes the default background of the terminal to MEASURED_BACKGROUND with OSC 11 and waits until the later output appears on the screen. */
export async function setMeasuredBackground(session, surface) {
  const hex = MEASURED_BACKGROUND.map((value) => value.toString(16).padStart(2, "0")).join("/");
  const marker = `BACKGROUND-${surface}`;
  await session.run("terminal.input", { bytes: `printf '\\033]11;rgb:${hex}\\007${marker}\\n'\r` }, surface);
  await readScreenUntil(session, surface, (lines) => lines.some((line) => line.startsWith(marker)),
    `${surface} did not finish the OSC 11 background change`);
}

/**
 * Reads the background pixel of every cell in the displayed window frame. A screen cell of the page carries no color, so a state that is visible only by color, such as a selection,
 * is measured by pixels. It reads near the upper left corner of the cell to avoid the glyph strokes. cells is a list of {col, row}.
 */
export async function cellBackgrounds(session, surface, cells) {
  await session.request("diagnostics.capture.start", {});
  const { displayed } = await session.presented();
  const { frames: dir } = await session.request("diagnostics.capture.stop", { after: displayed });
  try {
    const files = frames(dir);
    assert.ok(files.length > 0, "the cell capture produced no frames");
    const frame = readFrame(files.at(-1));
    const view = await session.rect("terminal.view", undefined, surface);
    const { cellWidth, cellHeight } = await session.get("terminal.session", surface);
    return cells.map(({ col, row }) => pixel(frame,
      Math.round((view.document.x + view.x + (col + 0.1) * cellWidth) * frame.scale),
      Math.round((view.document.y + view.y + (row + 0.08) * cellHeight) * frame.scale)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Background of a selected cell when there is no highlight color. It is --rail of the current theme (docs/spec/terminal-runtime.md). */
export async function selectionBackground(session) {
  const { values } = await session.get("core.settings");
  const THEMES = await session.get("core.themes");
  return THEMES.find((item) => item.name === values.theme)[values.mode].rail;
}

/** Whether the pixel is within 2 per channel of the #rrggbb color. */
export function isColor(sample, hex) {
  return sample.every((value, index) => Math.abs(value - parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16)) <= 2);
}
