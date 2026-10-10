// A stored link to the set of a plugin that is no longer loaded is kept, and the settings load (docs/spec/settings.md#stored-sets-and-links).
import assert from "node:assert/strict";
import test from "node:test";

const set = (id) => ({ id, title: id, layout: "list", sections: [] });
const probe = { id: "probe", surface: true, sections: [] };
const link = (plugin, setId) => ({ place: "card-left", plugin, set: setId });

async function begin(links, loaded) {
  globalThis.document = { addEventListener: () => {}, documentElement: { dataset: {}, style: { setProperty() {} } } };
  const settings = await import(`../settings.js?test=removed-${Math.random()}`);
  settings.setPluginSettings(loaded.map((id) => ({ id, surface: true, sections: [] })));
  settings.setSidebarDefaults({ sets: [set("probe.default")], links: [] });
  settings.beginSettings({ common: { links }, projects: [] }, null);
  return settings;
}

test("a stored link to the set of a plugin that was removed is kept and the settings load", async () => {
  const settings = await begin([link("probe", "probe.default"), link("gone", "gone.default")], ["probe"]);
  assert.deepEqual(settings.value("links"), [link("probe", "probe.default"), link("gone", "gone.default")]);
});

test("a stored link of a loaded plugin to a missing set still fails the settings load", async () => {
  await assert.rejects(begin([link("probe", "gone.default")], ["probe"]), /a card-left link requires a known set/);
});
