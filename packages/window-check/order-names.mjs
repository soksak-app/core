// Order names of the ids that differ per window (F495). Two hosts give the same project, space and card different ids, so
// a check that compares their records replaces each id by its kind and its order of first appearance.

const ID = /(prj|spc|tab)-[a-z0-9]+/g;

/** A function that replaces each project, space and card id of a text by its order name; the names persist across calls. */
export function orderNames() {
  const names = new Map();
  const counts = new Map();
  return (text) => text.replace(ID, (id, kind) => {
    if (!names.has(id)) {
      const count = counts.get(kind) ?? 0;
      counts.set(kind, count + 1);
      names.set(id, `${kind}-${count}`);
    }
    return names.get(id);
  });
}
