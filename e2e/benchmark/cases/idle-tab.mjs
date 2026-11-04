// The cost of an idle browser tab on a blank page, shared by the idle tab window check (e2e/idle-tab-memory.test.mjs) and its benchmark
// (e2e/benchmark/idle-tab.test.mjs). The cost is the footprints of the web content processes of its documents, the page of its view
// and its document region, plus the growth of the process that draws the window: the main web view of a window with a page process,
// and the host process of a window whose host.window reports pageProcess null, which the mygo host draws in its own process. Both
// are read from the sampler of the trace (`host.sampler.memory`, docs/spec/performance-trace.md) through `log.query`. The page is a
// blank local page, so the cost covers the tab and not the content of a site.
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { within } from "@soksak/window-check/app.mjs";
import { allRows, tailOf } from "../../chains.mjs";
import { fresh } from "../../fixture.mjs";
import { b3Conditions, fixtureSettings } from "./b3-run.mjs";
import { B3_SETTINGS } from "../measurements.mjs";
import { performanceGoalBound } from "./performance-goals.mjs";

/** The limit (KB) of the cost of an idle tab: the footprint of its documents plus the growth of the process that draws the window. */
export const IDLE_TAB_BOUND_KB = performanceGoalBound("IDLE_TAB_BOUND_KB", "atMost");
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

/** The last of the footprints once its two last readings differ by less than SETTLED_KB, or undefined before. */
const settledFootprint = (footprints) => {
  const [previous, current] = footprints.slice(-2);
  return footprints.length >= 2 && Math.abs(current - previous) < SETTLED_KB ? current : undefined;
};

/** The footprint of the readings that `match` selects once it is settled. */
const settledOf = (name, match) => (rows) => {
  const footprints = rows.filter((fields) => match(fields) && Number.isInteger(fields.footprint_kb)).map((fields) => fields.footprint_kb);
  return { value: settledFootprint(footprints), state: `readings of ${name}: ${footprints.join(" ")} KB` };
};

/**
 * The process whose growth the idle tab counts for the window `window` whose host.window reports `pageProcess`: `of` names it, and
 * `settled(rows)` picks its settled footprint from the sampler rows. A window without a page process (null) counts the reading of
 * the host process, the row that holds `rss_host_kb`; a window with one counts the `page` row of the window.
 */
export function idleTabGrowth({ window, pageProcess }) {
  if (pageProcess === null) {
    return { of: "host process", settled: settledOf("the host process", (fields) => Number.isInteger(fields.rss_host_kb)) };
  }
  if (!Number.isSafeInteger(pageProcess) || pageProcess <= 0) {
    throw new Error(`host.window of ${window} reports pageProcess ${pageProcess}, neither a process id nor null`);
  }
  return { of: "main web view", settled: settledOf(`the main web view of ${window}`, (fields) => fields.role === "page" && fields.window === window) };
}

/** The sum of the footprints of the documents that `match` selects once the footprint of each document is settled. */
export const settledDocumentsOf = (name, match) => (rows) => {
  const documents = new Map();
  for (const fields of rows) {
    if (!match(fields) || !Number.isInteger(fields.footprint_kb)) continue;
    if (!documents.has(fields.document)) documents.set(fields.document, []);
    documents.get(fields.document).push(fields.footprint_kb);
  }
  const settled = [...documents.values()].map(settledFootprint);
  return {
    value: settled.length > 0 && settled.every((value) => value !== undefined) ? settled.reduce((sum, value) => sum + value, 0) : undefined,
    state: `readings of ${name}: ${[...documents].map(([document, footprints]) => `${document} ${footprints.join(" ")}`).join("; ")} KB`,
  };
};

/**
 * Opens a browser tab on the blank page in the active card and returns the settled documents of the tab, the process whose growth
 * counts (`growthOf`, idleTabGrowth), its footprint before and after the tab, its growth and the cost (documents plus growth), the
 * footprints in KB, and the B3 conditions of the prepared window. The tab must load the page and every reading must settle, or the
 * recording fails.
 */
export async function recordIdleTab(s) {
  await fresh(s, { ...fixtureSettings(B3_SETTINGS["idle-tab"]), reads: ["host.sampler.memory"] });
  const conditions = await b3Conditions(s, B3_SETTINGS["idle-tab"]);
  const url = await serve(s);
  await s.until("core.surfaces",
    (list) => list.some((x) => x.visible && x.plugin === "browser" && x.exposes.includes("status browser.location")),
    "no visible browser surface registered browser.location");
  const grid = await s.get("core.grid");
  const card = grid.cards.find((c) => c.active);
  assert.ok(card, "the grid has no active card");

  const growthOf = idleTabGrowth({ window: s.window, pageProcess: (await s.get("host.window")).pageProcess });
  const growthBefore = await readings(s, await tailOf(s), growthOf.settled, `the settled ${growthOf.of} before the tab`);
  const { tab } = await s.run("core.card.split", { card: card.id, side: "right", plugin: "browser" });
  s.cleanup(() => s.run("core.tab.close", { tab }));
  await s.until("core.surfaces", (list) => list.some((x) => x.surface === tab && x.exposes.includes("status browser.location")),
    "the new browser surface did not register");
  await s.run("browser.navigate", { url }, tab);
  await s.until("browser.location", (at) => at.url === url && !at.loading && at.error === null && at.title === "blank",
    `surface ${tab} did not load ${url}`, { surface: tab });
  const loaded = await tailOf(s);
  const settled = await readings(s, loaded,
    settledDocumentsOf(`the documents of ${tab}`, (fields) => fields.role === "document" && fields.surface === tab),
    "the settled documents of the tab");
  const growthAfter = await readings(s, loaded, growthOf.settled, `the settled ${growthOf.of} after the tab`);
  const growth = growthAfter - growthBefore;
  return { settled, growthOf: growthOf.of, growthBefore, growthAfter, growth, cost: settled + growth, conditions };
}

/**
 * Fails when the cost of the idle tab is over IDLE_TAB_BOUND_KB. A cost that is not a finite number is rejected rather than compared.
 */
export function assertIdleTabWithinBound({ settled, growthOf, growth, cost }) {
  if (!Number.isFinite(cost)) throw new TypeError(`the idle tab cost must be a finite number of KB, found ${cost}`);
  if (cost > IDLE_TAB_BOUND_KB) {
    throw new Error(`the idle tab costs ${cost} KB: documents ${settled} KB plus ${growthOf} growth ${growth} KB is over ${IDLE_TAB_BOUND_KB} KB`);
  }
}

/** The B3 values of a recorded idle tab (e2e/benchmark/idle-tab.test.mjs): the cost and its document part, in KB. */
export function idleTabB3Values({ settled, cost }) {
  return { idleTabCostKb: cost, documentPartKb: settled };
}
