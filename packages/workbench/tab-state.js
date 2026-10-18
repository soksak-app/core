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
 * Reads the store and returns its entries. store has tabState() and tabStatePut(tab, entry);
 * failed reports a failed write through the error display; unloadOf(plugin) returns the
 * surface.unload declaration of a plugin.
 */
export async function openTabStates({ store, failed, unloadOf }) {
  const entries = new Map(Object.entries(checkTabStateDocument(await store.tabState())));
  const pending = new Map();
  let writing = Promise.resolve();

  function put(tab) {
    // default: a tab without an entry is written as null, which removes its entry from the file.
    const entry = entries.get(tab) ?? null;
    writing = writing.then(async () => {
      try {
        const bytes = await store.tabStatePut(tab, entry);
        emitEvent("debug", "page.tab.state.stored", { tab, bytes });
      } catch (error) {
        failed(new Error(`tab state of ${tab}: ${error.message}`));
      }
    });
    return writing;
  }

  function schedule(tab) {
    if (pending.has(tab)) return;
    pending.set(tab, setTimeout(() => { pending.delete(tab); put(tab); }, COALESCE_MS));
  }

  // Sets (value) or removes (undefined) one field of the entry of tab; an entry without fields is removed.
  function change(tab, field, value) {
    const entry = { ...entries.get(tab) };
    if (value === undefined) delete entry[field];
    else entry[field] = value;
    if (Object.keys(entry).length) entries.set(tab, entry);
    else entries.delete(tab);
    schedule(tab);
  }

  function remove(tab) {
    clearTimeout(pending.get(tab));
    pending.delete(tab);
    entries.delete(tab);
    return put(tab);
  }

  return {
    /** The entry of tab, or null. */
    // default: a tab without an entry reads null (docs/spec/projects.md#persistence).
    entry: (tab) => entries.get(tab) ?? null,
    /** The cached label of tab, or null. */
    // default: a tab without an entry or a label shows no cached label.
    label: (tab) => entries.get(tab)?.label ?? null,
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
      await Promise.all(tabs.filter((tab) => entries.has(tab) || pending.has(tab)).map(remove));
    },
    /** Removes each entry whose tab is not in tabIds, the tab identifiers of projects.json, with an event per entry. */
    async reconcile(tabIds) {
      const orphans = [...entries.keys()].filter((tab) => !tabIds.has(tab));
      for (const tab of orphans) emitEvent("info", "page.tab.state.orphan", { tab });
      await Promise.all(orphans.map(remove));
    },
    /** Writes every pending entry now; the page calls it at quit. */
    flush() {
      const tabs = [...pending.keys()];
      for (const tab of tabs) clearTimeout(pending.get(tab));
      pending.clear();
      for (const tab of tabs) put(tab);
      return writing;
    },
    /** Resolves when the writes started so far have ended. */
    idle: () => writing,
  };
}
