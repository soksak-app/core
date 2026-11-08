// Checks the document region of a view surface on the layout probe fixture (e2e/fixtures/layout-probe): its site data lives in the
// configuration directory, a placement that keeps it in place does not hide it, it follows the color scheme of the host in its
// pixels and in its reported scheme, also while its card is hidden, and a quit with its tab reads the sessions of the tab once and
// calls no page after the window.
import assert from "node:assert/strict";
import { rmSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { currentEventOffsets, eventLine, readEvents, traceRows } from "@soksak/window-check/event-log.mjs";
import { frames, pixel, readFrame } from "@soksak/window-check/frame.mjs";
import { START_PLUGIN, fresh, probeSidebarSets } from "./fixture.mjs";

const LIGHT_DOCUMENT = [231, 233, 238];
const DARK_DOCUMENT = [21, 28, 42];
/** The content color that a probe document paints: the light colour in the light scheme and the dark colour in the dark scheme. */
const SCHEME_PAINT = `light-dark(rgb(${LIGHT_DOCUMENT.join(",")}), rgb(${DARK_DOCUMENT.join(",")}))`;
/** The computed content color of a probe document painted with SCHEME_PAINT in each scheme. */
const PAINTED = { light: `rgb(${LIGHT_DOCUMENT.join(", ")})`, dark: `rgb(${DARK_DOCUMENT.join(", ")})` };

/** Waits until the document of the region of the probe tab surface reported itself, and returns layoutprobe.document. */
const documentReported = (s, surface) => s.until("layoutprobe.document", (value) => value?.reported === true,
  `the document of ${surface} did not report`, { surface });

/** Paints the probe document of surface with SCHEME_PAINT and waits until it reports the colour of the scheme `mode`. */
async function paint(s, surface, mode) {
  await documentReported(s, surface);
  await s.run("layoutprobe.document.color", { color: SCHEME_PAINT }, surface);
  return s.until("layoutprobe.document", (value) => value.scheme === mode && value.color === PAINTED[mode],
    `the document of ${surface} did not report the ${mode} scheme and its colour`, { surface });
}

/** Sets the mode of the host theme and waits until the settings settled. */
async function mode(s, value) {
  await s.run("core.settings.set", { patch: { mode: value } });
  await s.until("core.settings", (settings) => settings.values.mode === value && !settings.saving, `host did not settle the ${value} theme`);
}

/**
 * The rectangle of the document region in window coordinates: the frame of the view of the surface in host.window and the
 * rectangle of the region element that layoutprobe.surface reports in the view.
 */
async function regionRect(s, surface) {
  const { region } = await s.get("layoutprobe.surface", surface);
  const view = (await s.get("host.window")).documents.find((item) => item.surface === surface && item.document === "");
  assert.ok(view, `host.window lists no view of ${surface}`);
  return { x: view.frame.x + region.x, y: view.frame.y + region.y, width: region.width, height: region.height };
}

/** Captures and reads the real window pixels at the center of the current document region. */
async function documentPixel(s, surface, at = (rect) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 })) {
  const rect = await regionRect(s, surface);
  const recording = await s.record();
  const { displayed } = await s.presented();
  const result = await recording.stop({ after: displayed });
  const captured = frames(result.frames);
  assert.ok(captured.length > 0, "document pixel capture produced no frames");
  const frame = readFrame(captured.at(-1));
  // Window coordinates are in points and the frame is in device pixels, so the frame is multiplied by the scale.
  const point = at(rect);
  const x = Math.floor(point.x * frame.scale);
  const y = Math.floor(point.y * frame.scale);
  assert.ok(x >= 0 && y >= 0 && x < frame.width && y < frame.height,
    `document sample ${x},${y} is outside ${frame.width}×${frame.height}`);
  const value = pixel(frame, x, y);
  rmSync(result.frames, { recursive: true, force: true });
  return value;
}

const nearColour = (actual, expected) => actual.every((value, index) => Math.abs(value - expected[index]) <= 3);

/** The native frame is in device pixels and the rectangle of the element is in CSS pixels, so a difference of up to one device pixel is allowed. */
const DEVICE_PIXEL = 0.5;

const near = (a, b) => ["x", "y", "width", "height"].every((key) => Math.abs(a[key] - b[key]) <= DEVICE_PIXEL);

/** Waits until the document region frame of host.window equals the rectangle of the region element. */
async function placed(s, surface, message) {
  await s.presented();
  const rect = await regionRect(s, surface);
  const state = await s.until("host.window", (w) => w.documents.some((d) =>
    d.surface === surface && d.document === "page" && d.visible && near(d.frame, rect)),
  `${message}: the document region did not take ${JSON.stringify(rect)}`);
  return { rect, state };
}

/** The card of the grid that holds the tab surface. */
const cardOf = (grid, surface) => grid.cards.find((card) => (card.tabs ?? []).some((tab) => tab.id === surface));

/** Waits until the new tab `tab` of the probe is visible and registered its document status. */
async function probeTab(s, tab) {
  await s.until("core.surfaces", (list) => list.some((item) => item.surface === tab && item.visible && item.status?.phase === "ready"),
    `the probe tab ${tab} did not become ready`);
  await s.registered(tab, ["status layoutprobe.document", "command layoutprobe.document.color"]);
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: document site data lives in the configuration directory`, async (t) => {
    const s = await open(t, app);
    const { surface } = await fresh(s);
    await documentReported(s, surface);
    const run = `${process.pid}-${Date.now()}`;
    await s.run("layoutprobe.document.store", { value: run }, surface);
    await s.until("layoutprobe.document", (value) => value.stored === run, "the document store did not keep the value", { surface });
    // The storage keeps site data inside the --config-dir of the running app (docs/spec/native-surfaces.md#document-regions).
    const directory = join(app.configDir, "document-data");
    let stat = null;
    try { stat = statSync(directory); } catch (error) { if (error.code !== "ENOENT") throw error; }
    assert.ok(stat?.isDirectory(), `the configuration directory has no document site data directory: ${directory}`);
  });

  test(`${app.name}: a placement that keeps a shown document in place does not hide it`, async (t) => {
    const s = await open(t, app);
    // The host records each applied surface placement as host.trace.surface while the performance trace is on.
    const { surface } = await fresh(s, { performanceTrace: true });
    await documentReported(s, surface);
    await placed(s, surface, "probe document");
    // The card sidebar of another card turns on and off: only that card and its surfaces move, and the document stays in place.
    const grid = await s.get("core.grid");
    const own = cardOf(grid, surface);
    const other = grid.cards.find((card) => !card.fixed && card.id !== own.id && (card.tabs ?? []).length > 0);
    assert.ok(other, `the start layout has no other card beside ${own.id}`);
    // The sets of environment.json replace the sets that the plugins declare (docs/spec/plugins.md#default-sidebar-sets), so the check
    // gives its sets the sections of the layout probe and shows the first.
    const set = (await probeSidebarSets(s))[0].id;
    s.cleanup(() => s.run("core.card.sidebar.set", { card: other.id, side: "left", set: "inherit" }));

    // A prepare request is applied inside the layer transaction of the window and does not appear on screen before the commit. While that, a surface that is visible on screen
    // is hidden, a press at its position goes to the page instead of the surface. Turning the inner sidebar of the other card on and off moves only the surfaces of that card
    // and the probe surface stays in place, so a layout request must not hide the probe surface.
    const offsets = currentEventOffsets(s.app.configDir);
    for (const shown of [set, "off", set]) {
      await s.run("core.card.sidebar.set", { card: other.id, side: "left", set: shown });
      await s.presented();
    }
    await s.flushLog();
    const placements = traceRows(readEvents(s.app.configDir, offsets).events)
      .filter((row) => row.layer === "host" && row.event === "surface" && row.phase === "placed");
    const others = placements.filter((row) => row.surface !== surface);
    assert.ok(others.length >= 3,
      `the card sidebar changes placed ${others.length} other surfaces among ${placements.length} placements: ${JSON.stringify(placements.slice(0, 10))}`);
    const hiding = placements.filter((row) => row.surface === surface && row.visible === false);
    assert.equal(hiding.length, 0, `a placement hid the shown probe surface: ${JSON.stringify(hiding[0])}`);
  });

  test(`${app.name}: documents follow host theme pixels for existing, new, and reloaded documents`, async (t) => {
    const s = await open(t, app);
    const { surface } = await fresh(s);
    await mode(s, "light");
    await paint(s, surface, "light");
    await placed(s, surface, "initial themed document");
    assert.ok(nearColour(await documentPixel(s, surface), LIGHT_DOCUMENT), "existing document did not render the light host theme");

    await mode(s, "dark");
    await s.until("layoutprobe.document", (value) => value.scheme === "dark" && value.color === PAINTED.dark,
      "existing document did not report the dark scheme", { surface });
    assert.ok(nearColour(await documentPixel(s, surface), DARK_DOCUMENT), "existing document did not render the dark host theme");

    await mode(s, "light");
    await s.until("layoutprobe.document", (value) => value.scheme === "light" && value.color === PAINTED.light,
      "existing document did not report the light scheme again", { surface });
    assert.ok(nearColour(await documentPixel(s, surface), LIGHT_DOCUMENT), "existing document did not return to the light host theme");

    const { tab: added } = await s.run("core.card.split", { card: cardOf(await s.get("core.grid"), surface).id, side: "right", plugin: START_PLUGIN });
    await probeTab(s, added);
    await paint(s, added, "light");
    await placed(s, added, "new themed document");
    assert.ok(nearColour(await documentPixel(s, added), LIGHT_DOCUMENT), "new document did not inherit the light host theme");

    await mode(s, "dark");
    await s.run("host.window.reload");
    await s.until("core.window.workbench", (workbench) => workbench.readyState === "complete", "the workbench did not start again");
    const shown = (item) => item.kind === "tab" && item.plugin === START_PLUGIN && item.visible && item.status?.phase === "ready";
    const restored = (await s.until("core.surfaces", (list) => list.some(shown), "reloaded probe document did not restore")).filter(shown);
    const restoredSurface = restored.find((item) => item.surface === surface)?.surface ?? restored[0].surface;
    await probeTab(s, restoredSurface);
    await paint(s, restoredSurface, "dark");
    await placed(s, restoredSurface, "reloaded themed document");
    const restoredPixel = await documentPixel(s, restoredSurface);
    assert.ok(nearColour(restoredPixel, DARK_DOCUMENT), `reloaded document did not retain the dark host theme: ${JSON.stringify(restoredPixel)}`);
  });

  test(`${app.name}: a document's own appearance remains independent of the host theme`, async (t) => {
    const s = await open(t, app);
    const { surface } = await fresh(s);
    await mode(s, "light");
    const reported = await s.until("layoutprobe.document", (value) => value.reported && value.scheme === "light",
      "the document did not report the light color scheme", { surface });
    // The document paints a colour that it decides on its own, regardless of the color scheme.
    await s.run("layoutprobe.document.color", { color: "rgb(120,60,30)" }, surface);
    await s.until("layoutprobe.document", (value) => value.color === "rgb(120, 60, 30)", "the document did not paint its own colour", { surface });
    await placed(s, surface, "fixed document");
    const light = await documentPixel(s, surface);
    // On failure it reports the pixels at the sample point and the corner, the owner of the point, the document region, the app mode and the document state together.
    const rect = await regionRect(s, surface);
    const sample = { x: Math.floor(rect.x + rect.width / 2), y: Math.floor(rect.y + rect.height / 2) };
    const measuredLight = { light, sample, hit: await s.run("host.hit", sample),
      corner: await documentPixel(s, surface, (r) => ({ x: r.x + 4, y: r.y + 4 })),
      region: (await s.get("host.window")).documents.find((d) => d.surface === surface && d.document === "page"),
      mode: (await s.get("core.settings")).values.mode,
      document: await s.get("layoutprobe.document", surface) };
    await mode(s, "dark");
    await s.until("layoutprobe.document", (value) => value.scheme === "dark", "the region did not receive the dark color scheme", { surface });
    const dark = await documentPixel(s, surface);
    // The contract is that the app mode does not change the appearance that a document decides on its own, and the
    // prefers-color-scheme of the document region follows the app mode.
    assert.ok(nearColour(light, [120, 60, 30]), `the fixed document did not show its own colour: ${JSON.stringify(measuredLight)}`);
    assert.deepEqual(dark, light, `the document's own appearance was overwritten by the host theme: ${JSON.stringify({ ...measuredLight, dark })}`);
    assert.equal((await s.get("layoutprobe.document", surface)).url, reported.url, "host theme change must not change the document address");
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a change of the color scheme reaches the document of a card at once`, async (t) => {
    const s = await open(t, app);
    const { surface } = await fresh(s);
    await mode(s, "light");
    await s.until("layoutprobe.document", (value) => value.reported && value.scheme === "light",
      "the document did not report the light scheme", { surface });
    await s.run("core.settings.set", { patch: { mode: "dark" } });
    await s.until("layoutprobe.document", (value) => value.scheme === "dark",
      "the document of a visible card kept the light scheme after the setting changed to dark", { surface });
    await s.run("core.settings.set", { patch: { mode: "light" } });
    await s.until("layoutprobe.document", (value) => value.scheme === "light",
      "the document of a visible card kept the dark scheme after the setting changed to light", { surface });
  });
}

// A card that is hidden by the full screen of another card also has the new scheme when it is shown again.
for (const app of Object.values(APPS)) {
  test(`${app.name}: a change of the color scheme reaches the document of a hidden card`, async (t) => {
    const s = await open(t, app);
    const { surface } = await fresh(s);
    await mode(s, "light");
    await s.until("layoutprobe.document", (value) => value.reported && value.scheme === "light",
      "the document did not report the light scheme", { surface });
    const { card } = await s.run("core.card.split", { card: cardOf(await s.get("core.grid"), surface).id, side: "right", plugin: START_PLUGIN });
    await s.run("core.card.fullscreen", { card });
    await s.until("host.window", (state) => state.documents.every((item) => item.surface !== surface || !item.visible),
      "the document of the other card was not hidden by the full screen");
    await mode(s, "dark");
    await s.run("core.card.fullscreen", { card });
    await s.until("host.window", (state) => state.documents.some((item) => item.surface === surface && item.visible),
      "the document was not shown again after the full screen ended");
    await s.until("layoutprobe.document", (value) => value.scheme === "dark",
      "the document of a card that was hidden kept the light scheme after it was shown again", { surface });
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a quit with a document region tab reads its sessions once and calls no page after the window`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    const reads = ["workbench.tab.session.read", "host.binding.call"];
    const { surface } = await fresh(s, { log: { lifecycle: "debug", call: "debug" }, reads });
    await documentReported(s, surface);
    await placed(s, surface, "quit document");
    await s.flushLog();
    const before = currentEventOffsets(app.configDir);
    const previous = s.client.endpoint.pid;
    await s.relaunch();
    const { pid } = s.client.endpoint;
    // The files of the new process start at their current end, so the events read are those of the process that quit.
    const offsets = { ...before, ...Object.fromEntries(Object.entries(currentEventOffsets(app.configDir))
      .filter(([name]) => name.endsWith(`-${pid}.jsonl`) || name.endsWith(`-${pid}.debug.jsonl`))) };
    const { events } = readEvents(app.configDir, offsets);
    const sessionReads = events.filter((event) => event.event === "workbench.tab.session.read" && event.fields?.tab === surface)
      .map((event) => event.fields.cause);
    assert.deepEqual(sessionReads.filter((cause) => cause === "flush"), ["flush"],
      `process ${previous} read the sessions of ${surface} at its quit with the causes ${JSON.stringify(sessionReads)}`);
    const failed = events.filter((event) => event.event === "host.binding.call" && event.level === "warn").map(eventLine);
    assert.deepEqual(failed, [], `process ${previous} answered a page call as failed at its quit`);
  });
}
