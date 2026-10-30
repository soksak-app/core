import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareFixture } from "../diagnostic-fixture.js";

// The real `set` of the settings refuses a change that names no actor (settings.js), and a window check starts from this fixture.
function modules(calls) {
  return {
    projects: {
      flush: async () => {}, all: () => [], close: async () => {}, open: async (project) => { calls.push(["open", project.root]); },
      runSteps: () => {},
    },
    settings: {
      defaults: { mode: "dark" },
      set: async (patch, scope, actor) => {
        if (typeof actor !== "string" || actor === "") throw new Error("set requires the actor that changes the settings");
        calls.push(["set", scope, actor, patch]);
      },
    },
    plane: { fresh: () => ({ cards: [] }) },
    emitEvent: () => {},
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

test("each awaited step of the fixture records its start and its end with the elapsed time and the error", async () => {
  const records = [];
  await prepareFixture({ root: "/tmp/project" }, { ...modules([]), emitEvent: (level, event, fields) => records.push([event, fields]) });
  assert.deepEqual(records.map(([event, fields]) => [event, fields.step, fields.phase]), [
    ["page.fixture.step", "projects.flush", "start"], ["page.fixture.step", "projects.flush", "end"],
    ["page.fixture.step", "settings.set", "start"], ["page.fixture.step", "settings.set", "end"],
    ["page.fixture.step", "projects.open", "start"], ["page.fixture.step", "projects.open", "end"],
    ["page.fixture.step", "projects.flush", "start"], ["page.fixture.step", "projects.flush", "end"],
  ]);
  for (const [, fields] of records.filter(([, value]) => value.phase === "end")) {
    assert.equal(fields.error, null);
    assert.ok(Number.isInteger(fields.ms) && fields.ms >= 0, `ms of ${fields.step} is ${fields.ms}`);
  }
  const failing = { ...modules([]), settings: { defaults: {}, set: async () => { throw new Error("settings refused"); } } };
  records.length = 0;
  await assert.rejects(prepareFixture({ root: "/tmp/project" }, { ...failing, emitEvent: (level, event, fields) => records.push([event, fields]) }), /settings refused/);
  const last = records.at(-1);
  assert.deepEqual([last[0], last[1].step, last[1].phase, last[1].error], ["page.fixture.step", "settings.set", "end", "settings refused"]);
});

test("the awaited steps of the project operations that the fixture runs are recorded as steps of the fixture", async () => {
  const records = [];
  const runners = [];
  const base = modules([]);
  const projects = {
    ...base.projects,
    runSteps: (runner) => runners.push(runner),
    // The open of the fixture runs one awaited step of the project operation through the installed runner.
    open: async () => runners.at(-1)("projects.open.refresh", async () => {}),
  };
  await prepareFixture({ root: "/tmp/project" }, { ...base, projects, emitEvent: (level, event, fields) => records.push([event, fields.step, fields.phase]) });
  assert.deepEqual(records.slice(4, 8), [
    ["page.fixture.step", "projects.open", "start"], ["page.fixture.step", "projects.open.refresh", "start"],
    ["page.fixture.step", "projects.open.refresh", "end"], ["page.fixture.step", "projects.open", "end"],
  ]);
  assert.equal(runners.at(-1), null, "the fixture left its step runner installed after it ended");
});
