// The save place of a new document (docs/spec/plugins.md#pluginjson). The save panel needs the person, so the check observes
// the path from the command to the host through the refusal of a name that is not a file name, which comes before the panel.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: core.file.place refuses a name that is not a file name before the save panel`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    // A refused command is an error that the check causes on purpose.
    s.expectError(/file place: name .* is not a file name/);
    for (const name of ["", "..", "docs/plan.hwp"]) {
      await assert.rejects(s.run("core.file.place", { name }), (error) => error.message.includes(`file place: name ${name} is not a file name`),
        `core.file.place did not refuse the name ${JSON.stringify(name)}`);
    }
  });
}
