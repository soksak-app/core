// The golden vectors are named in the replay specification and its translation (docs/spec/replay.md#golden-vectors).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const hash = JSON.parse(read("../../../docs/spec/cases/log-contract/replay/screen-hash.json"));
const inputs = JSON.parse(read("../../../docs/spec/cases/log-contract/replay/inputs.json"));

for (const document of ["../../../docs/spec/replay.md", "../../../docs/spec/replay.ko.md"]) {
  test(`${document.split("/").pop()} names every vector of the screen hash, every rejected screen and the fixture of the inputs`, () => {
    const text = read(document);
    for (const { name } of [...hash.vectors, ...hash.rejected]) assert.ok(text.includes(`\`${name}\``), `the vector "${name}" is not named`);
    assert.ok(text.includes("`docs/spec/cases/log-contract/replay/inputs.json`"), "the fixture of the inputs is not named");
    for (const session of inputs.sessions) assert.ok(text.includes(`\`${session.name}\``), `the session "${session.name}" is not named`);
  });
}
