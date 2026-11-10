import assert from "node:assert/strict";
import test from "node:test";
import { prepareRasterSession, RASTER } from "../raster-probe.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("service shutdown preparation waits for surface and session notifications", async () => {
  const watches = [];
  const requests = [];
  const watchEntered = [deferred(), deferred()];
  let tabAdded = false;
  const client = {
    request: async (method, params) => {
      requests.push({ method, params });
      if (method === "diagnostics.fixture") return null;
      if (method === "status.get" && params.name === "core.grid") {
        return { cards: [{ id: "card-a", focused: false, tabs: [] }, { id: "card-b", focused: true, tabs: [] }] };
      }
      if (method === "command.run" && params.name === "core.card.add-tab") {
        assert.deepEqual(params.params, { card: "card-b", plugin: RASTER }, "the raster probe tab was not added to the focused card");
        tabAdded = true;
        return { tab: "tab-raster" };
      }
      throw new Error(`unexpected request ${method} ${JSON.stringify(params)}`);
    },
    watch: (window, name, predicate, options) => {
      const ready = deferred();
      const index = watches.push({ window, name, predicate, options, ready }) - 1;
      watchEntered[index]?.resolve();
      return ready.promise;
    },
  };

  const prepared = prepareRasterSession(client, (connection, method, params) => connection.request(method, params));
  const outcome = prepared.then((value) => ({ value }), (error) => ({ error }));
  const first = await Promise.race([watchEntered[0].promise.then(() => "watch"), outcome.then(() => "finished")]);
  assert.equal(first, "watch", "preparation finished without waiting for a status notification");
  assert.equal(tabAdded, true, "the surface watch started before the raster probe tab was added");
  assert.equal(watches[0].window, "main");
  assert.equal(watches[0].name, "core.surfaces");
  assert.equal(watches[0].options, undefined, "the surface watch has no time limit");
  assert.equal(watches[0].predicate([{ plugin: RASTER, visible: false, surface: "tab-raster" }]), false);
  assert.equal(watches[0].predicate([{ plugin: RASTER, visible: true, surface: "tab-other" }]), false);
  const visible = [{ plugin: RASTER, visible: true, surface: "tab-raster" }];
  assert.equal(watches[0].predicate(visible), true);
  assert.equal(watches.length, 1, "the session watch started before a visible surface notification");
  watches[0].ready.resolve(visible);

  const second = await Promise.race([watchEntered[1].promise.then(() => "watch"), outcome.then(() => "finished")]);
  assert.equal(second, "watch", "preparation polled session readiness instead of waiting for its notification");
  assert.equal(watches[1].window, "main");
  assert.equal(watches[1].name, "rasterprobe.session");
  assert.deepEqual(watches[1].options, { surface: "tab-raster" }, "the session watch has no time limit");
  assert.equal(watches[1].predicate({ session: null, connected: false, failure: null, error: null }), false);
  assert.equal(watches[1].predicate({ session: "session-1", connected: false, failure: "closed", error: null }), false);
  assert.equal(watches[1].predicate({ session: "session-1", connected: true, failure: null, error: "open failed" }), false);
  const readySession = { session: "session-1", connected: true, failure: null, error: null };
  assert.equal(watches[1].predicate(readySession), true);
  watches[1].ready.resolve(readySession);

  assert.deepEqual(await outcome, { value: { surface: "tab-raster", session: "session-1" } });
  assert.equal(requests.some(({ method, params }) => method === "status.get" && params.name === "core.surfaces"), false,
    "surface readiness was polled");
  assert.equal(requests.some(({ method, params }) => method === "status.get" && params.name === "rasterprobe.session"), false,
    "session readiness was polled");
});

test("service shutdown preparation refuses a fixture without a focused card", async () => {
  const client = {
    request: async (method, params) => {
      if (method === "diagnostics.fixture") return null;
      if (method === "status.get" && params.name === "core.grid") return { cards: [{ id: "card-a", focused: false, tabs: [] }] };
      throw new Error(`unexpected request ${method} ${JSON.stringify(params)}`);
    },
    watch: () => { throw new Error("no watch is expected without a focused card"); },
  };
  await assert.rejects(prepareRasterSession(client, (connection, method, params) => connection.request(method, params)),
    /no focused card for a raster probe tab/);
});
