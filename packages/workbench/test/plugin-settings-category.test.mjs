// Checks the setting of the type plugin, which names a loaded and enabled plugin of a plugin category (docs/spec/plugins.md#plugin-categories):
// the value is the stored or environment value, a stored value that names no plugin of the category is a missing setting, and without a
// value the one plugin of the category is the value when there is exactly one.
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<body></body>", { url: "http://localhost/" });
globalThis.document = dom.window.document;
globalThis.window = dom.window;

const terminals = [{ id: "term-one", name: "터미널 하나" }, { id: "term-two", name: "터미널 둘" }];
const shellSetting = { shell: { type: "plugin", category: "terminal", label: "셸", description: "셸로 쓸 플러그인." } };

test("a plugin setting with no stored or environment value takes the one plugin of its category", async () => {
  const { setPluginSettings, value } = await import("../settings.js?test=one-plugin");
  setPluginSettings([{ id: "cli-one", settings: shellSetting }], {}, { terminal: [terminals[0]] });
  assert.equal(value("cli-one.shell"), "term-one");
});

test("a plugin setting with no value and more than one plugin of its category has no value and shows the choice", async () => {
  const { setPluginSettings, value, pluginChoiceErrors } = await import("../settings.js?test=choice");
  setPluginSettings([{ id: "cli-two", settings: shellSetting }], {}, { terminal: terminals });
  assert.equal(value("cli-two.shell"), undefined);
  assert.deepEqual(pluginChoiceErrors(), [{ key: "cli-two.shell", text: "cli-two.shell: choose a terminal plugin" }]);
});

test("an environment value that names a plugin of its category is the value, and one that names no such plugin is a missing setting", async () => {
  const { setPluginSettings, beginSettings, value, missingPluginKeys } = await import("../settings.js?test=environment");
  setPluginSettings([{ id: "cli-env", settings: shellSetting }], { "cli-env": { shell: "term-two" } }, { terminal: terminals });
  assert.equal(value("cli-env.shell"), "term-two");
  setPluginSettings([{ id: "cli-bad", settings: shellSetting }], { "cli-bad": { shell: "gone" } }, { terminal: terminals });
  beginSettings({ common: {}, projects: [] }, null);
  assert.equal(value("cli-bad.shell"), undefined);
  assert.deepEqual(missingPluginKeys(), ["cli-bad.shell"]);
});

test("a stored value that names no plugin of its category is a load error of its key alone: the other settings apply and the key is missing", async () => {
  const { setPluginSettings, beginSettings, value, missingPluginKeys, missingPluginValue, missingPluginErrors, pluginChoiceErrors } =
    await import("../settings.js?test=stored");
  setPluginSettings([{ id: "cli-stored", settings: shellSetting }], {}, { terminal: terminals });
  assert.doesNotThrow(() => beginSettings({ common: { "cli-stored.shell": "gone", "textSize": 1 }, projects: [] }, null));
  assert.equal(value("cli-stored.shell"), undefined, "the missing setting has a value");
  assert.equal(value("textSize"), 1, "the other settings did not apply");
  assert.deepEqual(missingPluginKeys(), ["cli-stored.shell"]);
  assert.equal(missingPluginValue("cli-stored.shell"), "gone");
  assert.deepEqual(missingPluginErrors(), [{ key: "cli-stored.shell", text: "cli-stored.shell: plugin gone is not a terminal plugin" }]);
  assert.deepEqual(pluginChoiceErrors(), [], "a missing setting also shows the choice");
  beginSettings({ common: { "cli-stored.shell": "term-one" }, projects: [] }, null);
  assert.equal(value("cli-stored.shell"), "term-one");
  assert.deepEqual(missingPluginKeys(), []);
});

test("a write of a plugin value that names no plugin of its category is refused and a missing setting is not", async () => {
  const { setPluginSettings, beginSettings, set, value, missingPluginKeys } = await import("../settings.js?test=write");
  setPluginSettings([{ id: "cli-write", settings: shellSetting }], {}, { terminal: terminals });
  beginSettings({ common: { "cli-write.shell": "gone" }, projects: [] }, null);
  assert.deepEqual(missingPluginKeys(), ["cli-write.shell"]);
  assert.throws(() => set({ "cli-write.shell": "gone" }, "common", "test-actor"), /cli-write\.shell: plugin gone is not a terminal plugin/);
  assert.equal(value("cli-write.shell"), undefined);
});

test("a stored value of a plugin setting that is not a plugin id is refused with the key of the setting", async () => {
  const { setPluginSettings, beginSettings } = await import("../settings.js?test=form");
  setPluginSettings([{ id: "cli-form", settings: shellSetting }], {}, { terminal: terminals });
  for (const stored of [3, "Term", ""]) {
    assert.throws(() => beginSettings({ common: { "cli-form.shell": stored }, projects: [] }, null),
      { message: "Invalid setting cli-form.shell: plugin value must be a plugin id" });
  }
});
