import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { chainOf, declaredChains } from "../chains.mjs";

const CHAINS = { plugin: ["page.plugin.operation", "page.call", "host.binding.call"] };

/** A row of `log.query` in the shape of the answer. */
const row = (seq, event, cids, fields = {}) => ({ role: "host", boot: "b", file: "logs/host-b.jsonl", offset: seq, event: { seq, event, cids, fields } });

/**
 * A session whose host holds `log` and answers `log.query` by event, cid and since like the host does. `until` waits for the
 * next call of `announce`, which adds the rows of `later` and bumps the notices of `host.log`.
 */
function fakeSession({ log, later = [], failUntil = null }) {
  let notices = 0;
  const waiting = [];
  const session = {
    queries: [],
    client: {
      async request(method, query) {
        assert.equal(method, "log.query");
        session.queries.push(query);
        const rows = log.filter((item) => (query.event === undefined || item.event.event === query.event)
          && (query.cid === undefined || item.event.cids?.includes(query.cid))
          && (query.since?.["host-b"] === undefined || item.event.seq > query.since["host-b"]));
        return { rows, next: null, tail: { "host-b": log.at(-1)?.event.seq ?? 0 } };
      },
    },
    async get(name) {
      assert.equal(name, "host.log");
      return { notices };
    },
    until(name, predicate, message) {
      assert.equal(name, "host.log");
      if (failUntil !== null) return Promise.reject(new Error(`${message} (${failUntil})`));
      return new Promise((resolve) => waiting.push({ predicate, resolve }));
    },
    /** The host announces a change: the rows of `later` are in the log and the notice count grows. */
    announce() {
      log.push(...later.splice(0));
      notices += 1;
      for (const entry of waiting.splice(0)) {
        if (entry.predicate({ notices })) entry.resolve({ notices });
        else waiting.push(entry);
      }
    },
  };
  return session;
}

test("a chain whose events are all in the log is returned with its identifier at once", async () => {
  const s = fakeSession({ log: [row(1, "page.plugin.operation", ["p1.1"], { action: "install", plugin: "x" }), row(2, "page.call", ["p1.1"]), row(3, "host.binding.call", ["p1.1"])] });
  const { cid, events } = await chainOf(s, CHAINS, "plugin", { "host-b": 0 }, { action: "install", plugin: "x" });
  assert.equal(cid, "p1.1");
  assert.deepEqual(events.map((event) => event.event), ["page.plugin.operation", "page.call", "host.binding.call"]);
  assert.deepEqual(s.queries[0], { channel: "all", event: "page.plugin.operation", since: { "host-b": 0 } });
  assert.deepEqual(s.queries[1], { channel: "all", cid: "p1.1" });
});

test("a chain that lacks an event waits for the next notice of the host and completes with it", async () => {
  const s = fakeSession({ log: [row(1, "page.plugin.operation", ["p1.2"], { action: "remove", plugin: "x" })], later: [row(2, "page.call", ["p1.2"]), row(3, "host.binding.call", ["p1.2"])] });
  const found = chainOf(s, CHAINS, "plugin", {}, { action: "remove", plugin: "x" });
  // The first read finds the first event only, then the chain waits on the notice.
  await new Promise((resolve) => setImmediate(resolve));
  s.announce();
  assert.equal((await found).cid, "p1.2");
});

test("of two first events that match the fields the first in the log is the operation, and an event of another operation is not matched", async () => {
  // A second page can start its own operation with the same fields, as the page of a project window that opens does.
  const log = [row(1, "page.plugin.operation", ["p1.3"], { action: "install", plugin: "x" }), row(2, "page.plugin.operation", ["p1.4"], { action: "install", plugin: "x" }),
    row(3, "page.plugin.operation", ["p1.5"], { action: "install", plugin: "y" }), row(4, "page.call", ["p1.3"]), row(5, "host.binding.call", ["p1.3"])];
  const { cid } = await chainOf(fakeSession({ log }), CHAINS, "plugin", {}, { action: "install", plugin: "x" });
  assert.equal(cid, "p1.3");
});

test("a first event without cids is refused", async () => {
  const log = [row(1, "page.plugin.operation", undefined, { action: "install", plugin: "x" })];
  await assert.rejects(chainOf(fakeSession({ log }), CHAINS, "plugin", {}, { action: "install", plugin: "x" }), /page\.plugin\.operation has no cids/);
});

test("a chain that never completes fails with the events it lacks", async () => {
  const log = [row(1, "page.plugin.operation", ["p1.6"], { action: "install", plugin: "x" }), row(2, "page.call", ["p1.6"])];
  await assert.rejects(chainOf(fakeSession({ log, failUntil: "no notice" }), CHAINS, "plugin", {}, { action: "install", plugin: "x" }),
    /the log announced no further change; plugin of p1\.6 lacks host\.binding\.call; it holds page\.plugin\.operation, page\.call.*\(no notice\); plugin of p1\.6 lacks host\.binding\.call/);
});

test("the catalog must declare exactly the chains that this check and the input check perform", () => {
  const folder = mkdtempSync(join(tmpdir(), "soksak-chains-test-"));
  try {
    const write = (chains) => {
      const path = join(folder, "events.json");
      writeFileSync(path, JSON.stringify({ chains }));
      return path;
    };
    const names = ["input", "plugin", "project", "settings", "update", "window"];
    const six = Object.fromEntries(names.map((name) => [name, [`page.${name}`, "page.call", "host.binding.call"]]));
    assert.deepEqual(declaredChains(write(six)), six);
    assert.throws(() => declaredChains(write({ plugin: six.plugin })),
      /the catalog declares the chains plugin, and the checks perform input \(e2e\/input-records\.test\.mjs\), plugin, project, settings, update and window/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
