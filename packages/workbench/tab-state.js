// The tab state store tab-state.json of the memory saver (docs/spec/projects.md#persistence, docs/spec/plugins.md#memory-saver).
// The entries live in memory; the store writes the entry of a tab through the workspace kind tabStatePut at most once
// per second and at quit.

import { emitEvent } from "./page-log.js";

const FILE = "tab-state.json";
const FORMAT = 1;
const COALESCE_MS = 1000;

/** Returns the entries of a stored document, {} for a missing file; refuses a document of another format. */
export function checkTabStateDocument(document) {
  if (document === null) return {};
  if (!Object.hasOwn(document, "format")) throw new Error(`${FILE}: tab state format missing is not ${FORMAT}`);
  if (document.format !== FORMAT) throw new Error(`${FILE}: tab state format ${JSON.stringify(document.format)} is not ${FORMAT}`);
  const tabs = document.tabs;
  if (!tabs || typeof tabs !== "object" || Array.isArray(tabs)) throw new Error(`${FILE}: tab state tabs is not an object`);
  return tabs;
}

/**
 * The decisions of the tab state store as a function of the instants that each call receives. A change of a tab is written
 * COALESCE_MS after its first pending change; a call returns the actions that the shell runs, in order:
 *   {type: "write", tab, entry}                 store the entry of tab; null removes its entry from the file;
 *   {type: "event", level, event, fields}       an event of the page log;
 *   {type: "failed", error}                     a failed write for the error display of the page.
 * `deadline()` is the earliest instant at which a pending write is due, or null; the shell runs `due` at that instant, because
 * elapsed time has no event source.
 */
export function tabStateCore(initial) {
  const entries = new Map(initial);
  // tab -> the instant at which its pending entry is written
  const pending = new Map();

  // default: a tab without an entry is written as null, which removes its entry from the file.
  const write = (tab) => ({ type: "write", tab, entry: entries.get(tab) ?? null });

  // The write that removes the entry of tab, which is no longer pending.
  const remove = (tab) => {
    pending.delete(tab);
    entries.delete(tab);
    return [write(tab)];
  };

  return {
    /** The entry of tab, or null. */
    // default: a tab without an entry reads null (docs/spec/projects.md#persistence).
    entry: (tab) => entries.get(tab) ?? null,
    /** The cached label of tab, or null. */
    // default: a tab without an entry or a label shows no cached label.
    label: (tab) => entries.get(tab)?.label ?? null,
    /** Whether tab has an entry or a pending write. */
    known: (tab) => entries.has(tab) || pending.has(tab),
    /** Sets (value) or removes (undefined) one field of the entry of tab at the instant at; an entry without fields is removed. */
    change(tab, field, value, at) {
      const entry = { ...entries.get(tab) };
      if (value === undefined) delete entry[field];
      else entry[field] = value;
      if (Object.keys(entry).length) entries.set(tab, entry);
      else entries.delete(tab);
      if (!pending.has(tab)) pending.set(tab, at + COALESCE_MS);
    },
    /** The writes whose instant is not later than at; each write is taken once. */
    due(at) {
      const tabs = [...pending].filter(([, instant]) => instant <= at).map(([tab]) => tab);
      for (const tab of tabs) pending.delete(tab);
      return tabs.map(write);
    },
    /** The writes of every pending entry now (quit). */
    flush() {
      const tabs = [...pending.keys()];
      pending.clear();
      return tabs.map(write);
    },
    /** The write that removes the entry of tab. */
    remove,
    /** Removes each entry that kept(id) does not keep, with an event per entry. */
    reconcile(kept) {
      const orphans = [...entries.keys()].filter((tab) => !kept(tab));
      return [
        ...orphans.map((tab) => ({ type: "event", level: "info", event: "workbench.tab.state.orphan", fields: { tab } })),
        ...orphans.flatMap(remove),
      ];
    },
    /** The actions of a write that the store confirmed with its bytes. */
    written: (tab, bytes) => [{ type: "event", level: "debug", event: "workbench.tab.state.stored", fields: { tab, bytes } }],
    /** The actions of a write that the store refused. */
    failed: (tab, error) => [{ type: "failed", error: new Error(`tab state of ${tab}: ${error.message}`) }],
    /** The earliest instant of a pending write, or null when none is pending. */
    deadline: () => (pending.size ? Math.min(...pending.values()) : null),
  };
}

/**
 * Reads the store and returns its entries. store has tabState() and tabStatePut(tab, entry);
 * failed reports a failed write through the error display; unloadOf(plugin) returns the
 * surface.unload declaration of a plugin.
 */
export async function openTabStates({ store, failed, unloadOf }) {
  const core = tabStateCore(Object.entries(checkTabStateDocument(await store.tabState())));
  let timer = null;
  let writing = Promise.resolve();

  function perform(actions) {
    for (const action of actions) {
      if (action.type === "write") {
        writing = writing.then(async () => {
          try {
            const bytes = await store.tabStatePut(action.tab, action.entry);
            perform(core.written(action.tab, bytes));
          } catch (error) {
            perform(core.failed(action.tab, error));
          }
        });
      } else if (action.type === "event") emitEvent(action.level, action.event, action.fields);
      else if (action.type === "failed") failed(action.error);
      else throw new Error(`tab state action ${action.type} is not declared`);
    }
  }

  // The one timer of the earliest pending write, re-armed after each change of the entries.
  function arm() {
    clearTimeout(timer);
    timer = null;
    const next = core.deadline();
    if (next === null) return;
    timer = setTimeout(() => {
      timer = null;
      perform(core.due(performance.now()));
      arm();
    }, Math.max(0, next - performance.now()));
  }

  function change(tab, field, value) {
    core.change(tab, field, value, performance.now());
    arm();
  }

  return {
    /** The entry of tab, or null. */
    entry: (tab) => core.entry(tab),
    /** The cached label of tab, or null. */
    label: (tab) => core.label(tab),
    /** Stores the state {format, value} that the plugin of tab wrote. */
    write: (tab, state) => change(tab, "state", state),
    /** Sets or clears the mark kept of tab. */
    setKept: (tab, kept) => change(tab, "kept", kept ? true : undefined),
    /** Keeps the reported title of tab as its label when its plugin declares surface.unload; null removes it. */
    cacheLabel(tab, plugin, text) {
      if (!unloadOf(plugin)) return;
      change(tab, "label", text === null ? undefined : text);
    },
    /** Removes the entries of tabs after the layout write that drops them is confirmed; a refused write removes none. */
    async removeAfter(layoutWrite, tabs) {
      await layoutWrite;
      for (const tab of tabs.filter((id) => core.known(id))) perform(core.remove(tab));
      arm();
      await writing;
    },
    /** Removes each entry that kept(id) does not keep (storedSurfaceKept of section-surfaces.js), with an event per entry. */
    async reconcile(kept) {
      perform(core.reconcile(kept));
      arm();
      await writing;
    },
    /** Writes every pending entry now; the page calls it at quit. */
    flush() {
      perform(core.flush());
      arm();
      return writing;
    },
    /** Resolves when the writes started so far have ended. */
    idle: () => writing,
  };
}
