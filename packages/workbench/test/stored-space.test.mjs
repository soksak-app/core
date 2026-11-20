// Tests of the read of a stored space of projects.json (docs/spec/projects.md#persistence): the member parties belongs to no current
// form of a space object, so readStoredSpace of the projects module refuses a space that holds it with an error that names the file,
// the project root, the space and the member. The tests use real space objects in the form of projects.json.
import assert from "node:assert/strict";
import test from "node:test";
import { readStoredSpace } from "../projects.js";

const layout = {
  name: "one",
  state: { cards: [{ id: "a", data: { tabs: [{ id: "t-a", plugin: "probe-plain" }] } }, { id: "b", data: { tabs: [{ id: "t-b", plugin: "probe-plain" }] } }] },
};
const project = { id: "prj-one", root: "/work/one", title: "one" };

// contract: workbench.space.parties-refused
test("a space that holds the member parties is refused with an error that names projects.json, the project, the space and the member", () => {
  const party = { id: "p1", cards: ["a", "b"], leader: null, color: "#123456", leaderColor: null };
  for (const parties of [[], [party]]) {
    assert.throws(() => readStoredSpace(project, { id: "spc-1", title: "SPACE1", layout, parties }),
      { message: "projects.json: project /work/one, space spc-1: obsolete member parties" });
  }
});

test("a space without the member parties reads as it is stored", () => {
  const space = { id: "spc-1", title: "SPACE1", layout };
  assert.deepEqual(readStoredSpace(project, space), space);
});
