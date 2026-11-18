// Unit test of the work state of a card and of core.parties (docs/spec/parties.md#host-calls, docs/spec/exposure.md). The registry is the
// real createRegistry of exposure.js. Its call argument is the sink for the calls the registry emits: the sink records each call in
// order and creates no response. parties.js is the real module, and its grid is a real Soksak grid. A work change of a card is a value of
// its tab surface, which the registry delivers through changed; it changes no party.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Soksak } from "soksak";
import { createRegistry } from "../exposure.js";
import { THEMES, value } from "../settings.js";

const isPartiesChange = (call) => call.name === "exposureChanged" && call.arg.name === "core.parties" && !("surface" in call.arg);

test("a work change of a card sends no exposureChanged for core.parties until the next composition change", { timeout: 10000 }, async () => {
  const parties = await import("../parties.js").catch((error) => ({ error }));
  assert.equal(typeof parties.installParties, "function", "parties.js exports installParties");

  const sent = [];
  const errors = [];
  const registry = createRegistry({
    call: (name, arg) => {
      sent.push({ name, arg });
      return new Promise(() => {});
    },
    report: (error) => errors.push(error),
  });
  registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
  registry.declare("probe-plain", { status: [{ name: "probe-plain.busy", description: "Busy.", schema: { type: "boolean" } }], commands: [], element: [] });
  registry.configure({ surfacePlugin: (surface) => (surface === "tab-a" ? "probe-plain" : null) });

  // The status watch of the registry: each subscriber is run when the parties change, as coreChanged runs the watchers of the page. The
  // subscriber reads the value and passes it to the notifier, as the status helper of core-exposure.js does.
  const subscribers = new Set();
  const grid = new Soksak({
    xs: [0, 1, 2, 3, 4, 5],
    ys: [0, 1],
    cards: [
      { id: "a", c0: 0, c1: 1, r0: 0, r1: 1 },
      { id: "b", c0: 1, c1: 2, r0: 0, r1: 1 },
      { id: "c", c0: 3, c1: 4, r0: 0, r1: 1 },
      { id: "d", c0: 4, c1: 5, r0: 0, r1: 1 },
    ],
  }, { gap: 0 });
  grid.resize(1000, 600);
  parties.installParties({
    status: (name, read) => registry.status(name, read, (notify) => {
      const run = () => notify(read());
      subscribers.add(run);
      return () => subscribers.delete(run);
    }),
    registry,
    notifyChange: () => {
      for (const run of [...subscribers]) run();
    },
    grid: () => grid,
    // The palette of the shown theme and mode, as core-exposure passes it (docs/spec/parties.md#commands).
    palette: () => THEMES.find((theme) => theme.name === value("theme"))[value("mode")],
  });

  await registry.handle({ id: 1, method: "status.watch", params: { name: "core.parties" } });
  await registry.run("core.party.create", { cards: ["a", "b"] });
  await registry.run("core.party.create", { cards: ["c", "d"] });
  const before = sent.length;

  // The work change of the card a: its tab surface reports probe-plain.busy.
  registry.registered({ surface: "tab-a", kind: "status", name: "probe-plain.busy" });
  registry.changed({ surface: "tab-a", name: "probe-plain.busy", value: true, version: 1 });
  assert.deepEqual(sent.slice(before).filter(isPartiesChange), [], "the work change sends no exposureChanged for core.parties");

  // The next composition change: the party p1 is deleted, and the watch of core.parties receives its new value.
  await registry.run("core.party.delete", { party: "p1" });
  const next = sent.slice(before).filter(isPartiesChange);
  assert.equal(next.length, 1, "the composition change sends one exposureChanged for core.parties");
  assert.deepEqual(next[0].arg.value.map((party) => party.id), ["p2"]);
  assert.deepEqual(errors, []);
});
