// Helpers with which a window check reads the pixels of a view or of the image region of the raster probe in the window
// capture (e2e/fixtures/raster-probe): one point of a rectangle, or the cell backgrounds of the grid of the last presented frame.
import assert from "node:assert/strict";
import { frames, pixel, readFrame } from "@soksak/window-check/frame.mjs";
import { presentedFrame } from "./raster-probe.mjs";
import { cropViewPixels } from "@soksak/window-check/view-content.mjs";

/** The element of the image region of the raster probe (`element.rect`). */
export const RASTER_ELEMENT = "rasterprobe.raster";

/**
 * Records the window until it displays its next frame and returns the pixel at three quarters of `rect` ({x, y, width, height}
 * in window coordinates) of the last recorded frame. The recording stays until the session finalizes it.
 */
export async function regionSample(session, rect) {
  const recording = await session.record();
  const displayed = await session.presented();
  await recording.stop({ after: displayed.displayed });
  const recorded = frames(recording.frames);
  assert.ok(recorded.length > 0, "the region capture produced no frames");
  const crop = cropViewPixels(readFrame(recorded.at(-1)), { x: rect.x, y: rect.y, w: rect.width, h: rect.height });
  return pixel({ ...crop, stride: crop.width * 4 }, Math.floor(crop.width * 0.75), Math.floor(crop.height * 0.75));
}

/**
 * Reads the background pixel of every cell of the grid of the raster probe `surface` in the displayed window frame, after its image
 * region presents the last frame of its sidecar (presentedFrame of raster-probe.mjs). The grid of the frame counts cells in device pixels of the raster, which its
 * scale converts to CSS pixels of the region element. It reads near the upper left corner of the cell, above the row band line
 * at its bottom. cells is a list of {col, row}.
 */
export async function regionCells(session, surface, cells) {
  const { grid, scale } = await presentedFrame(session, surface);
  assert.ok(grid && Number.isFinite(grid.cellWidth) && Number.isFinite(grid.cellHeight) && Number.isFinite(scale) && scale > 0,
    `the frame of ${surface} names no grid: ${JSON.stringify({ grid, scale })}`);
  const recording = await session.record();
  const { displayed } = await session.presented();
  await recording.stop({ after: displayed });
  const recorded = frames(recording.frames);
  assert.ok(recorded.length > 0, "the cell capture produced no frames");
  const frame = readFrame(recorded.at(-1));
  const view = await session.rect(RASTER_ELEMENT, undefined, surface);
  const cellWidth = grid.cellWidth / scale;
  const cellHeight = grid.cellHeight / scale;
  return cells.map(({ col, row }) => {
    const crop = cropViewPixels(frame, { x: view.document.x + view.x + col * cellWidth,
      y: view.document.y + view.y + row * cellHeight, w: cellWidth, h: cellHeight });
    // Sample inside the converted cell, including when it occupies only one capture pixel.
    return pixel({ ...crop, stride: crop.width * 4 },
      Math.min(crop.width - 1, Math.round(crop.width * 0.1)),
      Math.min(crop.height - 1, Math.round(crop.height * 0.08)));
  });
}
