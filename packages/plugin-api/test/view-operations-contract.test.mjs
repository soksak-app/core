// Runs the published API observations (packages/plugin-api/contract/view-operations.json) against runtime.beginOperation,
// runtime.sidecar(name).send and runtime.command of createViewBridge over a surface view. It observes plugin log events after
// the current clock/batch writer transport and compares non-log calls without their transport ids.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createViewBridge } from "../view.js";

const CONTRACT = JSON.parse(readFileSync(new URL("../contract/view-operations.json", import.meta.url), "utf8"));
const EXPECTED_IDS = [
  "view.operation.begin-logs-first-event-and-carries-cids",
  "view.operation.each-begin-takes-the-next-identifier",
];
// The time origin of the page that the view module reads: the identifiers of the output name it as $ORIGIN.
const ORIGIN = Math.round(performance.timeOrigin);
const IDENTIFIER = /^p\d+\.\d+$/;

const normalize = (value) => JSON.parse(JSON.stringify(value).replaceAll(`p${ORIGIN}.`, "p$ORIGIN."));

async function runCase(testCase) {
  const dom = new JSDOM("", { url: "soksak://probe/", runScripts: "outside-only" });
  const logs = [];
  const requests = [];
  const waiters = [];
  const reports = [];
  let protocolError = null;
  // The view module reads the global window, which Node does not define; the test defines it for the case only.
  Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true, writable: true });
  try {
    dom.window.webkit = { messageHandlers: { "sok-view": { postMessage: () => {} } } };
    dom.window.eval(readFileSync(new URL("../view-start.js", import.meta.url), "utf8"));
    // A host message is a window message event whose source is the window.
    const host = (data) => dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data, source: dom.window }));
    const observe = (collection, value) => {
      collection.push(value);
      for (let index = waiters.length - 1; index >= 0; index -= 1) {
        const waiter = waiters[index];
        if (waiter.collection === collection && waiter.predicate(value)) {
          waiters.splice(index, 1);
          waiter.resolve(value);
        }
      }
    };
    const failWaiters = (error) => {
      protocolError = error;
      for (const waiter of waiters.splice(0)) waiter.reject(error);
    };
    const waitFor = (collection, predicate) => {
      if (protocolError !== null) return Promise.reject(protocolError);
      const found = collection.find(predicate);
      if (found !== undefined) return Promise.resolve(found);
      return new Promise((resolve, reject) => waiters.push({ collection, predicate, resolve, reject }));
    };
    const postMessage = (message) => {
      assert.equal(message.sok, 1, "a view request uses the sok envelope");
      if (message.command === "runtime.log") {
        if (message.params?.action === "clock") {
          queueMicrotask(() => host({ sok: 1, id: message.id, result: { ts_us: 1_000_000, mono_ns: 1_000_000_000 } }));
        } else if (message.params?.action === "batch") {
          const batchLogs = [];
          for (const event of message.params.events) {
            if (event.event.startsWith("plugin.")) {
              batchLogs.push({ level: event.level, event: event.event, fields: event.fields, ...(event.cids === undefined ? {} : { cids: event.cids }) });
            }
          }
          queueMicrotask(() => {
            host({ sok: 1, id: message.id, result: null });
            for (const event of batchLogs) observe(logs, event);
          });
        } else {
          const error = new Error(`surface runtime.log requires action clock or batch, found ${JSON.stringify(message.params)}`);
          failWaiters(error);
          throw error;
        }
      } else {
        const { id: _id, sok: _sok, ...request } = message;
        observe(requests, request);
        queueMicrotask(() => host({ sok: 1, id: message.id, result: null }));
      }
    };
    const bridge = createViewBridge({ handler: { postMessage }, report: (event) => reports.push(event) });
    const stored = new Map();
    const outputs = [];
    for (const step of testCase.steps) {
      let result = null;
      let throws = null;
      try {
        let pending = null;
        if ("operation" in step) {
          const { event, fields, as } = step.operation;
          result = bridge.runtime.beginOperation(event, fields);
          assert.equal(result.length, 1, "an operation has one identifier");
          assert.match(result[0], IDENTIFIER, "an operation identifier has the page form");
          stored.set(as, result);
          const cids = result;
          await waitFor(logs, (entry) => entry.event === `plugin.probe.${event}` && JSON.stringify(entry.cids) === JSON.stringify(cids));
        } else if ("sidecar" in step) {
          const { name, id, body, cids } = step.sidecar;
          pending = bridge.runtime.sidecar(name).send(id, body, stored.get(cids));
          await waitFor(requests, (request) => request.command === "runtime.sidecar.send");
        } else if ("command" in step) {
          const { name, params, cids } = step.command;
          pending = bridge.runtime.command(name, params, { cids: stored.get(cids) });
          await waitFor(requests, (request) => request.command === name);
        } else {
          throw new Error(`unsupported view operation step ${Object.keys(step).join(", ")}`);
        }
        if (pending) result = (await pending) ?? null;
      } catch (error) {
        throws = error.message;
      }
      if ("operation" in step) {
        const cids = result;
        const log = logs.find((entry) => entry.event === `plugin.probe.${step.operation.event}` && JSON.stringify(entry.cids) === JSON.stringify(cids));
        outputs.push({ log: log ?? null, result, throws });
      } else {
        outputs.push({ request: requests.pop() ?? null, result, throws });
      }
    }
    return { outputs, reports, openCalls: bridge.calls.openCalls() };
  } finally {
    delete globalThis.window;
    dom.window.close();
  }
}

test("view operation contract publishes the required cases in order", { timeout: 5000 }, () => {
  assert.deepEqual(CONTRACT.cases.map(({ id }) => id), EXPECTED_IDS);
});

for (const testCase of CONTRACT.cases) {
  test(`view operation ${testCase.id} matches each ordered step`, { timeout: 5000 }, async () => {
    const { outputs, reports, openCalls } = await runCase(testCase);
    assert.deepEqual(normalize(outputs), testCase.steps.map(({ output }) => output));
    assert.equal(openCalls.count, 0, "all view calls have settled before the page closes");
    assert.equal(reports.at(-1)?.kind, "open-calls");
    assert.equal(reports.at(-1)?.count, 0, "the final open-calls report is empty");
    assert.deepEqual(reports.filter(({ kind }) => kind !== "open-calls"), [], "the call layer reported no unexpected errors");
  });
}
