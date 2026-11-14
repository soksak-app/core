// keepCommonSettings keeps the common settings of the check application: its cleanup compares the common values of
// core.settings before and after the check and writes only common values back. A value that a project of the check
// overrides is not a common value: the cleanup neither writes it into the common settings nor misses a common change under it.
// The cases hold the requests of the check and of the cleanup with the readings of core.settings that the host gives after them:
// the values of the effective settings and the common values, which a project that overrides a value separates.
import test from "node:test";
import { keepCommonSettings, Session } from "../app.mjs";
import { playSession } from "../fixtures/endpoint-player.mjs";

test("the cleanup of keepCommonSettings writes back the common values and no project value", { timeout: 5000 }, async (t) => {
  // The check sets mode in the project and gap in the common settings; the cleanup writes back only gap, and only to the common settings.
  const { session } = await playSession(t, Session, "window-check-common-settings-restored", "wailsv3");
  await keepCommonSettings(session);
  await session.run("core.settings.set", { patch: { mode: "light" } });
  await session.run("core.settings.set", { patch: { gap: 10 }, scope: "common" });
  for (const clean of session.cleanups.reverse()) await clean();
});

test("the cleanup of keepCommonSettings restores a common value that the project overrides", { timeout: 5000 }, async (t) => {
  const { session } = await playSession(t, Session, "window-check-common-settings-overridden", "wailsv3");
  await keepCommonSettings(session);
  await session.run("core.settings.set", { patch: { mode: "light" }, scope: "common" });
  for (const clean of session.cleanups.reverse()) await clean();
});
