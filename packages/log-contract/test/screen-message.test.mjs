// The golden messages of the screen (docs/spec/persistent-services.md#screen-message): the page reproduces the hash of the screen
// vector of each message from the message alone, and refuses each message the fixture lists as rejected with its error text.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { screenFromMessage, screenHash } from "@soksak/plugin-api/screen-hash";

const read = (name) => JSON.parse(readFileSync(new URL(`../../../docs/spec/cases/log-contract/replay/${name}`, import.meta.url), "utf8"));
const messages = read("screen-message.json");
const screens = new Map(read("screen-hash.json").vectors.map((vector) => [vector.name, vector]));

for (const vector of messages.vectors) {
  test(`the message "${vector.name}" has the hash of the screen vector of the same name`, async () => {
    const screen = screens.get(vector.screen_vector);
    assert.ok(screen, `the screen vector "${vector.screen_vector}" exists`);
    assert.equal(vector.hash, screen.hash);
    assert.equal(await screenHash(screenFromMessage(vector.message)), screen.hash);
  });
}

for (const vector of messages.rejected) {
  test(`the message "${vector.name}" is refused with the error of the fixture`, () => {
    assert.throws(() => screenFromMessage(vector.message), { message: vector.error });
  });
}

for (const document of ["../../../docs/spec/persistent-services.md", "../../../docs/spec/persistent-services.ko.md"]) {
  test(`${document.split("/").pop()} names the fixture of the screen messages, its rejected messages and the members of the message`, () => {
    const text = readFileSync(new URL(document, import.meta.url), "utf8");
    assert.ok(text.includes("`docs/spec/cases/log-contract/replay/screen-message.json`"), "the fixture of the messages is not named");
    for (const { name } of messages.rejected) assert.ok(text.includes(`\`${name}\``), `the rejected message "${name}" is not named`);
    for (const member of ["sequence", "segment", "rows", "cols", "cursor", "cells", "grapheme", "width", "fg", "bg", "attributes", "screenFromMessage"]) {
      assert.ok(text.includes(`\`${member}\``), `the member "${member}" is not named`);
    }
  });
}

test("every screen vector has a message", () => {
  assert.deepEqual(messages.vectors.map((vector) => vector.screen_vector), [...screens.keys()]);
});
