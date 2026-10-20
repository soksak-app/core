// Checks that a closed modal leaves behind no web view and no object that the shared library attached to the modal's webview, and that
// the native object counts return to their values before the first modal opened.
//
// The settings modal is opened and closed through core.settings.open and core.settings.close. Its open state is the status core.modal,
// which is null when no modal is open. The status host.window reports the modal webview as {id, mode, shown, frame, order, background}
// without its WebContent process, so this check cannot read the process of the modal webview. A modal webview whose process is shared with the
// page is not waited for, and a modal webview that has its own process is not waited for either, because the status does not identify it.
// The release is measured through diagnostics.native.objects, as the window release check does.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, keepCommonSettings, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";

const CYCLES = 4;

const counts = (s, equal) => s.request("diagnostics.native.objects", equal ? { equal } : {});

for (const app of Object.values(APPS)) {
  test(`${app.name}: closed modals release their webviews and attached native objects`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    await keepCommonSettings(s);
    s.cleanup(async () => {
      if (await s.get("core.modal")) await s.run("core.settings.close");
    });

    // The first child web view of a window registers the input of the main web view too (nativeWebviewCreate of the Wails host,
    // watch_presses of the Tauri host), a registration that lasts as long as the window. One modal is opened and closed before the
    // baseline, so the baseline holds that registration and the cycles measure only what each modal leaves.
    await s.run("core.settings.open");
    await s.until("core.modal", (state) => state?.id === "settings" && state.document !== null && state.document.loaded,
      "the first settings modal did not render");
    await s.run("core.settings.close");
    await s.until("core.modal", (state) => state === null, "the first settings modal did not report closed");
    const before = await counts(s);
    const measured = [];
    for (let cycle = 1; cycle <= CYCLES; cycle++) {
      const label = `cycle ${cycle}`;
      await s.run("core.settings.open");
      const modal = await s.until("core.modal", (state) => state?.id === "settings" && state.document !== null && state.document.loaded,
        `${label}: the settings modal did not render`);
      assert.equal(modal.id, "settings", `${label}: the open modal is not settings`);
      measured.push(await counts(s));
      await s.run("core.settings.close");
      await s.until("core.modal", (state) => state === null, `${label}: the settings modal did not report closed`);
    }
    // If the count does not return to before within 10 seconds, the request fails with an error that holds the count at that time.
    const after = await counts(s, before).catch((error) => {
      throw new Error(`${app.name}: ${CYCLES} closed modals left native objects: ${error.message}; ` +
        `before ${JSON.stringify(before)}, while open ${JSON.stringify(measured)}`);
    });
    t.diagnostic(`${app.name}: before ${JSON.stringify(before)}, open ${JSON.stringify(measured)}, after ${JSON.stringify(after)}`);
    assert.deepEqual(after, before);
  });
}
