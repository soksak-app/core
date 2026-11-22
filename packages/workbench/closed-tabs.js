// The tabs that this window closed since its workbench started (docs/spec/cli.md#acting-on-a-layout). core.layout.close answers a
// repeated close of such a tab with closed true and fails for a tab that was never in the window, and no new tab takes the identifier of
// a closed tab (ids.js draws again for a taken id). The list lives while the workbench runs and is not saved; an identifier takes a few
// bytes, so the list is not bounded.
const closed = new Set();

const closeListeners = new Set();

/** Records the identifiers of tabs that this window closed: a closed tab, the tabs of a closed card, space or project. */
export function recordClosedTabs(ids) {
  for (const id of ids) {
    if (typeof id !== "string" || id === "") throw new TypeError(`a closed tab is named by its identifier, not ${JSON.stringify(id)}`);
    closed.add(id);
  }
  // Each listener receives the identifiers of one record, in the order of the record (owned-sessions.js ends the sessions of a closed owner).
  for (const listener of closeListeners) listener([...ids]);
}

/** Registers a listener of closed tabs. It returns the function that removes the listener. */
export function onTabsClosed(listener) {
  closeListeners.add(listener);
  return () => closeListeners.delete(listener);
}

/** Whether this window closed the tab id since its workbench started. */
export const tabClosed = (id) => closed.has(id);
