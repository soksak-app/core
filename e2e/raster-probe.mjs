// Helpers of the window checks that use the raster probe fixture `rasterprobe` (e2e/fixtures/raster-probe/probe) as their image
// region: a view with one image region `raster` that the fake persistent sidecar @sok-check/sidecar-rasterprobe
// (e2e/fixtures/sidecars/rasterprobe) draws in one solid color with row bands and an identity marker
// (docs/spec/plugin-processes.md#verification-boundaries). The checks reach the core boundary of image regions, frames and
// persistent sidecar services through it, never through a real plugin.
import assert from "node:assert/strict";

/** The plugin id of the raster probe. */
export const RASTER = "rasterprobe";
/** The name of its image region in host.window regions. */
export const REGION = "raster";
/** The npm name of its fake persistent sidecar. */
export const RASTER_SIDECAR = "@sok-check/sidecar-rasterprobe";
/** The entries that a raster probe tab registers when it is ready for a check. */
export const RASTER_ENTRIES = Object.freeze(["status rasterprobe.view", "status rasterprobe.session", "status rasterprobe.frame",
  "status rasterprobe.input", "command rasterprobe.color", "command rasterprobe.rows", "command rasterprobe.kill"]);

/**
 * The color that a check paints the frames in to find the raster in captured pixels: it differs from the card (--card), the plane
 * (--bg) and the borders of every theme, so only the places that the native raster painted take this color.
 */
export const MEASURED = [30, 30, 30];
export const MEASURED_HEX = `#${MEASURED.map((value) => value.toString(16).padStart(2, "0")).join("")}`;

/**
 * Waits until the raster probe tab `surface` registered RASTER_ENTRIES, its sidecar opened its session and sent a frame, and
 * returns the session status.
 */
export async function rasterReady(s, surface) {
  await s.registered(surface, RASTER_ENTRIES);
  const session = await s.until("rasterprobe.session", (value) => typeof value?.session === "string" && value.connected === true,
    `the raster probe ${surface} did not open a sidecar session`, { surface });
  await s.until("rasterprobe.frame", (frame) => frame !== null, `the raster probe ${surface} received no frame`, { surface });
  return session;
}

/**
 * Adds a raster probe tab to the card (by default the focused card), which makes it the active tab, and waits until it is ready
 * (rasterReady). Returns `{card, surface}`.
 */
export async function addRasterTab(s, card) {
  const target = card ?? (await s.get("core.grid")).cards.find((item) => item.focused)?.id;
  assert.ok(target, "the grid has no focused card for a raster probe tab");
  const { tab } = await s.run("core.card.add-tab", { card: target, plugin: RASTER });
  await s.until("core.grid", (grid) => grid.cards.some((item) => item.id === target && item.active === tab),
    `the raster probe ${tab} did not become the active tab of ${target}`);
  await rasterReady(s, tab);
  return { card: target, surface: tab };
}

/**
 * Adds a raster probe tab (addRasterTab) to the card of the stored layout whose left grid line is `c0` and whose top grid line is `r0`;
 * the start layout has the card at c0 1, r0 0 to the right of the left fixed sidebar at the top. Returns `{card, surface}`.
 */
export async function addRasterTabAt(s, c0, r0) {
  const card = (await s.get("core.layout")).state.cards.find((item) => item.c0 === c0 && item.r0 === r0);
  assert.ok(card, `the layout has no card at the grid lines c0 ${c0}, r0 ${r0}`);
  return addRasterTab(s, card.id);
}

/**
 * Makes `count` raster probe tabs visible: the first is added to the focused card when no visible raster probe exists, and the
 * largest visible raster probe card is split along its longer side with a new raster probe until `count` are visible. Returns the
 * visible raster probe surfaces (core.surfaces entries).
 */
export async function ensureRasters(s, count) {
  if ((await s.surfaces(RASTER)).length === 0) await addRasterTab(s);
  let visible = (await s.surfaces(RASTER)).length;
  while (visible < count) {
    // The fixed sidebars and the card sidebars take space, so splitting in one direction only would hit the minimum card size.
    const grid = await s.get("core.grid");
    const [card] = grid.cards.filter((item) => item.tabs?.find((tab) => tab.id === item.active)?.plugin === RASTER)
      .sort((a, b) => b.w * b.h - a.w * a.h);
    assert.ok(card, "no visible raster probe card to split");
    await s.run("core.card.split", { card: card.id, side: card.w >= card.h ? "right" : "bottom", plugin: RASTER });
    await s.until("core.surfaces", (surfaces) => surfaces.filter((item) => item.visible && item.plugin === RASTER).length >= visible + 1,
      `the raster probe count did not reach ${visible + 1}`);
    visible = (await s.surfaces(RASTER)).length;
  }
  const rasters = await s.surfaces(RASTER);
  for (const { surface } of rasters) await rasterReady(s, surface);
  return rasters;
}

/**
 * Waits until the image region of `surface` presents the last frame that the sidecar sent ({generation, raster, sequence} of
 * rasterprobe.frame), so a pixel read after it shows that frame and not an earlier one. `accept` narrows the frame (for example
 * its color). Returns the frame.
 */
export async function presentedFrame(s, surface, accept = () => true, what = "the expected frame") {
  const frame = await s.until("rasterprobe.frame", (value) => value !== null && accept(value),
    `the raster probe ${surface} did not receive ${what}`, { surface });
  await s.until("host.window", (host) => host.regions.some((region) => region.surface === surface && region.name === REGION
    && region.presented && region.presented.generation === frame.generation && region.presented.raster === frame.raster
    && region.presented.sequence >= frame.sequence),
  `the image region of ${surface} did not present frame ${JSON.stringify({ generation: frame.generation, raster: frame.raster, sequence: frame.sequence })}`);
  return frame;
}

/** Paints the frames of the raster probe `surface` in MEASURED and waits until its image region presents such a frame. */
export async function setMeasuredColor(s, surface) {
  await s.run("rasterprobe.color", { color: MEASURED_HEX }, surface);
  return presentedFrame(s, surface, (frame) => frame.color === MEASURED_HEX, `a frame in ${MEASURED_HEX}`);
}
