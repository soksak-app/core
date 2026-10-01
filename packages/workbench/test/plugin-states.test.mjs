// 플러그인 상태 모듈을 보이는 프로젝트마다 마운트하고, 문맥의 등록·사이드카·프로젝트 데이터를 검사한다.
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<body></body>", { url: "https://example.test/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.dispatchEvent = (event) => dom.window.dispatchEvent(event);
globalThis.ErrorEvent = dom.window.ErrorEvent;

const { registry } = await import("../exposure.js");
const { configureStates, registerState, showStates } = await import("../plugin-states.js");

registry.declare("probe", {
  status: [{ name: "probe.marks", description: "Marks.", schema: { type: "array" } }],
  commands: [{ name: "probe.mark", description: "Marks.", params: { type: "object" }, result: {} }],
  dom: [],
});

const sent = [];
const stored = new Map();
const failureHandlers = [];
configureStates({
  sidecar: (name) => ({
    send: async (surface, body) => { sent.push([name, surface, body]); },
    on: async () => {},
    onFailure: async (surface, fn) => { failureHandlers.push([name, surface, fn]); return () => {}; },
  }),
  data: {
    get: (id, plugin) => stored.get(`${id}/${plugin}`) ?? {},
    set: async (id, plugin, key, value) => { stored.set(`${id}/${plugin}`, { ...stored.get(`${id}/${plugin}`), [key]: value }); },
  },
});
const source = `export function mount(context) {
  const marks = context.data.get("marks");
  const listeners = new Set();
  context.exposure.status("probe.marks", () => context.data.get("marks"), (fn) => { listeners.add(fn); return () => listeners.delete(fn); });
  context.exposure.command("probe.mark", async ({ path }) => {
    await context.data.set("marks", [...context.data.get("marks"), path]);
    await context.sidecar.send({ operation: "list", path });
    for (const fn of listeners) fn(context.data.get("marks"));
    return context.project.root;
  });
  context.sidecar.onFailure((reason) => { globalThis.stateFailures = [...(globalThis.stateFailures ?? []), reason]; });
  globalThis.mounted = (globalThis.mounted ?? 0) + 1;
  return { dispose() { globalThis.mounted -= 1; } };
}`;
registerState({ plugin: "probe", module: `data:text/javascript,${encodeURIComponent(source)}`, sidecars: ["@scope/sidecar-probe"],
  data: { marks: { schema: { type: "array", items: { type: "string" } }, default: [] } } });

test("a state module is mounted for the shown project, answers its commands, stores data, and is disposed on switch", async () => {
  await showStates({ id: "p1", root: "/work/p1" });
  assert.equal(globalThis.mounted, 1);
  assert.equal(await registry.run("probe.mark", { path: "a.txt" }), "/work/p1");
  assert.deepEqual(stored.get("p1/probe"), { marks: { format: 1, value: ["a.txt"] } });
  assert.deepEqual(sent, [["@scope/sidecar-probe", "state:probe:p1", { operation: "list", path: "a.txt" }]]);
  assert.deepEqual((await registry.handle({ method: "status.get", params: { name: "probe.marks" } })).result, ["a.txt"]);
  await showStates({ id: "p2", root: "/work/p2" });
  assert.equal(globalThis.mounted, 1, "the previous project's module was disposed");
  assert.deepEqual((await registry.handle({ method: "status.get", params: { name: "probe.marks" } })).result, []);
  await showStates(null);
  assert.equal(globalThis.mounted, 0);
  assert.equal((await registry.handle({ method: "status.get", params: { name: "probe.marks" } })).error.code, 1002);
});

test("project data rejects an undeclared key or a value that does not match, and a stored mismatch fails the read", async () => {
  stored.set("p3/probe", { marks: [1] });
  const failures = [];
  const listener = (event) => failures.push(event.message);
  dom.window.addEventListener("error", listener);
  await showStates({ id: "p3", root: "/work/p3" });
  dom.window.removeEventListener("error", listener);
  assert.deepEqual(failures, ["plugin probe state: probe data marks does not match its schema"]);
  stored.set("p3/probe", { marks: [] });
  await showStates(null);
  await showStates({ id: "p3", root: "/work/p3" });
  await assert.rejects(registry.run("probe.mark", { path: 5 }), /probe data marks does not match its schema/);
  await showStates(null);
});

test("a state module observes the failures of its sidecar session", async () => {
  await showStates({ id: "p4", root: "/work/p4" });
  const handler = failureHandlers.find(([name, surface]) => name === "@scope/sidecar-probe" && surface === "state:probe:p4");
  assert.ok(handler, "the state module subscribed to its session's failures");
  handler[2]("output closed: exit status 3");
  assert.deepEqual(globalThis.stateFailures, ["output closed: exit status 3"]);
  await showStates(null);
});

test("project data stored in an earlier form or format is converted once before the module mounts", async () => {
  registry.declare("conv", { status: [], commands: [], dom: [] });
  registry.declare("bare", { status: [], commands: [], dom: [] });
  const convert = `export function convertData({ key, format, value }) {
    if (key !== "names" || format !== 1) throw new Error("unexpected " + key + " " + format);
    return value.map((name) => ({ name }));
  }
  export function mount(context) {
    globalThis.converted = context.data.get("names");
    try { context.data.get("later"); } catch (error) { globalThis.laterError = error.message; }
    return { dispose() {} };
  }`;
  const bare = `export function mount(context) {
    try { context.data.get("names"); } catch (error) { globalThis.bareError = error.message; }
    globalThis.bareLegacy = context.data.get("legacy");
    return { dispose() {} };
  }`;
  const names = { schema: { type: "array", items: { type: "object", properties: { name: { type: "string" } } } }, default: [], format: 2 };
  registerState({ plugin: "conv", module: `data:text/javascript,${encodeURIComponent(convert)}`, sidecars: [],
    data: { names, later: { schema: { type: "string" }, default: "", format: 1 } } });
  registerState({ plugin: "bare", module: `data:text/javascript,${encodeURIComponent(bare)}`, sidecars: [],
    data: { names, legacy: { schema: { type: "array", items: { type: "string" } }, default: [] } } });
  stored.set("p9/conv", { names: { format: 1, value: ["a", "b"] }, later: { format: 3, value: "x" } });
  stored.set("p9/bare", { names: { format: 1, value: ["c"] }, legacy: ["d"] });
  const lines = [];
  const original = console.info;
  console.info = (line) => lines.push(line);
  try {
    await showStates({ id: "p9", root: "/work/p9" });
  } finally {
    console.info = original;
    await showStates(null);
  }
  assert.deepEqual(globalThis.converted, [{ name: "a" }, { name: "b" }]);
  assert.deepEqual(stored.get("p9/conv").names, { format: 2, value: [{ name: "a" }, { name: "b" }] });
  assert.deepEqual(stored.get("p9/conv").later, { format: 3, value: "x" }, "a newer format was changed");
  assert.equal(globalThis.laterError, "project p9 plugin conv data later: stored format 3 is newer than declared format 1");
  assert.equal(globalThis.bareError, "project p9 plugin bare data names: stored format 1 needs convertData to reach format 2");
  assert.deepEqual(stored.get("p9/bare").names, { format: 1, value: ["c"] }, "an unconverted value was changed");
  assert.deepEqual(globalThis.bareLegacy, ["d"]);
  assert.deepEqual(stored.get("p9/bare").legacy, { format: 1, value: ["d"] });
  assert.deepEqual(lines.sort(), [
    "plugin data: converted project p9 plugin bare data legacy from no format to format 1",
    "plugin data: converted project p9 plugin conv data names from format 1 to format 2",
  ]);
});
