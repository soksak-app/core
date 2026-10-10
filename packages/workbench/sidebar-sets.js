// Creating, editing, and deleting the sidebar set list (docs/spec/settings.md).
//
// Takes a list and returns a new list. The set() of the settings stores it. The received list is not changed.

const LAYOUTS = ["list", "tabs"];
const TITLE_MAX = 40;

/** Appends a set with the title (the Korean text for "new set"), the layout list, and no sections at the end. The id is the smallest unused set-<n>. */
export function createSet(sets) {
  const used = new Set(sets.map((s) => s.id));
  let n = 1;
  while (used.has(`set-${n}`)) n++;
  return [...sets, { id: `set-${n}`, title: "새 세트", sections: [], layout: "list" }];
}

/** Changes the title or the layout of one set. changeRow changes the sections. */
export function updateSet(sets, id, change) {
  for (const key of Object.keys(change)) {
    if (!["title", "layout"].includes(key)) throw new Error(`set update has unknown field ${key}`);
  }
  const index = sets.findIndex((s) => s.id === id);
  if (index < 0) throw new Error(`unknown set ${id}`);
  const next = structuredClone(sets[index]);
  if (change.title !== undefined) {
    if (typeof change.title !== "string" || change.title.length < 1 || change.title.length > TITLE_MAX) {
      throw new Error(`set title must be 1 to ${TITLE_MAX} characters`);
    }
    next.title = change.title;
  }
  if (change.layout !== undefined) {
    if (!LAYOUTS.includes(change.layout)) throw new Error(`set layout must be ${LAYOUTS.join(" or ")}`);
    next.layout = change.layout;
  }
  return sets.map((s, i) => (i === index ? next : s));
}

/**
 * Changes one section row of a set (sidebar section in docs/spec/settings.md).
 *
 *   choose  changes the row index to section
 *   up      swaps the row index with the row above
 *   down    swaps the row index with the row below
 *   remove  removes the row index
 *   add     appends at the end the first registered section, in registered order, that the set does not have
 *
 * registered holds the registered section ids in the order of plugins and declarations. A change that would put the same section in twice is rejected.
 */
export function changeRow(sets, id, { action, index, section }, registered) {
  const at = sets.findIndex((s) => s.id === id);
  if (at < 0) throw new Error(`unknown set ${id}`);
  const rows = [...sets[at].sections];
  const row = () => {
    if (!Number.isInteger(index) || index < 0 || index >= rows.length) throw new Error(`set ${id} has no row ${index}`);
  };
  if (action === "choose") {
    row();
    if (!registered.includes(section)) throw new Error(`unknown section ${section}`);
    if (rows.some((other, i) => i !== index && other === section)) throw new Error(`section ${section} is already in set ${id}`);
    rows[index] = section;
  } else if (action === "up") {
    row();
    if (index === 0) throw new Error(`row ${index} cannot move up`);
    [rows[index - 1], rows[index]] = [rows[index], rows[index - 1]];
  } else if (action === "down") {
    row();
    if (index === rows.length - 1) throw new Error(`row ${index} cannot move down`);
    [rows[index], rows[index + 1]] = [rows[index + 1], rows[index]];
  } else if (action === "remove") {
    row();
    rows.splice(index, 1);
  } else if (action === "add") {
    const next = registered.find((candidate) => !rows.includes(candidate));
    if (!next) throw new Error(`set ${id} already contains every registered section`);
    rows.push(next);
  } else {
    throw new Error(`unknown row action ${action}`);
  }
  return sets.map((s, i) => (i === at ? { ...structuredClone(s), sections: rows } : s));
}

/**
 * Returns the link list with one sidebar choice changed (sidebar choice in docs/spec/settings.md).
 * choice is a set id or off. When plugin is null, it is the general choice of left or right.
 */
export function chooseLink(links, place, plugin, choice) {
  if (!["left", "right", "window-left", "window-right", "card-left", "card-right", "card-top", "card-bottom"].includes(place)) throw new Error(`unknown place ${place}`);
  const general = place === "left" || place === "right";
  if (general ? plugin !== null : plugin === null) throw new Error(`invalid plugin for ${place}`);
  if (choice === "inherit") throw new Error(`${place} has no inherit choice`);
  const rest = links.filter(link => !(link.place === place && link.plugin === plugin));
  return choice === "off" ? rest : [...rest, { place, plugin, set: choice }];
}

/**
 * Returns the set that the sidebar shows. It is null when there is none or when it is disabled.
 * The links of the general window, the plugin window, and the four sides of a card are chosen independently.
 */
export function resolveSidebar(links, sets, place, plugin) {
  const chosen = links.find(link => link.place === place && link.plugin === plugin);
  if (!chosen) return null;
  const set = sets.find((s) => s.id === chosen.set);
  if (!set) throw new Error(`link points at a set that is gone: ${chosen.set}`);
  return set;
}

/** Removes a set together with the links that point to it. */
export function deleteSet(sets, links, id) {
  if (!sets.some((s) => s.id === id)) throw new Error(`unknown set ${id}`);
  return { sets: sets.filter((s) => s.id !== id), links: links.filter((l) => l.set !== id) };
}
