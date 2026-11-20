// Reads the cards of a stored layout tree, the value of core.layout and the layout of a space of projects.json (docs/spec/groups.md#storage).

/** The card nodes of the stored layout tree under node in the order of the tree: a cut holds them among its kids and a box in its inner node. */
function cardNodes(node) {
  if (node.card !== undefined) return [node];
  if (node.box !== undefined) return cardNodes(node.inner);
  if (node.cut !== undefined) return node.kids.flatMap((kid) => cardNodes(kid.node));
  throw new Error(`a node of the stored layout is no card, cut or box: ${JSON.stringify(node)}`);
}

/** The card nodes of the stored layout `{state: {root}}` in the order of the tree. */
export function storedCards(layout) {
  return cardNodes(layout.state.root);
}

/** The card node id of the stored layout `{state: {root}}`; a layout without that card is an error that names the card. */
export function storedCard(layout, id) {
  const found = storedCards(layout).find((node) => node.card === id);
  if (!found) throw new Error(`the stored layout holds no card ${id}`);
  return found;
}
