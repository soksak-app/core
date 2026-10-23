import assert from "node:assert/strict";
import test from "node:test";
import { prepareTerminal } from "../prepare-terminal.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("terminal shutdown preparation waits for surface and session notifications", async () => {
  const watches = [];
  const requests = [];
  const watchEntered = [deferred(), deferred()];
  let inputSent = false;
  let surfaceReads = 0;
  const client = {
    request: async (method, params) => {
      requests.push({ method, params });
      if (method === "status.get" && params.name === "core.surfaces") {
        surfaceReads += 1;
        return surfaceReads === 1 ? [] : [{ plugin: "terminal", visible: true, surface: "tab-terminal" }];
      }
      if (method === "status.get" && params.name === "core.grid") {
        return { cards: [{ tabs: [{ id: "tab-terminal", plugin: "terminal" }] }] };
      }
      if (method === "status.get" && params.name === "terminal.session") return { sessionId: "session-1" };
      if (method === "diagnostics.fixture") return null;
      if (method === "command.run" && params.name === "core.tab.select") return null;
      if (method === "command.run" && params.name === "terminal.input") {
        inputSent = true;
        return null;
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

  const prepared = prepareTerminal(client, (connection, method, params) => connection.request(method, params), { startupLimit: 15_000 });
  const outcome = prepared.then((value) => ({ value }), (error) => ({ error }));
  const first = await Promise.race([watchEntered[0].promise.then(() => "watch"), outcome.then(() => "finished")]);
  assert.equal(first, "watch", "preparation finished without waiting for a status notification");
  assert.equal(inputSent, false, "terminal input was sent before a visible surface notification");
  assert.equal(watches[0].window, "main");
  assert.equal(watches[0].name, "core.surfaces");
  assert.equal(watches[0].options.timeout, 15_000);
  const visible = [{ plugin: "terminal", visible: true, surface: "tab-terminal" }];
  assert.equal(watches[0].predicate(visible), true);
  watches[0].ready.resolve(visible);

  const second = await Promise.race([watchEntered[1].promise.then(() => "watch"), outcome.then(() => "finished")]);
  assert.equal(second, "watch", "preparation polled session readiness instead of waiting for its notification");
  assert.equal(inputSent, true, "terminal input was not sent after surface registration");
  assert.equal(watches[1].window, "main");
  assert.equal(watches[1].name, "terminal.session");
  assert.equal(watches[1].options.surface, "tab-terminal");
  assert.equal(watches[1].options.timeout, 15_000);
  const readySession = { sessionId: "session-1" };
  assert.equal(watches[1].predicate(readySession), true);
  watches[1].ready.resolve(readySession);

  assert.deepEqual(await outcome, { value: { surface: "tab-terminal", sessionId: "session-1" } });
  assert.equal(requests.filter(({ method, params }) => method === "status.get" && params.name === "core.surfaces").length, 1,
    "surface readiness was polled");
  assert.equal(requests.some(({ method, params }) => method === "status.get" && params.name === "terminal.session"), false,
    "session readiness was polled");
});
