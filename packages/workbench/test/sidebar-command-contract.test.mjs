import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createRegistry } from "../exposure.js";

const declarations = JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes;
const fixture = () => {
  const registry = createRegistry();
  registry.declare("core", declarations);
  const saved = [];
  registry.command("core.settings.link", (params) => { saved.push(params); return null; });
  return { registry, saved };
};

test("declared sidebar command admits all card sides to the persistence boundary", async () => {
  const { registry, saved } = fixture();
  for (const place of ["card-left", "card-right", "card-top", "card-bottom"]) {
    const params = { place, plugin: "fixture", set: "fixture.main", scope: "common" };
    assert.deepEqual(await registry.handle({ method: "command.run", params: { name: "core.settings.link", params } }),
      { result: null }, `${place} was rejected before persistence`);
  }
  assert.deepEqual(saved.map(({ place }) => place), ["card-left", "card-right", "card-top", "card-bottom"]);
});

test("declared sidebar command rejects obsolete rail and invalid places without writing", async () => {
  const { registry, saved } = fixture();
  for (const place of ["rail", "middle"]) {
    const reply = await registry.handle({ method: "command.run", params: { name: "core.settings.link",
      params: { place, plugin: "fixture", set: "fixture.main", scope: "common" } } });
    assert.ok(reply.error, `${place} reached persistence`);
  }
  assert.deepEqual(saved, []);
});
