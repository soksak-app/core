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
    debug: { setDebugFixtureEntries() {} },
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
    ["workbench.fixture.step", "projects.flush", "start"], ["workbench.fixture.step", "projects.flush", "end"],
    ["workbench.fixture.step", "settings.set", "start"], ["workbench.fixture.step", "settings.set", "end"],
    ["workbench.fixture.step", "projects.open", "start"], ["workbench.fixture.step", "projects.open", "end"],
    ["workbench.fixture.step", "projects.flush", "start"], ["workbench.fixture.step", "projects.flush", "end"],
  ]);
  for (const [, fields] of records.filter(([, value]) => value.phase === "end")) {
    assert.equal(fields.error, null);
    assert.ok(Number.isInteger(fields.ms) && fields.ms >= 0, `ms of ${fields.step} is ${fields.ms}`);
  }
  const failing = { ...modules([]), settings: { defaults: {}, set: async () => { throw new Error("settings refused"); } } };
  records.length = 0;
  await assert.rejects(prepareFixture({ root: "/tmp/project" }, { ...failing, emitEvent: (level, event, fields) => records.push([event, fields]) }), /settings refused/);
  const last = records.at(-1);
  assert.deepEqual([last[0], last[1].step, last[1].phase, last[1].error], ["workbench.fixture.step", "settings.set", "end", "settings refused"]);
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
    ["workbench.fixture.step", "projects.open", "start"], ["workbench.fixture.step", "projects.open.refresh", "start"],
    ["workbench.fixture.step", "projects.open.refresh", "end"], ["workbench.fixture.step", "projects.open", "end"],
  ]);
  assert.equal(runners.at(-1), null, "the fixture left its step runner installed after it ended");
});


const debugEntries = [
  { path: "logs/design/a.log", size: 12, modified: 2000 },
  { path: "logs/design/b.log", size: 3, modified: 1000 },
];
test("diagnostics.fixture installs an explicit debug listing and the next fixture resets it", async () => {
  const supplied = [];
  const dependencies = { ...modules([]), debug: { setDebugFixtureEntries(value) { supplied.push(value); } } };
  await prepareFixture({ root: "/tmp/project", debugEntries }, dependencies);
  assert.deepEqual(supplied, [debugEntries]);
  await prepareFixture({ root: "/tmp/project" }, dependencies);
  assert.deepEqual(supplied, [debugEntries, null], "omitting the fixture must restore the live listing provider");
});
for (const [name, entries] of [
  ["non-array", {}],
  ["traversal", [{ ...debugEntries[0], path: "logs/../outside" }]],
  ["duplicate paths", [debugEntries[0], debugEntries[0]]],
  ["negative size", [{ ...debugEntries[0], size: -1 }]],
  ["fractional modified time", [{ ...debugEntries[0], modified: 1.5 }]],
]) {
  test(`diagnostics.fixture rejects debug entries with ${name} before changing projects`, async () => {
    const calls = [];
    await assert.rejects(prepareFixture({ root: "/tmp/project", debugEntries: entries }, {
      ...modules(calls), debug: { setDebugFixtureEntries() { throw new Error("must validate before installation"); } },
    }), /debugEntries/);
    assert.deepEqual(calls, []);
  });
}
