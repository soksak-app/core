// Checks the project data that a plugin declares, read and written by its views for the project that each view names.
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<body></body>", { url: "https://example.test/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.dispatchEvent = (event) => dom.window.dispatchEvent(event);
globalThis.ErrorEvent = dom.window.ErrorEvent;

const { configureData, declareProjectData, viewDataOf, onDataChange, compareProjectData } = await import("../plugin-data.js");

const stored = new Map();
configureData({
  data: {
    get: (id, plugin) => stored.get(`${id}/${plugin}`) ?? {},
    set: async (id, plugin, key, value) => { stored.set(`${id}/${plugin}`, { ...stored.get(`${id}/${plugin}`), [key]: value }); },
  },
});

test("a view reads the declared defaults and writes the keys of the project it names, and refuses an undeclared key or a value outside the schema", async () => {
  declareProjectData("probe", {
    marks: { schema: { type: "array", items: { type: "string" } }, default: [] },
    note: { schema: { type: "string" }, default: "" },
    names: { schema: { type: "array", items: { type: "object", properties: { name: { type: "string" } } } }, default: [], format: 2 },
  });
  const project = { id: "p1", root: "/work/p1" };
  stored.set("p1/probe", { names: { format: 1, value: ["a"] } });
  const access = viewDataOf(project, "probe");
  assert.deepEqual(await access.get("marks"), []);
  assert.equal(await access.get("note"), "");
  await access.set("note", "kept");
  assert.deepEqual(stored.get("p1/probe").note, { format: 1, value: "kept" });
  assert.equal(await access.get("note"), "kept");
  // A key that the manifest does not declare, and a value that does not match its schema, are refused without a write.
  await assert.rejects(async () => access.get("other"), /probe data other is not declared/);
  await assert.rejects(async () => access.set("other", "x"), /probe data other is not declared/);
  await assert.rejects(async () => access.set("note", 5), /probe data note does not match its schema/);
  assert.deepEqual(stored.get("p1/probe").note, { format: 1, value: "kept" });
  // A stored value of an earlier format is refused by the read and stays unchanged; no conversion runs.
  await assert.rejects(async () => access.get("names"),
    /project p1 plugin probe data names: stored format 1 is not declared format 2/);
  assert.deepEqual(stored.get("p1/probe").names, { format: 1, value: ["a"] });
});

test("a stored value in another format fails the read and is not changed", async () => {
  declareProjectData("later", { note: { schema: { type: "string" }, default: "", format: 1 } });
  stored.set("p2/later", { note: { format: 3, value: "x" } });
  await assert.rejects(async () => viewDataOf({ id: "p2", root: "/work/p2" }, "later").get("note"),
    /project p2 plugin later data note: stored format 3 is not declared format 1/);
  assert.deepEqual(stored.get("p2/later").note, { format: 3, value: "x" });
});

test("a value stored without a format entry is refused by the read and is not changed", async () => {
  declareProjectData("bare", { legacy: { schema: { type: "array", items: { type: "string" } }, default: [] } });
  stored.set("p3/bare", { legacy: ["d"] });
  await assert.rejects(async () => viewDataOf({ id: "p3", root: "/work/p3" }, "bare").get("legacy"),
    /project p3 plugin bare data legacy: stored without a format is not declared format 1/);
  assert.deepEqual(stored.get("p3/bare").legacy, ["d"]);
});

test("a view reads and writes the declared keys of the project it names, whether or not the window shows that project", async () => {
  declareProjectData("view-probe", { note: { schema: { type: "string" }, default: "" } });
  const access = viewDataOf({ id: "p4", root: "/work/p4" }, "view-probe");
  assert.equal(access.declares("note"), true);
  assert.equal(access.declares("other"), false);
  assert.equal(await access.get("note"), "");
  await access.set("note", "stored for p4");
  assert.deepEqual(stored.get("p4/view-probe").note, { format: 1, value: "stored for p4" });
  assert.equal(await viewDataOf({ id: "p4", root: "/work/p4" }, "view-probe").get("note"), "stored for p4");
  assert.equal(await viewDataOf({ id: "p5", root: "/work/p5" }, "view-probe").get("note"), "");
  await assert.rejects(async () => access.set("note", 5), /view-probe data note does not match its schema/);
  assert.deepEqual(stored.get("p4/view-probe").note, { format: 1, value: "stored for p4" });
});

test("a write of a view and a stored change of another window each report the changed key of the project and the plugin", async () => {
  declareProjectData("marks-probe", { marks: { schema: { type: "array", items: { type: "string" } }, default: [] } });
  const changes = [];
  const off = onDataChange((project, plugin, key) => changes.push({ project, plugin, key }));
  try {
    await viewDataOf({ id: "p7", root: "/work/p7" }, "marks-probe").set("marks", ["a"]);
    assert.deepEqual(changes, [{ project: "p7", plugin: "marks-probe", key: "marks" }]);
    changes.length = 0;
    const entry = (value) => ({ format: 1, value });
    compareProjectData(
      [{ id: "p7", plugins: { "marks-probe": { marks: entry(["a"]) } } }, { id: "p8", plugins: { other: { x: entry(1) } } }],
      [{ id: "p7", plugins: { "marks-probe": { marks: entry(["a", "b"]) } } }, { id: "p8", plugins: { other: { x: entry(1) } } },
        { id: "p9", plugins: { other: { y: entry(2) } } }]);
    assert.deepEqual(changes, [{ project: "p7", plugin: "marks-probe", key: "marks" }, { project: "p9", plugin: "other", key: "y" }],
      "an unchanged key reports nothing, and a key of a new project is a change");
  } finally { off(); }
  await viewDataOf({ id: "p7", root: "/work/p7" }, "marks-probe").set("marks", []);
  assert.equal(changes.length, 2, "a listener that turned off receives nothing");
});
