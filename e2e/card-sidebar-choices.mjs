// Lets a window check turn a card sidebar off for a while, and restores the original choice even when the preparation of the check fails.

/** The card node id of the stored tree under node, which a cut holds among its kids and a box in its inner node (docs/spec/groups.md#storage). */
function cardNode(node, id) {
  if (node.card === id) return node;
  if (node.box !== undefined) return cardNode(node.inner, id);
  return node.kids?.map((kid) => cardNode(kid.node, id)).find(Boolean);
}

/**
 * Turns the sidebars of the four sides of card to off. Before changing, it reads the saved choice and registers the cleanup that restores that choice first,
 * so even when it fails midway, the cleanup restores the original choice. A side that had no explicit set returns to inherit.
 */
export async function turnOffCardSidebars(s, card) {
  const choices = cardNode((await s.get("core.layout")).state.root, card).data.sidebars;
  s.cleanup(async () => {
    for (const side of ["left", "right", "top", "bottom"]) {
      await s.run("core.card.sidebar.set", { card, side, set: choices?.[side]?.set ?? "inherit" });
    }
    await s.presented();
  });
  for (const side of ["left", "right", "top", "bottom"]) await s.run("core.card.sidebar.set", { card, side, set: "off" });
}
