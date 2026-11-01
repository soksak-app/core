// The golden messages of the screen (docs/spec/persistent-services.md#screen-message): the page reproduces the hash of the screen
// vector of each message from the message alone, and refuses each message the fixture lists as rejected with its error text.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { applyScreenMessage, screenHash } from "@soksak/plugin-api/screen-hash";

const read = (name) => JSON.parse(readFileSync(new URL(`../../../docs/spec/cases/log-contract/replay/${name}`, import.meta.url), "utf8"));
const messages = read("screen-message.json");
const screens = new Map(read("screen-hash.json").vectors.map((vector) => [vector.name, vector]));

for (const vector of messages.vectors) {
  test(`the message "${vector.name}" has the hash of the screen vector of the same name`, async () => {
    const screen = screens.get(vector.screen_vector);
    assert.ok(screen, `the screen vector "${vector.screen_vector}" exists`);
    assert.equal(vector.hash, screen.hash);
    assert.equal(await screenHash(applyScreenMessage(null, vector.message).screen), screen.hash);
  });
}

for (const vector of messages.rejected) {
  test(`the message "${vector.name}" is refused with the error of the fixture`, () => {
    assert.throws(() => applyScreenMessage(null, vector.message), { message: vector.error });
  });
}

for (const sequence of messages.changes) {
  test(`the changes "${sequence.name}" give the hash of each screen, which is the hash of the full screen with the changed rows`, async () => {
    let previous = null;
    const hashes = [];
    for (const message of sequence.messages) {
      previous = applyScreenMessage(previous, message);
      hashes.push(await screenHash(previous.screen));
    }
    assert.deepEqual(hashes, sequence.hashes);
    // The same screen as a full message: the first message with the rows of each change and the last cursor.
    const [first, ...changes] = sequence.messages;
    const cells = first.cells.slice();
    for (const change of changes) for (const { row, cells: rowCells } of change.changed) cells.splice(row * first.cols, first.cols, ...rowCells);
    const full = { ...first, sequence: changes.at(-1).sequence, cursor: changes.at(-1).cursor, cells };
    assert.equal(await screenHash(applyScreenMessage(null, full).screen), sequence.hashes.at(-1));
  });
}

for (const vector of messages.refused_changes) {
  test(`the change "${vector.name}" is refused with the error of the fixture`, () => {
    assert.throws(() => applyScreenMessage(applyScreenMessage(null, vector.previous), vector.message), { message: vector.error });
  });
}

for (const document of ["../../../docs/spec/persistent-services.md", "../../../docs/spec/persistent-services.ko.md"]) {
  test(`${document.split("/").pop()} names the fixture of the screen messages, its rejected messages and the members of the message`, () => {
    const text = readFileSync(new URL(document, import.meta.url), "utf8");
    assert.ok(text.includes("`docs/spec/cases/log-contract/replay/screen-message.json`"), "the fixture of the messages is not named");
    for (const { name } of [...messages.rejected, ...messages.changes, ...messages.refused_changes]) assert.ok(text.includes(`\`${name}\``), `the rejected message "${name}" is not named`);
    for (const member of ["sequence", "segment", "rows", "cols", "cursor", "cells", "grapheme", "width", "fg", "bg", "attributes", "base", "changed", "previous", "applyScreenMessage"]) {
      assert.ok(text.includes(`\`${member}\``), `the member "${member}" is not named`);
    }
  });
}

test("every screen vector has a message", () => {
  assert.deepEqual(messages.vectors.map((vector) => vector.screen_vector), [...screens.keys()]);
});
