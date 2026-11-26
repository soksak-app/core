// Checks the plugin keys of the web workbench (docs/spec/plugins.md#plugin-data, F1210-3): a key of data with the scope plugin is read,
// written, replaced and followed by a view of any window, with or without a project, through the plugin store of the host.
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<body></body>", { url: "https://example.test/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const { configureData, declareProjectData, viewDataOf, onDataChange, comparePluginData } = await import("../plugin-data.js");

// The plugin store of the host: the entries of each plugin, the operations it received, and the refusal of its file.
const entries = {};
const operations = [];
let refusal = null;
configureData({
  data: {
    get: () => ({}),
    set: async () => { throw new Error("a plugin key was written as project data"); },
    plugin: {
      get: (plugin) => {
        if (refusal !== null) throw new Error(refusal);
        return entries[plugin] ?? {};
      },
      put: async (plugin, key, entry, base, fallback) => {
        operations.push(base === undefined ? { plugin, key, entry } : { plugin, key, entry, base, default: fallback });
        const stored = entries[plugin]?.[key]?.value ?? fallback;
        if (base !== undefined && JSON.stringify(stored) !== JSON.stringify(base)) return false;
        entries[plugin] = { ...entries[plugin], [key]: entry };
        return true;
      },
    },
  },
});

declareProjectData("keys", {
  accounts: { schema: { type: "array", items: { type: "string" } }, default: [], scope: "plugin" },
  marks: { schema: { type: "array", items: { type: "string" } }, default: [] },
});

test("a view without a project reads, writes and replaces a plugin key through the plugin store", async () => {
  const data = viewDataOf(null, "keys");
  assert.equal(data.scope("accounts"), "plugin");
  assert.equal(data.scope("marks"), "project");
  assert.deepEqual(await data.get("accounts"), []);
  const changes = [];
  const stop = onDataChange((project, plugin, key) => changes.push([project, plugin, key]));
  await data.set("accounts", ["a"]);
  assert.deepEqual(operations.at(-1), { plugin: "keys", key: "accounts", entry: { format: 1, value: ["a"] } });
  assert.deepEqual(await data.get("accounts"), ["a"]);
  assert.equal(await data.replace("accounts", ["a"], ["a", "b"]), true);
  assert.deepEqual(operations.at(-1), { plugin: "keys", key: "accounts", entry: { format: 1, value: ["a", "b"] }, base: ["a"], default: [] });
  assert.equal(await data.replace("accounts", ["a"], ["c"]), false, "the store refuses a replace whose base is not the stored value");
  assert.deepEqual(await data.get("accounts"), ["a", "b"]);
  stop();
  assert.deepEqual(changes, [[null, "keys", "accounts"], [null, "keys", "accounts"]], "a refused replace reports no change");
  await assert.rejects(async () => data.set("accounts", [1]), /keys data accounts does not match its schema/);
  await assert.rejects(async () => data.get("marks"), /keys data marks requires a project/);
});

test("a view with a project reads the same plugin key as a view without one", async () => {
  entries.keys = { accounts: { format: 1, value: ["shared"] } };
  assert.deepEqual(await viewDataOf({ id: "p1", root: "/work/p1" }, "keys").get("accounts"), ["shared"]);
  assert.deepEqual(await viewDataOf(null, "keys").get("accounts"), ["shared"]);
});

test("a stored plugin entry of another format and a refused file fail the read with the named error", async () => {
  entries.keys = { accounts: { format: 2, value: [] } };
  await assert.rejects(async () => viewDataOf(null, "keys").get("accounts"), /^Error: plugin keys data accounts: stored format 2 is not declared format 1$/);
  entries.keys = {};
  refusal = "plugin-data.json: unknown format 9";
  try {
    await assert.rejects(async () => viewDataOf(null, "keys").get("accounts"), /^Error: plugin-data.json: unknown format 9$/);
    await assert.rejects(async () => viewDataOf(null, "keys").set("accounts", []), /^Error: plugin-data.json: unknown format 9$/);
  } finally {
    refusal = null;
  }
});

test("a plugin key that another window changed is reported with no project", () => {
  const changes = [];
  const stop = onDataChange((project, plugin, key) => changes.push([project, plugin, key]));
  comparePluginData({ keys: { accounts: { format: 1, value: ["a"] } } }, { keys: { accounts: { format: 1, value: ["b"] } }, other: { k: { format: 1, value: 1 } } });
  stop();
  assert.deepEqual(changes, [[null, "keys", "accounts"], [null, "other", "k"]]);
});
