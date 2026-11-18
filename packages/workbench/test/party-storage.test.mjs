// Red tests of the party storage of a space (docs/spec/parties.md#storage). The entry points readStoredSpace and writeStoredSpace of
// the projects module are named by the specification and do not exist yet, so the import fails on the unchanged implementation.
// The tests use real space objects in the form of projects.json; the space layout is not read by these rules.
import assert from "node:assert/strict";
import test from "node:test";
import { readStoredSpace, writeStoredSpace } from "../projects.js";

const layout = {
  name: "one",
  state: { cards: [{ id: "a", data: { tabs: [{ id: "t-a", plugin: "probe-plain" }] } }, { id: "b", data: { tabs: [{ id: "t-b", plugin: "probe-plain" }] } }] },
};
const project = { id: "prj-one", root: "/work/one", title: "one" };

test("a space object without a parties member reads as parties []", () => {
  const space = readStoredSpace(project, { id: "spc-1", title: "SPACE1", layout });
  assert.deepEqual(space.parties, []);
});

test("saving a space that read as parties [] writes the member parties []", () => {
  const space = readStoredSpace(project, { id: "spc-1", title: "SPACE1", layout });
  assert.deepEqual(writeStoredSpace(space).parties, []);
});

test("an explicit null parties member is refused with an error that names projects.json, the project, the space and the found value", () => {
  assert.throws(() => readStoredSpace(project, { id: "spc-1", title: "SPACE1", layout, parties: null }),
    (error) => error instanceof Error && /projects\.json/.test(error.message) && /\/work\/one/.test(error.message)
      && /spc-1/.test(error.message) && /null/.test(error.message));
});

test("a malformed parties member is refused with an error that names projects.json, the project, the space and the found value", () => {
  assert.throws(() => readStoredSpace(project, { id: "spc-1", title: "SPACE1", layout, parties: { id: "p1" } }),
    (error) => error instanceof Error && /projects\.json/.test(error.message) && /\/work\/one/.test(error.message)
      && /spc-1/.test(error.message) && /\{"id":"p1"\}/.test(error.message));
});

test("a party record with fewer than 2 cards is refused when the space is read", () => {
  const parties = [{ id: "p1", cards: ["a"], leader: null, color: "#112233", leaderColor: null }];
  assert.throws(() => readStoredSpace(project, { id: "spc-1", title: "SPACE1", layout, parties }), /a party needs at least 2 cards/);
});
