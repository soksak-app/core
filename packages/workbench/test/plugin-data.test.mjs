// Checks the project data that a plugin declares for the shown project, and the reads and writes of its plugin host.
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<body></body>", { url: "https://example.test/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.dispatchEvent = (event) => dom.window.dispatchEvent(event);
globalThis.ErrorEvent = dom.window.ErrorEvent;

const { configureData, declareProjectData, pluginHostData, showData } = await import("../plugin-data.js");

const stored = new Map();
configureData({
  data: {
    get: (id, plugin) => stored.get(`${id}/${plugin}`) ?? {},
    set: async (id, plugin, key, value) => { stored.set(`${id}/${plugin}`, { ...stored.get(`${id}/${plugin}`), [key]: value }); },
  },
});

test("a plugin host reads and writes the project data of the shown project, and is refused without one", async () => {
  declareProjectData("probe", {
    marks: { schema: { type: "array", items: { type: "string" } }, default: [] },
    note: { schema: { type: "string" }, default: "" },
    names: { schema: { type: "array", items: { type: "object", properties: { name: { type: "string" } } } }, default: [], format: 2 },
  });
  await assert.rejects(pluginHostData.get("probe", "note"), /plugin host probe: no project is shown/);
  await assert.rejects(pluginHostData.set("probe", "note", "x"), /plugin host probe: no project is shown/);
  stored.set("p1/probe", { names: { format: 1, value: ["a"] } });
  await showData({ id: "p1", root: "/work/p1" });
  assert.deepEqual(await pluginHostData.get("probe", "marks"), []);
  assert.equal(await pluginHostData.get("probe", "note"), "");
  await pluginHostData.set("probe", "note", "kept");
  assert.deepEqual(stored.get("p1/probe").note, { format: 1, value: "kept" });
  assert.equal(await pluginHostData.get("probe", "note"), "kept");
  // A key that the manifest does not declare, and a value that does not match its schema, are refused without a write.
  await assert.rejects(pluginHostData.get("probe", "other"), /probe data other is not declared/);
  await assert.rejects(pluginHostData.set("probe", "other", "x"), /probe data other is not declared/);
  await assert.rejects(pluginHostData.set("probe", "note", 5), /probe data note does not match its schema/);
  assert.deepEqual(stored.get("p1/probe").note, { format: 1, value: "kept" });
  // A stored value of an earlier format is refused by the read, and it stays unchanged until a migration converts it.
  await assert.rejects(pluginHostData.get("probe", "names"),
    /project p1 plugin probe data names: stored format 1 needs a migration to reach format 2/);
  assert.deepEqual(stored.get("p1/probe").names, { format: 1, value: ["a"] });
  await showData(null);
  await assert.rejects(pluginHostData.get("probe", "note"), /plugin host probe: no project is shown/);
});

test("a stored value in a newer format fails the read and is not changed", async () => {
  declareProjectData("later", { note: { schema: { type: "string" }, default: "", format: 1 } });
  stored.set("p2/later", { note: { format: 3, value: "x" } });
  await showData({ id: "p2", root: "/work/p2" });
  await assert.rejects(pluginHostData.get("later", "note"),
    /project p2 plugin later data note: stored format 3 is newer than declared format 1/);
  assert.deepEqual(stored.get("p2/later").note, { format: 3, value: "x" });
  await showData(null);
});

test("a value stored without a format entry is read as format 1 of the declared key", async () => {
  declareProjectData("bare", { legacy: { schema: { type: "array", items: { type: "string" } }, default: [] } });
  stored.set("p3/bare", { legacy: ["d"] });
  await showData({ id: "p3", root: "/work/p3" });
  assert.deepEqual(await pluginHostData.get("bare", "legacy"), ["d"]);
  await showData(null);
});
