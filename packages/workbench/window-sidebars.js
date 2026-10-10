// Manages the content override and the per-side width of the fixed left and right sidebars.
export function windowSidebar(id) {
  return id === "left" || id === "right" ? { side: id, plugin: null } : null;
}

export function windowSidebarCards(units, links, focused = null) {
  // When the focus is on a tab of a plugin that is not loaded, the link of that plugin chooses no content and the general choice is shown
  // (docs/spec/plugins.md).
  const focusedPlugin = focused !== null && units.some(unit => unit.id === focused) ? focused : null;
  const out = [];
  for (const side of ["left", "right"]) {
    const choices = links.filter(link => link.place === side || link.place === `window-${side}`);
    if (!choices.length) continue;
    const override = focusedPlugin === null ? undefined : choices.find(link => link.place === `window-${side}` && link.plugin === focusedPlugin);
    const general = choices.find(link => link.place === side && link.plugin === null);
    // default: without an override of the focused plugin, the general choice is used (docs/spec/external-sidebars.md).
    const chosen = override ?? general;
    // default: without a choice, that fixed sidebar has no content set.
    out.push({ id: side, side, plugin: override ? focusedPlugin : null, set: chosen?.set ?? null });
  }
  return out;
}

export function restoreWindowSidebars(saved) {
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) throw new Error("invalid window sidebar records");
  const out = {};
  for (const [id, record] of Object.entries(saved)) {
    if (!windowSidebar(id)) throw new Error(`unknown window sidebar ${id}`);
    if (!record || typeof record !== "object" || Array.isArray(record) || Object.keys(record).some(key => key !== "width") ||
        !Number.isFinite(record.width) || record.width <= 0) throw new Error(`invalid window sidebar ${id}`);
    out[id] = { width: record.width };
  }
  return out;
}

export function reconcileWindowSidebars(records, descriptors, initialWidth) {
  if (!Number.isFinite(initialWidth) || initialWidth <= 0) throw new Error("invalid initial window sidebar width");
  for (const descriptor of descriptors) {
    if (!windowSidebar(descriptor.id)) throw new Error(`unknown window sidebar ${descriptor.id}`);
    // default: a fixed sidebar without a width record starts with the initial width.
    records[descriptor.id] ??= { width: initialWidth };
  }
}

/**
 * Returns the link that chooses the set that the fixed sidebar place shows. It is the window-* link if the override of the focused plugin applies,
 * otherwise the general link, and null if there is no set. An unknown place is an exception.
 */
export function standingLink(place, descriptors) {
  const descriptor = descriptors.find(item => item.id === place);
  if (!descriptor) throw new Error(`unknown window sidebar ${place}`);
  if (descriptor.set === null) return null;
  return descriptor.plugin === null ? { place: descriptor.side, plugin: null } : { place: `window-${descriptor.side}`, plugin: descriptor.plugin };
}

/** The fixed sidebars to bind with the focused card by the rail. Only sidebars to which a plugin override applied and that are in the plane are bound. */
export function railSidebars(descriptors, present) {
  return descriptors.filter(item => item.plugin !== null && present(item.id)).map(item => item.id);
}

/** Copies the width drawn on the fixed sidebar cards of the plane into the records records. */
export function keepWindowSidebarWidths(cards, records) {
  for (const card of cards.filter(card => windowSidebar(card.id))) {
    if (card.width !== undefined) records[card.id].width = card.width;
  }
}

/**
 * Matches the fixed sidebar columns to the choice. The column of a side where shown(side) is false is removed with dismiss, and if there is no column to show, one is put on that
 * edge of the side with the stored width. Columns are moved only when the order differs, and a change of focus or override does not move columns.
 */
export function arrangeWindowSidebars(grid, descriptors, records, initialWidth, shown, dismiss) {
  reconcileWindowSidebars(records, [...descriptors, ...grid.cards.filter(card => windowSidebar(card.id)).map(card => ({ id: card.id, ...windowSidebar(card.id) }))], initialWidth);
  keepWindowSidebarWidths(grid.cards, records);
  for (const card of [...grid.cards].filter(card => windowSidebar(card.id))) {
    if (!descriptors.some(item => item.id === card.id && shown(item.side))) dismiss(card.id);
  }
  for (const side of ["left", "right"]) {
    const desired = descriptors.filter(item => item.side === side && shown(side));
    for (const item of desired) {
      if (!grid.card(item.id)) {
        const line = side === "left" ? 0 : grid.lines("x").length - 1;
        if (!grid.canInsertAt("x", line)) throw new Error(`cannot place window sidebar ${item.id}`);
        grid.insertAt("x", line, { id: item.id, data: null, size: records[item.id].width });
        grid.setFixed(item.id, true);
      }
    }
    const actual = grid.cards.filter(card => windowSidebar(card.id)?.side === side).sort((a,b) => a.c0-b.c0).map(card => card.id);
    const expected = (side === "left" ? desired : [...desired].reverse()).map(item => item.id);
    if (JSON.stringify(actual) === JSON.stringify(expected)) continue;
    for (const item of [...desired].reverse()) {
      const card = grid.card(item.id);
      if ((side === "left" && card.c0 !== 0) || (side === "right" && card.c1 !== grid.lines("x").length - 1)) {
        if (!grid.moveTo(item.id, "x", side === "left" ? 0 : grid.lines("x").length - 1)) throw new Error(`cannot order window sidebar ${item.id}`);
      }
    }
  }
}
