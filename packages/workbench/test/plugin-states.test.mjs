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
configureStates({
  sidecar: (name) => ({ send: async (surface, body) => { sent.push([name, surface, body]); }, on: async () => {} }),
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
  globalThis.mounted = (globalThis.mounted ?? 0) + 1;
  return { dispose() { globalThis.mounted -= 1; } };
}`;
registerState({ plugin: "probe", module: `data:text/javascript,${encodeURIComponent(source)}`, sidecars: ["@scope/sidecar-probe"],
  data: { marks: { schema: { type: "array", items: { type: "string" } }, default: [] } } });

test("a state module is mounted for the shown project, answers its commands, stores data, and is disposed on switch", async () => {
  await showStates({ id: "p1", root: "/work/p1" });
  assert.equal(globalThis.mounted, 1);
  assert.equal(await registry.run("probe.mark", { path: "a.txt" }), "/work/p1");
  assert.deepEqual(stored.get("p1/probe"), { marks: ["a.txt"] });
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
