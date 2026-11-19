// Red test of the card menu of the party items (docs/spec/parties.md#card-menu). The menu holds four items, each an element with the
// name given by the specification and the command it runs: core.party.menu.group runs core.party.create, core.party.menu.leader runs
// core.party.update, core.party.menu.color runs core.party.update and core.party.menu.take runs core.party.add. Each element name is
// declared in exposure.json, which the binder audit (core.workbench.audit) checks against the bindings of the page.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const exposes = JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes;
const elements = new Set(exposes.element.map((entry) => entry.name));

for (const name of ["core.party.menu.group", "core.party.menu.leader", "core.party.menu.color", "core.party.menu.take"]) {
  test(`card menu element ${name} is declared (docs/spec/parties.md#card-menu)`, () => {
    assert.ok(elements.has(name), `${name} is declared as an element of exposure.json`);
  });
}
