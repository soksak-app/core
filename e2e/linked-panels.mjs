// Checks that a card sidebar made only by a link receives the collapse and size commands without an explicit specification. A window check and the unit check of that checker
// share this function.
import assert from "node:assert/strict";

/** Checks the linked sidebars of the four sides on the first active plugin card of session s. name is the application name used in diagnostics. */
export async function checkLinkedPanels(s, t, name) {
  const settings = await s.get("core.settings");
  const set = settings.values.sets[0];
  assert.ok(set, "no sidebar set in the fixture");
  const grid = await s.get("core.grid");
  const card = grid.cards.find((item) => item.tabs?.some((tab) => tab.id === item.active && tab.plugin));
  assert.ok(card, "no card with a declared active plugin");
  const plugin = card.tabs.find((tab) => tab.id === card.active).plugin;
  const failures = [];
  for (const side of ["top", "bottom", "left", "right"]) {
    await s.run("core.card.sidebar.set", { card: card.id, side, set: "inherit" });
    // Writing the whole settings is an independent public input path equal to the link stored in the file.
    const links = (await s.get("core.settings")).values.links.filter((link) =>
      !(link.place === `card-${side}` && link.plugin === plugin));
    links.push({ place: `card-${side}`, plugin, set: set.id });
    await s.run("core.settings.set", { patch: { links }, scope: "common" });
    await s.until("core.grid", (value) =>
      value.cards.find((item) => item.id === card.id)?.sidebars?.[side]?.set === set.id,
    `linked ${side} panel did not appear`);
    // The failure of one command does not skip the observation of the other commands. The check reports all errors and fails at the end.
    // A click (toggle) inverts the visible state and stores it, and a drag (size) stores the size and the expansion (docs/spec/example-model.md).
    const shownCollapsed = async () => (await s.get("core.grid")).cards.find((item) => item.id === card.id).sidebars[side].collapsed;
    for (const [command, extra] of [["core.card.sidebar.toggle", {}], ["core.card.sidebar.size", { size: 260 }]]) {
      const start = performance.now();
      t.diagnostic(`start ${name}/${side}/${command}`);
      try {
        const before = await shownCollapsed();
        const stored = command === "core.card.sidebar.toggle" ? !before : false;
        await s.run(command, { card: card.id, side, ...extra });
        await s.until("core.grid", (value) => {
          const panel = value.cards.find((item) => item.id === card.id)?.sidebars?.[side];
          return panel?.set === set.id && panel.requestedCollapsed === stored && (command !== "core.card.sidebar.size" || panel.size === 260);
        }, `linked ${side} panel did not apply ${command}`);
        const layout=await s.get('core.layout');
        const saved=layout.state.cards.find(item=>item.id===card.id).data.sidebars[side];
        assert.equal(Object.hasOwn(saved,'set'),false,`${command} made the ${side} derived set explicit`);
        assert.equal(saved.collapsed,stored,`${command} did not save the ${side} fold choice ${stored}`);
        if(command==='core.card.sidebar.size')assert.equal(saved.size,260,`${side} resized presentation was not saved`);
        t.diagnostic(`saved ${name}/${side}/${command}: ${JSON.stringify(saved)}`);
        t.diagnostic(`pass ${name}/${side}/${command} ${Math.round(performance.now() - start)}ms`);
      } catch (error) {
        const failure = `${name}/${side}/${command}: ${error.message}`;
        failures.push(failure);
        t.diagnostic(`fail ${failure} ${Math.round(performance.now() - start)}ms`);
      }
    }
  }
  assert.deepEqual(failures, [], "linked panels must accept fold and size without an explicit assignment");
}
