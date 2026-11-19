// Tests of the party storage of a space (docs/spec/parties.md#storage): the entry points readStoredSpace and writeStoredSpace of the
// projects module read and write the parties member of a space, and every refusal is the storage error of the specification.
// The tests use real space objects in the form of projects.json; the space layout is not read by these rules.
import assert from "node:assert/strict";
import test from "node:test";
import { readStoredSpace, writeStoredSpace } from "../projects.js";

const layout = {
  name: "one",
  state: { cards: [{ id: "a", data: { tabs: [{ id: "t-a", plugin: "probe-plain" }] } }, { id: "b", data: { tabs: [{ id: "t-b", plugin: "probe-plain" }] } }] },
};
const project = { id: "prj-one", root: "/work/one", title: "one" };

// contract: workbench.parties.storage
test("a space object without a parties member reads as parties []", () => {
  const space = readStoredSpace(project, { id: "spc-1", title: "SPACE1", layout });
  assert.deepEqual(space.parties, []);
});

test("saving a space without parties writes no parties member (docs/spec/parties.md#storage)", () => {
  const space = readStoredSpace(project, { id: "spc-1", title: "SPACE1", layout });
  assert.equal("parties" in writeStoredSpace(space), false);
});

test("saving a space with parties writes the member parties", () => {
  const party = { id: "p1", cards: ["a", "b"], leader: null, color: "#123456", leaderColor: null };
  const space = readStoredSpace(project, { id: "spc-1", title: "SPACE1", layout, parties: [party] });
  assert.deepEqual(writeStoredSpace(space).parties, [party]);
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
  assert.throws(() => readStoredSpace(project, { id: "spc-1", title: "SPACE1", layout, parties }),
    (error) => error instanceof Error && error.message === `projects.json: project /work/one, space spc-1: parties ${JSON.stringify(parties)}`);
});

// contract: workbench.parties.storage
test("a stored projects.json space reads its parties back with the stored color values", () => {
  const stored = JSON.parse('{"id":"spc-1","title":"SPACE1","parties":[{"id":"p1","cards":["a","b"],"leader":"a","color":"#123456","leaderColor":"#abcdef"}]}');
  const space = readStoredSpace(project, { ...stored, layout });
  assert.deepEqual(space.parties, stored.parties);
  assert.deepEqual(writeStoredSpace(space).parties, stored.parties);
});

test("a stored party color that is a theme token name is refused with the storage error of the specification", () => {
  const second = { id: "spc-1", title: "SPACE1", layout, parties: [{ id: "p1", cards: ["a", "b"], leader: null, color: "party-1", leaderColor: null }] };
  let message = null;
  try {
    readStoredSpace(project, second);
  } catch (error) {
    message = error.message;
  }
  assert.equal(message, 'projects.json: project /work/one, space spc-1: parties [{"id":"p1","cards":["a","b"],"leader":null,"color":"party-1","leaderColor":null}]');
});
