// keepCommonSettings keeps the common settings of the check application: its cleanup compares the common values of
// core.settings before and after the check and writes only common values back. A value that a project of the check
// overrides is not a common value: the cleanup neither writes it into the common settings nor misses a common change under it.
import assert from "node:assert/strict";
import test from "node:test";

import { keepCommonSettings, Session } from "../app.mjs";

/** A client whose application keeps common values and the overrides of one selected project, as the page does. */
function application(common, project = {}) {
  const read = () => ({ values: { ...common, ...project }, common: { ...common }, saving: false });
  const client = {
    endpoint: { pid: 1 },
    on: () => () => {},
    watch: async (window, name) => read(),
    request: async (method, params) => {
      if (method === "status.get" && params.name === "core.settings") return read();
      if (method === "command.run" && params.name === "core.settings.set") {
        Object.assign(params.params.scope === "common" ? common : project, params.params.patch);
        return null;
      }
      throw new Error(`unexpected request ${method} ${JSON.stringify(params)}`);
    },
  };
  return new Session({ name: "wailsv3", configDir: "/unused" }, client);
}

test("the cleanup of keepCommonSettings writes back the common values and no project value", { timeout: 5000 }, async () => {
  const common = { mode: "dark", gap: 8 };
  const project = {};
  const session = application(common, project);
  await keepCommonSettings(session);
  await session.run("core.settings.set", { patch: { mode: "light" } });
  await session.run("core.settings.set", { patch: { gap: 10 }, scope: "common" });
  for (const clean of session.cleanups.reverse()) await clean();
  assert.deepEqual(common, { mode: "dark", gap: 8 }, "the common settings did not return to their values before the check");
});

test("the cleanup of keepCommonSettings restores a common value that the project overrides", { timeout: 5000 }, async () => {
  const common = { mode: "dark" };
  const session = application(common, { mode: "light" });
  await keepCommonSettings(session);
  await session.run("core.settings.set", { patch: { mode: "light" }, scope: "common" });
  for (const clean of session.cleanups.reverse()) await clean();
  assert.deepEqual(common, { mode: "dark" }, "the common value under a project override did not return to its value before the check");
});
