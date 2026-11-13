// The tab sessions tab-sessions/<tab>.json (docs/spec/projects.md#persistence, docs/spec/plugins.md#memory-saver): the
// session history (interactionState) of each document region of a tab. Core writes the session of a tab at a main-frame
// navigation commit of a region, at most once per second per tab, at unload and at quit, through the workspace kind
// tabSessionPut; each tab has its own file, so a write rewrites no other tab.

import { emitEvent } from "./page-log.js";

const COALESCE_MS = 1000;
/** What asks for a read of the sessions of a tab: a navigation commit, the save of a window, or the unload of a tab. */
const CAUSES = new Set(["navigation", "flush", "unload"]);
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
  // The reads and writes that are running; idle waits for them.
  const running = new Set();

  // Queues one write of tab after the earlier writes; the returned promise rejects when this write fails. The queue
  // resolves to the error of a failed write instead of rejecting, so the next write still runs.
  function put(tab, regions) {
    const next = writing.then(() => store.tabSessionPut(tab, regions).then((bytes) => {
      if (regions) emitEvent("debug", "workbench.tab.session.stored", { tab, bytes });
      return null;
    }, (error) => error));
    writing = next;
    return next.then((error) => { if (error) throw error; });
  }

  // Registers an operation for idle; the entry ends when the operation settles, whether it fulfils or rejects.
  function track(operation) {
    const ended = operation.then(() => {}, () => {});
    running.add(ended);
    ended.then(() => running.delete(ended));
    return operation;
  }

  // Reads the regions of tab and stores those of at most SESSION_LIMIT bytes; a tab without regions writes nothing.
  async function readAndStore(tab, cause) {
    if (!CAUSES.has(cause)) throw new Error(`tab session of ${tab}: the read names no known cause: ${cause}`);
    clearTimeout(pending.get(tab));
    pending.delete(tab);
    if (removed.has(tab)) return;
    emitEvent("debug", "workbench.tab.session.read", { tab, cause });
    const history = await interaction(tab);
    if (!history || removed.has(tab)) return;
    const regions = {};
    for (const [region, session] of Object.entries(history)) {
      const bytes = decodedBytes(session);
      if (bytes > SESSION_LIMIT) emitEvent("warn", "workbench.tab.session.dropped", { tab, region, bytes });
      else regions[region] = { session };
    }
    await put(tab, Object.keys(regions).length ? regions : null);
  }

  const reported = (tab, cause) => track(readAndStore(tab, cause).catch((error) => failed(new Error(`tab session of ${tab}: ${error.message}`))));

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
      pending.set(tab, setTimeout(() => { reported(tab, "navigation"); }, COALESCE_MS));
    },
    /** Writes the session of tab now for cause; the memory saver calls it before an unload, and a failure fails the unload. */
    capture: (tab, cause) => track(readAndStore(tab, cause)),
    /** Removes the files of tabs after the layout write that drops them is confirmed; a refused write removes none. */
    async removeAfter(layoutWrite, dropped) {
      await layoutWrite;
      await Promise.all(dropped.map(remove));
    },
    /** Removes each file that kept(id) does not keep (storedSurfaceKept of section-surfaces.js), with an event per file. */
    async reconcile(kept) {
      const orphans = (await store.tabSessions()).filter((tab) => !kept(tab));
      for (const tab of orphans) emitEvent("info", "workbench.tab.session.orphan", { tab });
      await Promise.all(orphans.map(remove));
    },
    /** Writes the session of every tab with attached regions now; the page calls it at quit, before the regions close. */
    async flush() {
      await Promise.all(tabs().map((tab) => reported(tab, "flush")));
    },
    /**
     * Resolves when the reads and the writes started so far have ended: the sessions that a timer or a flush started, and
     * the writes that these reads queued. A read or write started after the call is not waited for.
     */
    idle: () => Promise.all([...running]).then(() => writing),
  };
}
