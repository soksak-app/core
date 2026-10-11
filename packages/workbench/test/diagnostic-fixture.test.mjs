import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareFixture } from "../diagnostic-fixture.js";

// The real `set` of the settings refuses a change that names no actor (settings.js), and a window check starts from this fixture.
function modules(calls) {
  return {
    projects: { flush: async () => {}, all: () => [], close: async () => {}, open: async (project) => { calls.push(["open", project.root]); } },
    settings: {
      defaults: { mode: "dark" },
      set: async (patch, scope, actor) => {
        if (typeof actor !== "string" || actor === "") throw new Error("set requires the actor that changes the settings");
        calls.push(["set", scope, actor, patch]);
      },
    },
    plane: { fresh: () => ({ cards: [] }) },
  };
}

test("the fixture of a window check changes the common settings as the actor diagnostics.fixture", async () => {
  const calls = [];
  const result = await prepareFixture({ root: "/tmp/project", settings: { "fixture.value": "/bin/sh" } }, modules(calls));
  assert.deepEqual(result, { root: "/tmp/project" });
  assert.deepEqual(calls[0], ["set", "common", "diagnostics.fixture", { mode: "dark", "fixture.value": "/bin/sh" }]);
  assert.deepEqual(calls[1], ["open", "/tmp/project"]);
});

test("the fixture refuses a missing root and settings that are not an object", async () => {
  await assert.rejects(prepareFixture({}, modules([])), /requires root/);
  await assert.rejects(prepareFixture({ root: "/tmp/x", settings: [] }, modules([])), /settings must be an object/);
});
