// The tab sessions tab-sessions/<tab>.json (docs/spec/projects.md#persistence, docs/spec/plugins.md#memory-saver): the
// session history (interactionState) of each document region of a tab. Core writes the session of a tab at a main-frame
// navigation commit of a region, at most once per second per tab, at unload and at quit, through the workspace kind
// tabSessionPut; each tab has its own file, so a write rewrites no other tab.

import { emitEvent } from "./page-log.js";

const COALESCE_MS = 1000;
/** The largest decoded session of one region that is stored, in bytes. */
export const SESSION_LIMIT = 1024 * 1024;

/** The decoded size in bytes of a base64 text. */
export function decodedBytes(text) {
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  return Math.floor(text.length * 3 / 4) - padding;
}

/**
 * Creates the tab sessions over store, which has tabSession(tab), tabSessionPut(tab, regions) and tabSessions();
 * interaction(tab) resolves the interactionState of each region of the tab, or undefined; tabs() lists the tabs that
 * have attached regions; failed reports a failed write through the error display.
 */
export function createTabSessions({ store, interaction, tabs, failed }) {
  const pending = new Map();
  // tab id -> region name -> the history of the last document state of the region, as JSON
  const histories = new Map();
  // The tabs whose file was removed: a tab id is never issued again, so a later state of a closing region writes nothing.
  const removed = new Set();
  let writing = Promise.resolve();

  // Queues one write of tab after the earlier writes; the returned promise rejects when this write fails. The queue
  // resolves to the error of a failed write instead of rejecting, so the next write still runs.
  function put(tab, regions) {
    const next = writing.then(() => store.tabSessionPut(tab, regions).then((bytes) => {
      if (regions) emitEvent("debug", "page.tab.session.stored", { tab, bytes });
      return null;
    }, (error) => error));
    writing = next;
    return next.then((error) => { if (error) throw error; });
  }

  // Reads the regions of tab and stores those of at most SESSION_LIMIT bytes; a tab without regions writes nothing.
  async function capture(tab) {
    clearTimeout(pending.get(tab));
    pending.delete(tab);
    if (removed.has(tab)) return;
    const history = await interaction(tab);
    if (!history || removed.has(tab)) return;
    const regions = {};
    for (const [region, session] of Object.entries(history)) {
      const bytes = decodedBytes(session);
      if (bytes > SESSION_LIMIT) emitEvent("warn", "page.tab.session.dropped", { tab, region, bytes });
      else regions[region] = { session };
    }
    await put(tab, Object.keys(regions).length ? regions : null);
  }

  const reported = (tab) => capture(tab).catch((error) => failed(new Error(`tab session of ${tab}: ${error.message}`)));

  function remove(tab) {
    clearTimeout(pending.get(tab));
    pending.delete(tab);
    histories.delete(tab);
    removed.add(tab);
    return put(tab, null);
  }

  return {
    /** The stored interactionState of each region of tab, {name: session}, or undefined for a tab without a file. */
    async read(tab) {
      const document = await store.tabSession(tab);
      if (document === null) return undefined;
      return Object.fromEntries(Object.entries(document.regions).map(([name, region]) => [name, region.session]));
    },
    /**
     * Takes the history {entries: [{url, title}], index} of a document state of the region name of tab; a changed index
     * or address list is a navigation commit, and the session of the tab is written at most once per second. A changed
     * title alone is no navigation.
     */
    navigated(tab, name, history) {
      if (removed.has(tab)) return;
      let regions = histories.get(tab);
      if (!regions) histories.set(tab, regions = new Map());
      const key = JSON.stringify([history.index, history.entries.map((entry) => entry.url)]);
      if (regions.get(name) === key) return;
      regions.set(name, key);
      if (pending.has(tab)) return;
      pending.set(tab, setTimeout(() => { reported(tab); }, COALESCE_MS));
    },
    /** Writes the session of tab now; the memory saver calls it before an unload, and a failure fails the unload. */
    capture,
    /** Removes the files of tabs after the layout write that drops them is confirmed; a refused write removes none. */
    async removeAfter(layoutWrite, dropped) {
      await layoutWrite;
      await Promise.all(dropped.map(remove));
    },
    /** Removes each file whose tab is not in tabIds, the tab identifiers of projects.json, with an event per file. */
    async reconcile(tabIds) {
      const orphans = (await store.tabSessions()).filter((tab) => !tabIds.has(tab));
      for (const tab of orphans) emitEvent("info", "page.tab.session.orphan", { tab });
      await Promise.all(orphans.map(remove));
    },
    /** Writes the session of every tab with attached regions now; the page calls it at quit, before the regions close. */
    async flush() {
      await Promise.all(tabs().map(reported));
    },
    /** Resolves when the writes started so far have ended. */
    idle: () => writing,
  };
}
