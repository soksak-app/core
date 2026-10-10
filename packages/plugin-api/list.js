// Updates a list in place (F67). When a redraw removes an operable element that did not change from the document and that redraw
// comes between a press and a release, WebKit does not send click (core docs/spec/exposure.md). So elements with the same key stay in the document and are
// edited, only new keys create elements, and only misordered elements are moved.

const KEY = "listKey";

/**
 * Arranges the children of list in the order of entries.
 *
 *     key(entry)            the value that identifies an element. An element with the same key is rewritten. Fails when two entries have the same key.
 *     create(entry)         creates the element of a new key.
 *     update(element, entry) edits the element to match entry. Also called for a newly created element.
 *
 * Children that are not in entries (including text nodes) are removed.
 */
export function drawList(list, entries, { key, create, update }) {
  const kept = new Map();
  for (const child of list.children) {
    if (child.dataset[KEY] !== undefined) kept.set(child.dataset[KEY], child);
  }
  const seen = new Set();
  const nodes = entries.map((entry) => {
    const id = String(key(entry));
    if (seen.has(id)) throw new Error(`drawList: key ${JSON.stringify(id)} appears twice`);
    seen.add(id);
    let node = kept.get(id);
    if (!node) {
      node = create(entry);
      node.dataset[KEY] = id;
    }
    update(node, entry);
    return node;
  });
  const wanted = new Set(nodes);
  for (const child of [...list.childNodes]) if (!wanted.has(child)) child.remove();
  nodes.forEach((node, index) => {
    // default: when index equals the number of children, that position is the end, so the element is inserted at the end with null.
    if (list.childNodes[index] !== node) list.insertBefore(node, list.childNodes[index] ?? null);
  });
}
