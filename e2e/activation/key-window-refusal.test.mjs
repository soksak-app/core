// Checks that a key to a window behind the key window of the active application is refused, as a person's key cannot reach it.
// The refusal exists only while the application is really active: in an inactive application the key makes its window the
// virtual key window (docs/spec/exposure.md#virtual-key-window), so this check activates the application and takes the keyboard
// of the person.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "../fixture.mjs";
import { documentFocused, documentPoint, inputProbeTab } from "../input-probe.mjs";


/**
 * A folder for a project that the check opens. The library keeps the project after its window closes, so the cleanup closes it
 * (which removes it from the library) before it removes the folder; cleanups run in the order they were registered.
 */
function temporaryProject(s, prefix) {
  const folder = mkdtempSync(join(tmpdir(), prefix));
  const name = folder.slice(folder.lastIndexOf("/"));
  s.cleanup(async () => {
    for (const listed of await s.get("core.projects")) {
      if (listed.root.endsWith(name)) await s.run("core.project.close", { id: listed.id });
    }
    await s.run("core.projects.flush");
  });
  s.cleanup(() => rmSync(folder, { recursive: true, force: true }));
  return folder;
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a key to a window that is not the key window is rejected instead of delivered`, { timeout: 30000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    // The document region of the input probe takes the keyboard of the window and reports each key that reaches it.
    const { surface } = await inputProbeTab(s);
    await s.keepPointerOutside();
    const { x, y } = await documentPoint(s, surface);
    await s.pointer(x, y, "move", { activate: true });
    await s.selectInputSource("latin");
    await s.click(x, y);
    await s.until("host.window", (host) => host.active === true && documentFocused(host, surface),
      "the input probe document did not receive native focus in the active window");

    // When another project window becomes the key window, human keys do not reach the first window. The diagnostic key does not deliver to another window either and is rejected.
    const project = temporaryProject(s, "soksak-key-window-");
    await s.run("core.settings.set", { patch: { projectOpening: "windows" }, scope: "common" });
    await s.run("core.project.open", { root: project, color: "#7fe3b0" });
    const child = s.on((await s.windows(2, "the second project window did not open"))
      .find((window) => window.window !== s.window).window);
    await child.until("host.window", (host) => host.active === true && host.key === true,
      "the second project window did not become the key window");
    await s.until("host.window", (host) => host.key === false && documentFocused(host, surface),
      "the first window lost its input probe responder");
    const before = (await s.get("probeinput.document", surface)).keys.at(-1)?.sequence ?? 0;

    await assert.rejects(s.press("e"), /keys reach only the key window of the active application/);
    const reached = (await s.get("probeinput.document", surface)).keys.filter((key) => key.sequence > before);
    assert.deepEqual(reached, [], "the rejected key reached the input probe document");
    await child.close();
    await s.windows(1, "the second project window did not close");
  });
}
