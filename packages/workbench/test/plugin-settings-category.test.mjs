// Checks the setting of the type plugin, which names a loaded and enabled plugin of a plugin category (docs/spec/plugins.md#plugin-categories):
// the value is the stored or environment value, a value that names no plugin of the category is an error and is not replaced, and without a
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

test("an environment value that names a plugin of its category is the value, and one that names no such plugin is an error", async () => {
  const { setPluginSettings, value } = await import("../settings.js?test=environment");
  setPluginSettings([{ id: "cli-env", settings: shellSetting }], { "cli-env": { shell: "term-two" } }, { terminal: terminals });
  assert.equal(value("cli-env.shell"), "term-two");
  assert.throws(() => setPluginSettings([{ id: "cli-bad", settings: shellSetting }], { "cli-bad": { shell: "gone" } },
    { terminal: terminals }), /cli-bad\.shell: plugin gone is not a terminal plugin/);
});

test("a stored value that names no plugin of its category is an explicit load error and is not replaced", async () => {
  const { setPluginSettings, beginSettings, value } = await import("../settings.js?test=stored");
  setPluginSettings([{ id: "cli-stored", settings: shellSetting }], {}, { terminal: terminals });
  assert.throws(() => beginSettings({ common: { "cli-stored.shell": "gone" }, projects: [] }, null),
    /cli-stored\.shell: plugin gone is not a terminal plugin/);
  assert.equal(value("cli-stored.shell"), undefined, "the rejected stored value replaced the setting");
  beginSettings({ common: { "cli-stored.shell": "term-one" }, projects: [] }, null);
  assert.equal(value("cli-stored.shell"), "term-one");
});

test("a stored value of a plugin setting that is not a plugin id is refused with the key of the setting", async () => {
  const { setPluginSettings, beginSettings } = await import("../settings.js?test=form");
  setPluginSettings([{ id: "cli-form", settings: shellSetting }], {}, { terminal: terminals });
  for (const stored of [3, "Term", ""]) {
    assert.throws(() => beginSettings({ common: { "cli-form.shell": stored }, projects: [] }, null),
      { message: "Invalid setting cli-form.shell: plugin value must be a plugin id" });
  }
});
