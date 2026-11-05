// The children of a tab strip across its draws. A draw that replaces a pressed element between the press and the release loses
// the click, because the browser produces a click only when both reach the same connected element.
const keys = new WeakMap();

/**
 * Makes the children of container the elements of wanted, a list of { key, create }. An element whose key the container holds
 * stays in the document untouched, and create makes the others, so the key names everything that the element shows or runs.
 */
export function keepChildren(container, wanted) {
  const held = new Map([...container.children].map((child) => [keys.get(child), child]));
  const next = wanted.map(({ key, create }) => {
    const element = held.get(key) ?? create(); // default: a key that no element holds gets a new element.
    keys.set(element, key);
    return element;
  });
  const staying = new Set(next);
  for (const child of [...container.children]) if (!staying.has(child)) child.remove();
  next.forEach((element, index) => {
    if (container.children[index] !== element) container.insertBefore(element, container.children[index] ?? null); // default: insertBefore with null appends at the end.
  });
}
