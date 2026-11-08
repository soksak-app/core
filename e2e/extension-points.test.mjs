// Extension points end to end (docs/spec/plugins.md#extension-points): a provider probe declares the point items, a contributor
// probe contributes one item and names the provider in its dependencies. Both probes are preinstalled in every check configuration
// with the other fixture plugins; the check requires that the item is connected in core.contributions and that the provider page
// imports its module and reports its answer.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, keepCommonSettings, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";


for (const app of Object.values(APPS)) {
  test(`${app.name}: a contributed item connects to the extension point of its provider and the provider uses it`, { timeout: 180000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    await keepCommonSettings(s);
    const installed = (await s.get("core.plugins")).plugins;
    for (const id of ["probecontributor", "probeprovider"]) {
      assert.ok(installed.find((row) => row.id === id)?.installed, `the fixture plugin ${id} is not installed in the check configuration`);
    }
    await s.until("core.contributions", (items) => items.some((item) => item.plugin === "probecontributor"
      && item.point === "probeprovider.items" && item.state === "connected"),
    "the contributed item is not connected to the point of the provider");
    const card = (await s.get("core.grid")).cards.find((item) => item.pane !== null).id;
    const { tab } = await s.run("core.card.add-tab", { card, plugin: "probeprovider" });
    s.cleanup(() => s.run("core.tab.close", { tab }));
    const answers = await s.until("probeprovider.items", (value) => Array.isArray(value) && value.length === 1,
      "the provider page did not report the answer of the contributed item", { surface: tab });
    assert.deepEqual(answers, [{ plugin: "probecontributor", label: "probe item", answer: "contributed: probe item" }]);
  });
}
