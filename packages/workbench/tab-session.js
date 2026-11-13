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
 * The decisions of the tab sessions as a function of the instants and the inputs that each call receives. A navigation of a
 * tab is read COALESCE_MS after its first pending navigation. A call returns the actions that the shell runs, in order:
 *   {type: "read", tab, cause}                  read the sessions of tab for a navigation (the deadline run);
 *   {type: "interaction", tab}                  read the interactionState of the regions of tab, then call regions(tab, history);
 *   {type: "write", tab, regions}               store the regions of tab; null removes its file;
 *   {type: "event", level, event, fields}       an event of the page log.
 * `deadline()` is the earliest instant at which a navigation read is due, or null; the shell runs `due` at that instant, because
 * elapsed time has no event source.
 */
export function tabSessionCore() {
  // tab -> the instant of its pending navigation read
  const pending = new Map();
  // tab id -> region name -> the history of the last document state of the region, as JSON
  const histories = new Map();
  // The tabs whose file was removed: a tab id is never issued again, so a later state of a closing region writes nothing.
  const removed = new Set();

  const remove = (tab) => {
    pending.delete(tab);
    histories.delete(tab);
    removed.add(tab);
    return { type: "write", tab, regions: null };
  };

  return {
    /**
     * Takes the history {entries: [{url, title}], index} of a document state of the region name of tab at the instant at; a changed
     * index or address list is a navigation commit, and the session of the tab is read once per second. A changed title alone is no
     * navigation.
     */
    navigated(tab, name, history, at) {
      if (removed.has(tab)) return;
      let regions = histories.get(tab);
      if (!regions) histories.set(tab, regions = new Map());
      const key = JSON.stringify([history.index, history.entries.map((entry) => entry.url)]);
      if (regions.get(name) === key) return;
      regions.set(name, key);
      if (pending.has(tab)) return;
      pending.set(tab, at + COALESCE_MS);
    },
    /** The navigation reads whose instant is not later than at. A read is taken when its read action runs. */
    due(at) {
      return [...pending].filter(([, instant]) => instant <= at).map(([tab]) => ({ type: "read", tab, cause: "navigation" }));
    },
    /** The actions that start a read of the sessions of tab for cause; the pending navigation read of tab ends. */
    read(tab, cause) {
      // The cause is checked before the pending read of the tab ends.
      if (!CAUSES.has(cause)) throw new Error(`tab session of ${tab}: the read names no known cause: ${cause}`);
      pending.delete(tab);
      if (removed.has(tab)) return [];
      return [
        { type: "event", level: "debug", event: "workbench.tab.session.read", fields: { tab, cause } },
        { type: "interaction", tab },
      ];
    },
    /** The actions that store the history of the regions of tab read by an interaction step; a tab without regions writes nothing. */
    regions(tab, history) {
      if (!history || removed.has(tab)) return [];
      const events = [];
      const regions = {};
      for (const [region, session] of Object.entries(history)) {
        const bytes = decodedBytes(session);
        if (bytes > SESSION_LIMIT) {
          events.push({ type: "event", level: "warn", event: "workbench.tab.session.dropped", fields: { tab, region, bytes } });
        } else regions[region] = { session };
      }
      return [...events, { type: "write", tab, regions: Object.keys(regions).length ? regions : null }];
    },
    /** The actions of a write that the store confirmed with its bytes; a removal confirms no event. */
    written: (tab, bytes, regions) => (regions
      ? [{ type: "event", level: "debug", event: "workbench.tab.session.stored", fields: { tab, bytes } }]
      : []),
    /** The write that removes the file of tab; its pending read and history end. */
    remove,
    /** The actions that remove each file of the listed tabs that kept(id) does not keep, with an event per file. */
    reconcile(listed, kept) {
      const orphans = listed.filter((tab) => !kept(tab));
      return [
        ...orphans.map((tab) => ({ type: "event", level: "info", event: "workbench.tab.session.orphan", fields: { tab } })),
        ...orphans.map((tab) => remove(tab)),
      ];
    },
    /** The earliest instant of a pending navigation read, or null when none is pending. */
    deadline: () => (pending.size ? Math.min(...pending.values()) : null),
  };
}

/**
 * Creates the tab sessions over store, which has tabSession(tab), tabSessionPut(tab, regions) and tabSessions();
 * interaction(tab) resolves the interactionState of each region of the tab, or undefined; tabs() lists the tabs that
 * have attached regions; failed reports a failed write through the error display.
 */
export function createTabSessions({ store, interaction, tabs, failed }) {
  const core = tabSessionCore();
  let timer = null;
  let writing = Promise.resolve();
  // The reads and writes that are running; idle waits for them.
  const running = new Set();

  function perform(actions) {
    for (const action of actions) {
      if (action.type !== "event") throw new Error(`tab session action ${action.type} is not declared`);
      emitEvent(action.level, action.event, action.fields);
    }
  }

  // The one timer of the earliest pending navigation read, re-armed after each read and each navigation.
  function arm() {
    clearTimeout(timer);
    timer = null;
    const next = core.deadline();
    if (next === null) return;
    timer = setTimeout(() => {
      timer = null;
      for (const action of core.due(performance.now())) reported(action.tab, action.cause);
      arm();
    }, Math.max(0, next - performance.now()));
  }

  // Queues one write of tab after the earlier writes; the returned promise rejects when this write fails. The queue
  // resolves to the error of a failed write instead of rejecting, so the next write still runs.
  function put(tab, regions) {
    const next = writing.then(() => store.tabSessionPut(tab, regions).then((bytes) => {
      perform(core.written(tab, bytes, regions));
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
    const actions = core.read(tab, cause);
    arm();
    for (const action of actions) {
      if (action.type === "interaction") {
        const history = await interaction(tab);
        for (const next of core.regions(tab, history)) {
          if (next.type === "write") await put(next.tab, next.regions);
          else perform([next]);
        }
      } else perform([action]);
    }
  }

  const reported = (tab, cause) => track(readAndStore(tab, cause).catch((error) => failed(new Error(`tab session of ${tab}: ${error.message}`))));

  function removeTab(tab) {
    const action = core.remove(tab);
    arm();
    return put(action.tab, action.regions);
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
      core.navigated(tab, name, history, performance.now());
      arm();
    },
    /** Writes the session of tab now for cause; the memory saver calls it before an unload, and a failure fails the unload. */
    capture: (tab, cause) => track(readAndStore(tab, cause)),
    /** Removes the files of tabs after the layout write that drops them is confirmed; a refused write removes none. */
    async removeAfter(layoutWrite, dropped) {
      await layoutWrite;
      await Promise.all(dropped.map(removeTab));
    },
    /** Removes each file that kept(id) does not keep (storedSurfaceKept of section-surfaces.js), with an event per file. */
    async reconcile(kept) {
      const actions = core.reconcile(await store.tabSessions(), kept);
      arm();
      await Promise.all(actions.map((action) => (action.type === "event" ? perform([action]) : put(action.tab, action.regions))));
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
