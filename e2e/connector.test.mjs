// Connector plugins end to end (docs/spec/installation.md#applications): the connector plugin of the test application of
// the embed kit (connector-fixture.mjs) is packed into a registry of the check. Installed while its locate entry finds the
// application, the plugin connects that application and installs nothing; removed, installed again without it, the
// release recipe installs it into the configuration folder from a release that the check serves over https. Each time a
// card of the connector plugin starts the connected application from its path without a setting. The application is the
// executable that SOKSAK_EMBED_TEST_APP names; the check fails with that name when it is not set.
import assert from "node:assert/strict";
import { realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { APPS, keepCommonSettings, open } from "@soksak/window-check/app.mjs";
import { APPLICATION, PLUGIN, connectApplication, install, remove } from "./connector-fixture.mjs";
import { fresh } from "./fixture.mjs";

/** Opens a card of the connector plugin and returns the program of the application once it connected. */
async function startedProgram(s) {
  const card = (await s.get("core.grid")).cards.find((item) => item.pane !== null).id;
  const { tab } = await s.run("core.card.add-tab", { card, plugin: PLUGIN });
  try {
    await s.until("core.surfaces", (surfaces) => surfaces.some((item) => item.surface === tab && item.exposes.includes(`status ${PLUGIN}.state`)),
      `the card of ${PLUGIN} did not register ${PLUGIN}.state`);
    const state = await s.until(`${PLUGIN}.state`, (value) => value.toolkit !== null || value.error !== null,
      `the connected application did not start in the card of ${PLUGIN}`, { surface: tab });
    assert.equal(state.error, null, `the card of ${PLUGIN} reported ${state.error}`);
    return state.program;
  } finally {
    await s.run("core.tab.close", { tab });
  }
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a connector plugin connects an installed application and installs an absent one`, { timeout: 300000 }, async (t) => {
    const executable = process.env.SOKSAK_EMBED_TEST_APP;
    assert.ok(executable, "SOKSAK_EMBED_TEST_APP is not set; it names the test application of the embed kit");
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is not built`);
    await fresh(s);
    await keepCommonSettings(s);
    // Present: the locate entry finds the application, which is connected where it is.
    const { present } = await connectApplication(s, executable);
    assert.equal(await startedProgram(s), present, "the card did not start the application that the locate entry found");

    // Absent: the release recipe installs the application into the configuration folder.
    await remove(s);
    rmSync(present);
    await install(s);
    // The application resolves its configuration folder, so the recorded path is the resolved one.
    const installed = join(realpathSync(app.configDir), "applications", APPLICATION, "0.0.2", APPLICATION);
    assert.equal(await startedProgram(s), installed, "the card did not start the application that the recipe installed");
  });
}
