// The replay specification and the event catalog state the generic replay rules: the replay executable is the replay engine of its sidecar, and the layer of a page frame is plugin (docs/spec/replay.md#replay-executable, docs/spec/events.json).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const replay = read("../../../docs/spec/replay.md");
const catalog = JSON.parse(read("../../../docs/spec/events.json"));

test("the replay executable is the replay engine of its sidecar and names no terminal engine", () => {
  assert.ok(!replay.includes("terminal engine"), "replay.md still names a terminal engine");
  assert.ok(replay.includes("The executable is the replay engine of the sidecar, so the command line tool names none."));
});

test("the first divergence event names the layer of a page frame as plugin, the layer that replay.md states", () => {
  const description = catalog.events["sok.replay.divergence"].description;
  assert.ok(description.includes("(`sidecar` or `plugin`)"), description);
  assert.ok(!description.includes("`page`"), description);
  assert.ok(replay.includes("so it has the layer `plugin`"));
});
