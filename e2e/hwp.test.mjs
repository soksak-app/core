// HWP check while the application is inactive: an .hwp file opens from the file tree in the plugin whose surface.opens declares
// hwp, which shows the editor of its package in a document region and exchanges messages with it
// (docs/spec/native-surfaces.md#document-regions). The pages draw their text, and a native press on the page gives the editor
// the keyboard focus. Typing, selecting and saving need the key window of the active application, so
// e2e/activation/hwp.test.mjs covers them (docs/spec/native-surfaces.md, F135).
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";
import { openHwp, studio } from "./hwp-support.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: an hwp file opens from the tree, draws its pages and takes the keyboard focus on a press`, { timeout: 180000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s, { performanceTrace: true });
    const { surface } = await openHwp(s);
    // A press on the page in the region gives the editor the keyboard focus and places its caret.
    const region = await studio(s, surface);
    await s.click(region.frame.x + region.frame.width / 2, region.frame.y + region.frame.height * 0.8);
    await s.until("host.window", (value) => value.documents.some((item) => item.surface === surface && item.focused),
      "a press in the editor did not give it the keyboard focus");
  });
}
