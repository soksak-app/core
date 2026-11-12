// Helpers of the window checks that use the raster probe fixture `rasterprobe` (e2e/fixtures/raster-probe/probe) as their image
// region: a view with one image region `raster` that the fake persistent sidecar @sok-check/sidecar-rasterprobe
// (e2e/fixtures/sidecars/rasterprobe) draws in one solid color with row bands and an identity marker
// (docs/spec/plugin-processes.md#verification-boundaries). The checks reach the core boundary of image regions, frames and
// persistent sidecar services through it, never through a real plugin.
import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { holdCovered } from "@soksak/window-check/app.mjs";
import { processTable } from "@soksak/window-check/process-table.mjs";
import { processRows } from "./service-processes.mjs";

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
 * The color that a check paints the frames in, which the frame records of the raster probe (rasterprobe.frame) name: it differs from
 * the card (--card), the plane (--bg) and the borders of every theme, so a recording, the log of a failed check, shows the places
 * that the native raster painted.
 */
export const MEASURED = [30, 30, 30];
export const MEASURED_HEX = `#${MEASURED.map((value) => value.toString(16).padStart(2, "0")).join("")}`;

/** The sessions that hold the covered drawing of drawCovered until their check ends. */
const coveredSessions = new WeakSet();

/**
 * Makes the image regions of the window of the session `s` draw while the window is covered, until the check ends. A check starts
 * its application without activation, so its window opens behind the windows of other applications and of the other check
 * applications, where a covered window is the normal case, and the image regions of a covered window draw no raster
 * (docs/spec/hosts.md#launch-activation, docs/spec/native-surfaces.md#image-regions). The window keeps reporting its occlusion.
 */
async function drawCovered(s) {
  if (coveredSessions.has(s)) return;
  coveredSessions.add(s);
  // The hold is shared with the drags of the check, so a drag leaves the drawing on (holdCovered).
  s.cleanup(await holdCovered(s));
}

/**
 * Waits until the raster probe tab `surface` registered RASTER_ENTRIES, its sidecar opened its session and sent a frame, and
 * returns the session status. The window of `s` draws its image regions while it is covered (drawCovered).
 */
export async function rasterReady(s, surface) {
  await s.registered(surface, RASTER_ENTRIES);
  const session = await s.until("rasterprobe.session", (value) => typeof value?.session === "string" && value.connected === true,
    `the raster probe ${surface} did not open a sidecar session`, { surface });
  await drawCovered(s);
  await s.until("rasterprobe.frame", (frame) => frame !== null, `the raster probe ${surface} received no frame`, { surface });
  return session;
}

/**
 * The condition on rasterprobe.session that a session of a respawned service holds: a connected session that a service other than
 * the one of `before` holds. A service names its sessions from s1, so the session of a respawned service can carry the name of
 * the session that died with the old service; the service PID tells them apart (docs/spec/persistent-services.md).
 */
export function reopenedSession(before) {
  return (value) => value?.connected === true && typeof value.session === "string" && value.session !== ""
    && Number.isInteger(value.service?.pid) && value.service.pid !== before.service.pid;
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
 * Adds a raster probe tab to the card `card` while a check watches the window, and waits until its image region presents an image.
 * The tab is ready through addRasterTab, so the window draws its image regions while it is covered (rasterReady): a check window
 * opens behind the windows of other applications, and a covered window would present no image at all. Returns the surface.
 */
export async function presentRasterTab(s, card) {
  const { surface } = await addRasterTab(s, card);
  await s.until("core.surfaces", (items) => items.some((item) => item.surface === surface && item.plugin === RASTER && item.visible
    && item.exposes.includes("status rasterprobe.session")), `new raster probe ${surface} did not become a visible declared surface`);
  await s.until("host.window", (host) => host.regions.some((item) => item.surface === surface && item.name === REGION && item.visible
    && item.presented), `new raster probe ${surface} did not present an image region`);
  return surface;
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
 * rasterprobe.frame), so a read after it reads that frame and not an earlier one. `accept` narrows the frame (for example
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

/**
 * Prepares a raster probe session through a raw application client (`client`, `request(client, method, params)`): restores the
 * fixture layout, adds a raster probe tab to its focused card, waits for the notification that the tab is a visible surface and
 * then for the notification that its fake persistent sidecar opened the session. The sidecar runs as the one persistent service
 * with an endpoint. Returns `{surface, session}`.
 */
export async function prepareRasterSession(client, request, ...rest) {
  // A watch has no time limit: each ends by its notification, a failed answer or the close of the connection.
  if (rest.length > 0) throw new TypeError("prepareRasterSession takes no options: its waits end by their notifications or the close of the connection");
  await request(client, "diagnostics.fixture", { window: "main", settings: {} });
  const grid = await request(client, "status.get", { window: "main", name: "core.grid" });
  const card = grid?.cards?.find((item) => item.focused)?.id;
  if (!card) throw new Error("the shutdown fixture has no focused card for a raster probe tab");
  const added = await request(client, "command.run", { window: "main", name: "core.card.add-tab", params: { card, plugin: RASTER } });
  const surface = added?.tab;
  if (typeof surface !== "string" || surface.length === 0) {
    throw new Error(`core.card.add-tab returned ${JSON.stringify(added)}, expected a raster probe tab`);
  }
  await client.watch("main", "core.surfaces",
    (value) => value.some((item) => item.surface === surface && item.plugin === RASTER && item.visible));
  const session = await client.watch("main", "rasterprobe.session",
    (value) => typeof value?.session === "string" && value.connected === true && !value.error, { surface });
  return { surface, session: session.session };
}

/**
 * The processes of the persistent raster probe service of the configuration `configDir`: the one service process that the host
 * started with `--service-dir <configDir>/services/sok-rasterprobe` (docs/spec/persistent-services.md), whose PID its endpoint
 * publishes, and the child processes of its sessions, one per open session. Processes of other configurations are not counted.
 * Returns `{service, children}` with the child PIDs sorted.
 */
export function rasterServiceSnapshot(configDir) {
  const serviceDir = join(realpathSync(configDir), "services", "sok-rasterprobe");
  const endpoint = JSON.parse(readFileSync(join(serviceDir, "endpoint.json"), "utf8"));
  assert.equal(endpoint.protocol, 1, "the raster probe service protocol does not match");
  assert.ok(Number.isInteger(endpoint.pid) && endpoint.pid > 0, "the raster probe service PID is missing");
  const rows = processRows(processTable("pid=,ppid=,stat=,command="));
  // The host passes the service folder as one argument of the command, wherever it stands.
  const services = rows.filter((row) => ` ${row.command} `.includes(` --service-dir ${serviceDir} `));
  assert.equal(services.length, 1, "the configuration must own exactly one raster probe service");
  assert.equal(services[0].pid, endpoint.pid, "the published service PID differs from the running process");
  assert.equal(services[0].state.includes("Z"), false, "the raster probe service is a zombie");
  const children = rows.filter((row) => row.parent === endpoint.pid);
  for (const child of children) assert.equal(child.state.includes("Z"), false, `the session child ${child.pid} is a zombie`);
  return { service: endpoint.pid, children: children.map(({ pid }) => pid).sort((a, b) => a - b) };
}

/** Closes every raster probe tab of the grid. */
export async function closeRasterTabs(s) {
  const grid = await s.get("core.grid");
  for (const tab of grid.cards.flatMap((card) => card.tabs).filter((tab) => tab.plugin === RASTER)) {
    await s.run("core.tab.close", { tab: tab.id });
  }
}
