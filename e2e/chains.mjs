// The chains of the operations of the page in the event log (docs/spec/logging.md#operation-chains): the declared chains of the
// catalog, and the search of one chain in the log of a running application through `log.query`.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { within } from "@soksak/window-check/app.mjs";

const CATALOG = fileURLToPath(new URL("../docs/spec/events.json", import.meta.url));
/** The chains that the check performs. */
const PERFORMED = ["plugin", "project", "settings", "update", "window"];
/** The upper bound of the wait for the events of one chain; the wait ends at the notice that shows them. */
const CHAIN_LIMIT = 30_000;

/** The declared chains of the catalog: the name of each chain and its events, the first event first. */
export function declaredChains(path = CATALOG) {
  const { chains } = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(Object.keys(chains).toSorted(), PERFORMED,
    `the catalog declares the chains ${Object.keys(chains).join(", ")}, and this check performs ${PERFORMED.slice(0, -1).join(", ")} and ${PERFORMED.at(-1)}`);
  return chains;
}

/** All rows of a query, page by page. */
async function allRows(s, query) {
  const rows = [];
  for (let after; ;) {
    const page = await s.client.request("log.query", after === undefined ? query : { ...query, after });
    rows.push(...page.rows);
    if (page.next === null) return rows;
    after = page.next;
  }
}

/** The tail of the log now: the rows after it are the events of what the check does next. */
export async function tailOf(s) {
  const page = await s.client.request("log.query", { channel: "all", order: "desc", limit: 1 });
  return page.tail;
}

/**
 * Waits until the first event of the chain `name` that matches `fields` is in the log after `since` and every event that the
 * catalog declares for the chain carries its correlation identifier. The wait is on the notices of `host.log`; it ends with
 * the error that names the missing events when the limit passes. Returns the identifier and the events of the chain.
 */
export async function chainOf(s, chains, name, since, fields) {
  const [first, ...rest] = chains[name];
  let last = `no ${first} with ${JSON.stringify(fields)} was read`;
  const find = async () => {
    const starts = (await allRows(s, { channel: "all", event: first, since }))
      .filter((row) => Object.entries(fields).every(([key, value]) => row.event.fields?.[key] === value));
    if (starts.length === 0) return null;
    assert.equal(starts.length, 1, `${name}: ${starts.length} events ${first} match ${JSON.stringify(fields)}`);
    const [cid] = starts[0].event.cids ?? [];
    assert.ok(cid, `${name}: ${first} has no cids: ${JSON.stringify(starts[0].event)}`);
    const events = (await allRows(s, { channel: "all", cid })).map((row) => row.event);
    const seen = new Set(events.map((event) => event.event));
    const missing = rest.filter((event) => !seen.has(event));
    last = `${name} of ${cid} lacks ${missing.join(", ") || "nothing"}; it holds ${[...seen].join(", ")}`;
    return missing.length === 0 ? { cid, events } : null;
  };
  const search = async () => {
    for (; ;) {
      const before = await s.get("host.log");
      const found = await find();
      if (found !== null) return found;
      await s.until("host.log", (value) => value.notices > before.notices, `the log announced no further change; ${last}`);
    }
  };
  try {
    return await within(search(), CHAIN_LIMIT, `the chain ${name}`);
  } catch (error) {
    error.message += `; ${last}`;
    throw error;
  }
}
