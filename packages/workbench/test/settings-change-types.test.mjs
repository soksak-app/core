// core.settings.change takes a value of the declared type of its setting, or the string of a control, which it converts to that type
// (Values in docs/spec/settings.md). The type comes from the declaration of the setting, so a value of another type is refused by the
// check of the setting instead of being turned into a string.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

const INVALID_PARAMS = -32602;

/** Starts the core commands over a memory store with one plugin of each declared string form. */
async function start(t) {
  const markup = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const dom = new JSDOM(markup, { url: "http://localhost/" });
  dom.window.matchMedia = (query) => ({ media: query, matches: true,
    addEventListener: () => {}, removeEventListener: () => {} });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.CSS = dom.window.CSS;
  globalThis.PointerEvent = dom.window.PointerEvent;
  globalThis.MouseEvent = dom.window.MouseEvent;
  globalThis.addEventListener = dom.window.addEventListener.bind(dom.window);
  t.after(() => dom.window.close());

  const memory = { common: {}, projects: [] };
  const settings = await import("../settings.js");
  settings.setPluginSettings([{ id: "fixture", settings: {
    shape: { label: "모양", type: "enum", values: ["block", "beam"], default: "block" },
    columns: { label: "열", type: "integer", minimum: 20, maximum: 400, default: 80 },
    family: { label: "글꼴", type: "string", maxLength: 40, default: "Menlo" },
    home: { label: "홈 주소", type: "address", default: "" },
  } }]);
  await settings.connectSettings({
    snapshot: async () => structuredClone(memory),
    settings: async (id, values) => {
      if (id) Object.assign(memory.projects.find((project) => project.id === id).settings, values);
      else memory.common = { ...memory.common, ...values };
    },
    onChange: () => () => {},
  });
  const { registry } = await import("../exposure.js");
  registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
  const { installCoreExposure } = await import("../core-exposure.js");
  await installCoreExposure({
    library: { state: () => null }, renames: { state: () => null }, chrome: () => null, drawn: async () => {},
  });
  return { memory, registry, settings, change: (key, value) => registry.run("core.settings.change", { key, value, scope: "common" }) };
}

test("core.settings.change gives each setting a value of its declared type", async (t) => {
  const { memory, registry, settings, change } = await start(t);

  await t.test("an object setting takes the object", async () => {
    await change("diagnostics.log", { call: "debug" });
    assert.deepEqual(memory.common["diagnostics.log"], { call: "debug" });
    await change("diagnostics.log", {});
    assert.deepEqual(memory.common["diagnostics.log"], {});
  });

  await t.test("a string setting takes the string, also one that reads as another type", async () => {
    for (const [key, value] of [["mode", "light"], ["fixture.family", "123"], ["fixture.family", "true"], ["fixture.home", "https://example.com/"], ["fixture.shape", "beam"]]) {
      await change(key, value);
      assert.equal(memory.common[key], value, key);
    }
  });

  await t.test("the string of a control converts to a boolean or a number setting", async () => {
    for (const [key, text, value] of [["dim", "true", true], ["dim", "false", false], ["gap", "12", 12], ["fixture.columns", "100", 100], ["textSize", "1", 1]]) {
      await change(key, text);
      assert.strictEqual(memory.common[key], value, `${key} ${text}`);
    }
  });

  await t.test("a value of the declared type passes without a conversion", async () => {
    for (const [key, value] of [["dim", true], ["gap", 8], ["fixture.columns", 90]]) {
      await change(key, value);
      assert.strictEqual(memory.common[key], value, key);
    }
  });

  await t.test("a value of another type is refused with its cause and changes nothing", async () => {
    for (const [key, value, cause] of [
      ["diagnostics.log", "[object Object]", "Invalid setting diagnostics.log: the policy must be an object"],
      ["diagnostics.log", [], "Invalid setting diagnostics.log: the policy must be an object"],
      ["dim", "maybe", "Invalid setting dim: \"maybe\" is not a boolean"],
      ["dim", 1, "Invalid setting dim: 1 is not a boolean"],
      ["dim", {}, "Invalid setting dim: {} is not a boolean"],
      ["gap", "wide", "Invalid setting gap: \"wide\" is not an integer from 0 to 24"],
      ["gap", "", "Invalid setting gap: \"\" is not an integer from 0 to 24"],
      ["gap", true, "Invalid setting gap: true is not an integer from 0 to 24"],
      ["gap", null, "Invalid setting gap: null is not an integer from 0 to 24"],
      ["mode", {}, "Invalid setting mode: {} is not one of \"dark\", \"light\""],
      ["fixture.family", {}, "Invalid setting fixture.family: string value must be non-empty and at most 40 characters"],
      ["fixture.family", 5, "Invalid setting fixture.family: string value must be non-empty and at most 40 characters"],
    ]) {
      const before = structuredClone(memory.common);
      await assert.rejects(change(key, value), (error) => {
        assert.equal(error.message, cause);
        assert.equal(error.code, INVALID_PARAMS, `${key} ${JSON.stringify(value)}`);
        return true;
      }, `${key} took ${JSON.stringify(value)}`);
      assert.deepEqual(memory.common, before, `${key} changed the stored settings`);
    }
  });

  await t.test("an unknown setting is refused", async () => {
    await assert.rejects(change("noSuchSetting", "x"), (error) => {
      assert.equal(error.message, "Unknown setting: noSuchSetting");
      assert.equal(error.code, INVALID_PARAMS);
      return true;
    });
  });

  await t.test("without a scope the change sets the common value while a project is selected", async () => {
    memory.projects.push({ id: "project-1", root: "/fixture", settings: {} });
    await settings.selectProject("project-1");
    await registry.run("core.settings.change", { key: "gap", value: 3 });
    assert.equal(memory.common.gap, 3);
    assert.deepEqual(memory.projects[0].settings, {});
  });

  await t.test("every setting declares the type of its default", () => {
    for (const [key, value] of Object.entries(settings.defaults)) {
      assert.equal(settings.settingType(key), typeof value, key);
    }
  });
});
