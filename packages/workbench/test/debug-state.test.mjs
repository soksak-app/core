// The state files of the debug view: parsing, the tree lines and the comparison of two files (docs/spec/debug.md).
import assert from "node:assert/strict";
import test from "node:test";
import { compareStates, parseState, stateFiles, stateLines } from "../debug-state.js";

const state = (change = {}) => JSON.stringify({
  time: "20261010T100000Z",
  host: "wailsv3",
  versions: { core: "0.0.10", plugins: [{ id: "a" }] },
  windows: [],
  page: { "core.screen": { modal: null } },
  ...change,
});

test("the state files of the file list are the state-<time>.json files of logs/ in path order", () => {
  const entries = ["logs/state-2.json", "logs/host-a.jsonl", "logs/state-1.json", "logs/captures/state-3.json", "logs/state-1.json.bak"].map((path) => ({ path }));
  assert.deepEqual(stateFiles(entries), ["logs/state-1.json", "logs/state-2.json"]);
});

test("a state file that breaks the structure is refused with its name and what was found", () => {
  assert.throws(() => parseState("logs/state-1.json", "{", false), /^Error: logs\/state-1\.json: not JSON: /);
  assert.throws(() => parseState("logs/state-1.json", "[]", false), /logs\/state-1\.json: not a state object: \[\]/);
  assert.throws(() => parseState("logs/state-1.json", state({ host: "web" }), false), /logs\/state-1\.json: host "web" is not one of wailsv3, tauriv2/);
  assert.throws(() => parseState("logs/state-1.json", JSON.stringify({ time: "t", host: "wailsv3" }), false), /logs\/state-1\.json: versions must be an object, found undefined/);
  assert.throws(() => parseState("logs/state-1.json", state(), true), /logs\/state-1\.json: the text was cut at the read limit/);
  assert.equal(parseState("logs/state-1.json", state(), false).host, "wailsv3");
});

test("the tree lines hold the depth, the key and the value of each member", () => {
  const lines = stateLines(parseState("logs/state-1.json", state(), false));
  assert.deepEqual(lines.slice(0, 7), [
    { depth: 0, key: "time", value: '"20261010T100000Z"' },
    { depth: 0, key: "host", value: '"wailsv3"' },
    { depth: 0, key: "versions", value: null, size: "{2}" },
    { depth: 1, key: "core", value: '"0.0.10"' },
    { depth: 1, key: "plugins", value: null, size: "[1]" },
    { depth: 2, key: "[0]", value: null, size: "{1}" },
    { depth: 3, key: "id", value: '"a"' },
  ]);
  assert.deepEqual(lines.at(-4), { depth: 0, key: "windows", value: "[]" });
});

test("a comparison lists the paths whose values differ, including paths present in one file", () => {
  const a = parseState("logs/state-1.json", state(), false);
  const b = parseState("logs/state-2.json", state({
    time: "20261010T110000Z",
    versions: { core: "0.0.11", plugins: [{ id: "a" }, { id: "b" }] },
    page: { "core.screen": { modal: "debug" } },
  }), false);
  assert.deepEqual(compareStates(a, b), [
    { path: "time", a: '"20261010T100000Z"', b: '"20261010T110000Z"' },
    { path: "versions.core", a: '"0.0.10"', b: '"0.0.11"' },
    { path: 'page["core.screen"].modal', a: "null", b: '"debug"' },
    { path: "versions.plugins[1].id", a: null, b: '"b"' },
  ]);
  assert.deepEqual(compareStates(a, a), []);
});
