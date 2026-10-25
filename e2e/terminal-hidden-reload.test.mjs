// A hidden terminal keeps its sidecar session across a main-page reload. The host owner tests establish the exact detach
// acknowledgement barrier; this window check verifies that the app keeps the session headless and presents a new image
// generation when the terminal is shown again.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { EVERY_LEVEL } from "@soksak/window-check/log-policy.mjs";
import { allRows, tailOf } from "./chains.mjs";
import { fresh } from "./fixture.mjs";
import { ensureTerminals } from "./terminal-screen.mjs";

const READS = ["page.start", "page.background.session", "sidecar.vt.request", "sidecar.vt.surface_mode"];

async function waitForRows(s, since, predicate, description) {
  let last = [];
  for (;;) {
    const previous = await s.get("host.log");
    last = await allRows(s, { channel: "all", since });
    if (predicate(last)) return last;
    await s.until("host.log", (value) => value.notices > previous.notices,
      `${description}; observed ${JSON.stringify(last.map((row) => row.event))}`);
  }
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a hidden terminal session detaches and reattaches its image across reload`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    const fixtureStart = await tailOf(s);
    await fresh(s, { settings: { memorySaver: false }, log: EVERY_LEVEL, reads: READS });
    const [terminal] = await ensureTerminals(s, 1);
    const surface = terminal.surface;
    const beforeSession = await s.until("terminal.session", (state) => Boolean(state?.sessionId),
      "the terminal session did not open", { surface });
    const initialModes = await waitForRows(s, fixtureStart, (items) => items.some((row) =>
      row.event.event === "sidecar.vt.surface_mode" && row.event.surface === surface && row.event.fields.mode === "image"),
    `terminal ${surface} never entered image mode`);
    const initialImages = initialModes.filter((row) => row.event.event === "sidecar.vt.surface_mode"
      && row.event.surface === surface && row.event.fields.mode === "image");
    assert.ok(initialImages.length > 0, `terminal ${surface} has no image-mode event before hiding`);

    const grid = await s.get("core.grid");
    const card = grid.cards.find((item) => item.tabs.some((tab) => tab.id === surface));
    assert.ok(card, `no card holds terminal ${surface}`);
    await s.run("core.card.add-tab", { card: card.id, plugin: "browser" });
    await s.until("core.surfaces", (items) => items.some((item) => item.visible && item.plugin === "browser"),
      "the browser tab did not hide the terminal");
    await s.until("host.window", (host) => host.regions.some((item) => item.surface === surface && item.name === "view"
      && item.visible === false), `terminal ${surface} remained visible`);
    const hiddenRegion = (await s.get("host.window")).regions.find((item) => item.surface === surface && item.name === "view");
    assert.ok(hiddenRegion, `hidden terminal ${surface} has no retained native region`);
    assert.equal(hiddenRegion.visible, false, `terminal ${surface} is not hidden: ${JSON.stringify(hiddenRegion)}`);
    assert.ok(hiddenRegion.presented, `hidden terminal ${surface} never presented its old image: ${JSON.stringify(hiddenRegion)}`);
    assert.ok(Number.isSafeInteger(hiddenRegion.presented.generation) && hiddenRegion.presented.generation > 0,
      `hidden terminal ${surface} has no presented attachment generation: ${JSON.stringify(hiddenRegion.presented)}`);
    const oldGeneration = hiddenRegion.presented.generation;

    const since = await tailOf(s);
    const oldDocument = (await s.get("core.window.document")).timeOrigin;
    await s.run("host.window.reload");
    const document = await s.until("core.window.document", (value) => value.timeOrigin !== oldDocument
      && value.readyState === "complete", "the replacement main document did not complete");
    const replacementPage = String(document.timeOrigin);
    let rows = await waitForRows(s, since, (items) => items.some((row) => row.event.event === "page.start"
      && row.event.fields.time_origin === document.timeOrigin), "the replacement page did not record page.start");
    const start = rows.find((row) => row.event.event === "page.start" && row.event.fields.time_origin === document.timeOrigin);
    assert.ok(start, `no page.start for ${replacementPage}`);

    rows = await waitForRows(s, since, (items) => items.some((row) => row.event.event === "page.background.session"
      && row.event.fields.tab === surface && row.event.fields.action === "open" && row.event.fields.surface === "absent")
      && items.some((row) => row.event.event === "sidecar.vt.surface_mode" && row.event.surface === surface
        && row.event.fields.mode === "headless"), `the hidden terminal ${surface} did not open headless`);
    const background = rows.find((row) => row.event.event === "page.background.session" && row.event.fields.tab === surface
      && row.event.fields.action === "open" && row.event.fields.surface === "absent");
    const headless = rows.find((row) => row.event.event === "sidecar.vt.surface_mode" && row.event.surface === surface
      && row.event.fields.mode === "headless");
    assert.ok(background && headless, "the replacement page did not open the hidden session headless");
    const replacementSession = await s.until("terminal.session", (state) => state?.sessionId === beforeSession.sessionId,
      "the page reload replaced the terminal session", { surface });
    assert.equal(replacementSession.sessionId, beforeSession.sessionId);

    rows = await waitForRows(s, since, (items) => {
      const headlessMode = items.find((row) => row.event.event === "sidecar.vt.surface_mode" && row.event.surface === surface
        && row.event.fields.mode === "headless");
      return headlessMode && items.some((row) => row.event.event === "sidecar.vt.surface_mode" && row.event.surface === surface
        && row.event.fields.mode === "image" && row.event.seq > headlessMode.event.seq);
    }, `the hidden terminal ${surface} did not transition from headless back to image mode`);
    const headlessMode = rows.find((row) => row.event.event === "sidecar.vt.surface_mode" && row.event.surface === surface
      && row.event.fields.mode === "headless");
    const reattachedMode = rows.find((row) => row.event.event === "sidecar.vt.surface_mode" && row.event.surface === surface
      && row.event.fields.mode === "image" && row.event.seq > headlessMode.event.seq);
    assert.ok(reattachedMode, "the sidecar did not record image mode after headless mode");

    await s.run("core.tab.select", { tab: surface });
    const attached = await s.until("host.window", (host) => host.regions.find((item) => item.surface === surface
      && item.name === "view" && item.visible && item.presented && item.presented.generation !== oldGeneration),
    "the revealed terminal did not present an image from a new attachment generation");
    const newRegion = attached.regions.find((item) => item.surface === surface && item.name === "view");
    assert.ok(newRegion.presented.generation > oldGeneration,
      `terminal ${surface} attachment generation did not increase from ${oldGeneration}: ${JSON.stringify(newRegion.presented)}`);
    assert.equal((await s.get("terminal.session", surface)).sessionId, beforeSession.sessionId,
      "revealing the terminal replaced its sidecar session");

    await s.flushLog();
    rows = await allRows(s, { channel: "all", since });
    const failedCalls = rows.filter(({ event }) => ["page.call", "page.command", "host.binding.call", "host.endpoint.call"]
      .includes(event.event) && event.fields?.ok === false);
    assert.deepEqual(failedCalls, [], `reload and reveal produced failed runtime calls: ${JSON.stringify(failedCalls)}`);
    const errors = rows.filter(({ event }) => event.level === "error");
    assert.deepEqual(errors, [], `reload and reveal produced host, page, or supplier errors: ${JSON.stringify(errors)}`);
    assert.equal(await s.get("core.page.error"), null, "the reload or reveal displayed a page error");
    t.diagnostic(`${app.name}: page.start ${JSON.stringify(start.event.fields.time_origin)}, sidecar seq ${headlessMode.event.seq}->${reattachedMode.event.seq}, attachment generation ${oldGeneration}->${newRegion.presented.generation}, session ${beforeSession.sessionId}`);
  });
}
