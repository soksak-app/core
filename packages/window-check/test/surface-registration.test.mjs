// A view surface reaches the phase `ready` when it declares its composition and registers its exposure after that
// (docs/spec/native-surfaces.md), so a wait on a status of a surface starts when the surface has registered that status.
import assert from "node:assert/strict";
import test from "node:test";
import { Session } from "../app.mjs";

test("a wait on a status of a surface watches the status after the surface has registered it", { timeout: 1000 }, async () => {
  const watched = [];
  let exposes = [];
  const client = {
    endpoint: { pid: 1 },
    watch: async (window, name, predicate, { surface }) => {
      watched.push({ name, surface });
      if (name === "core.surfaces") {
        exposes = ["status probe.document"];
        const surfaces = [{ surface: "tab-1", exposes }];
        assert.equal(predicate(surfaces), true);
        return surfaces;
      }
      // The host answers a watch of a status that the surface has not registered with an error.
      if (!exposes.includes(`status ${name}`)) throw new Error(`surface ${surface} has not registered status ${name}`);
      return { path: "note.txt" };
    },
  };
  const session = new Session({ name: "wailsv3" }, client);
  assert.deepEqual(await session.until("probe.document", (value) => value.path === "note.txt", "no document", { surface: "tab-1" }),
    { path: "note.txt" });
  assert.deepEqual(watched, [{ name: "core.surfaces", surface: undefined }, { name: "probe.document", surface: "tab-1" }]);
});

test("a wait without a surface watches the status at once", { timeout: 1000 }, async () => {
  const watched = [];
  const client = { endpoint: { pid: 1 }, watch: async (window, name) => { watched.push(name); return { id: "p" }; } };
  const session = new Session({ name: "wailsv3" }, client);
  await session.until("core.project", (value) => value.id === "p", "no project");
  assert.deepEqual(watched, ["core.project"]);
});
