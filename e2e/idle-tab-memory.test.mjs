// An idle browser tab costs at most 50 MB: the footprint of the web content process of its document plus the increase of the
// main web view, read from the sampler of the trace (`host.sampler.memory`, docs/spec/performance-trace.md) through `log.query`.
// The page is a blank local page, so the bound covers the tab and not the content of a site.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { APPS, open, within } from "@soksak/window-check/app.mjs";
import { allRows, tailOf } from "./chains.mjs";
import { fresh } from "./fixture.mjs";

const BOUND_KB = 50 * 1024;
/** Two consecutive readings of the document process that differ by less than this are a settled footprint. */
const SETTLED_KB = 1024;
/** The upper bound of the wait for settled readings; the sampler reads every five seconds. */
const SETTLE_LIMIT = 120_000;

/** A loopback server of one blank page. It is closed when the check ends. */
async function serve(s) {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end("<!doctype html><title>blank</title>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  s.cleanup(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}/blank`;
}

/**
 * Waits on the notices of `host.log` until `pick` returns a value from the sampler readings stored after `since`, and returns it.
 * The sampler stores a reading every five seconds while the trace is on, so the readings arrive at that interval.
 */
async function readings(s, since, pick, label) {
  let last = "no reading was read";
  const search = async () => {
    for (; ;) {
      const before = await s.get("host.log");
      const rows = (await allRows(s, { channel: "all", event: "host.sampler.memory", since })).map((row) => row.event.fields);
      const found = pick(rows);
      if (found.value !== undefined) return found.value;
      last = found.state;
      await s.until("host.log", (value) => value.notices > before.notices, `the log announced no further change; ${last}`);
    }
  };
  try {
    return await within(search(), SETTLE_LIMIT, label);
  } catch (error) {
    error.message += `; ${last}`;
    throw error;
  }
}

/** The footprint of the readings that `match` selects once two consecutive readings differ by less than SETTLED_KB. */
const settledOf = (name, match) => (rows) => {
  const footprints = rows.filter((fields) => match(fields) && Number.isInteger(fields.footprint_kb)).map((fields) => fields.footprint_kb);
  const [previous, current] = footprints.slice(-2);
  return {
    value: footprints.length >= 2 && Math.abs(current - previous) < SETTLED_KB ? current : undefined,
    state: `readings of ${name}: ${footprints.join(" ")} KB`,
  };
};

for (const app of Object.values(APPS)) {
  test(`${app.name}: an idle browser tab on a blank page costs at most 50 MB`, { timeout: 300000 }, async (t) => {
    const s = await open(t, app);
    // The sampler stores its readings at the level debug of the class call, which the default policy does not store.
    await fresh(s, { performanceTrace: true, log: { call: "debug" }, reads: ["host.sampler.memory"] });
    const url = await serve(s);
    await s.until("core.surfaces",
      (list) => list.some((x) => x.visible && x.plugin === "browser" && x.exposes.includes("status browser.location")),
      "no visible browser surface registered browser.location");
    const grid = await s.get("core.grid");
    const card = grid.cards.find((c) => c.active);
    assert.ok(card, "the grid has no active card");

    const main = settledOf(`the main web view of ${s.window}`, (fields) => fields.role === "page" && fields.window === s.window);
    const mainBefore = await readings(s, await tailOf(s), main, "the settled main web view before the tab");
    const { tab } = await s.run("core.card.split", { card: card.id, side: "right", plugin: "browser" });
    s.cleanup(() => s.run("core.tab.close", { tab }));
    await s.until("core.surfaces", (list) => list.some((x) => x.surface === tab && x.exposes.includes("status browser.location")),
      "the new browser surface did not register");
    await s.run("browser.navigate", { url }, tab);
    await s.until("browser.location", (at) => at.url === url && !at.loading && at.error === null && at.title === "blank",
      `surface ${tab} did not load ${url}`, { surface: tab });
    const loaded = await tailOf(s);
    const settled = await readings(s, loaded, settledOf(`the document of ${tab}`, (fields) => fields.role === "document" && fields.surface === tab),
      "the settled document of the tab");
    const mainAfter = await readings(s, loaded, main, "the settled main web view after the tab");
    const growth = mainAfter - mainBefore;
    const cost = settled + growth;
    t.diagnostic(`document ${settled} KB; main web view ${mainBefore} -> ${mainAfter} KB (${growth} KB); cost ${cost} KB`);
    assert.ok(cost <= BOUND_KB,
      `the idle tab costs ${cost} KB: document ${settled} KB plus main web view growth ${growth} KB is over ${BOUND_KB} KB`);
  });
}
