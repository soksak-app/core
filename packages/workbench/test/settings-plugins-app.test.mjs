// The core update row of Installed and its notices (docs/spec/settings.md#plugins). The host calls are answered by the page-wire case
// library-app-update-operations, whose first state read finds the release 0.0.9 for the running core 0.0.8.
import assert from "node:assert/strict";
import test from "node:test";
import { selectPageWire } from "@soksak/runtime";

// The case is selected before the settings modules are imported, because the plugin state reads the host when it is imported.
const wire = selectPageWire("library-app-update-operations");
const { startSettingsTab, openSettingsTab } = await import("./support/settings-tab-window.mjs");
const ctx = await startSettingsTab(null, { connect: false });
const { pluginOperations, appUpdate } = await import("../installed-plugins.js");
await pluginOperations.refresh();
await pluginOperations.refreshOutdated();
await appUpdate.refresh();

test("the 설치됨 page shows the core update row with its release and its update button, and a notice for each incompatible plugin", async () => {
  await openSettingsTab(ctx);
  await ctx.run("core.settings-tab.nav", { page: "installed" });
  const app = document.querySelector('[data-expose="core.settings-tab.plugins.app"]');
  assert.ok(app, "the core update row is not drawn");
  assert.match(app.textContent, /core: 0\.0\.8 → 0\.0\.9/, "the row does not show the running and the available core");
  assert.equal(app.querySelector('[data-expose="core.settings-tab.plugins.app-release"]')?.dataset.command, "core.app.release", "the link of the row does not run core.app.release");
  assert.equal(app.querySelector('[data-expose="core.settings-tab.plugins.app-update"]')?.dataset.command, "core.app.update", "the button of the row does not run core.app.update");
  const notices = [...document.querySelectorAll('[data-expose="core.settings-tab.plugins.incompatible"]')];
  assert.ok(notices.length > 0, "no notice of an incompatible plugin is drawn");
});
