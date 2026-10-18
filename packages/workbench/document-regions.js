// The document regions of each tab for the memory saver (docs/spec/plugins.md#memory-saver): the regions that the surface
// of a tab attached, the reasons that their query gives at a decision, the interactionState read before an unload, and the
// restore of that state into the region of the same name that the restored surface attaches.

import { documents, report } from "./host.js";

/** Creates the region record of the page over the declared host calls of the document regions. */
export function createDocumentRegions() {
  // tab id -> the names of the regions that its surface attached and has not detached
  const attachedNames = new Map();
  // tab id -> {name: interactionState} that the next attach of each name restores once
  const pending = new Map();

  // default: a tab whose surface attached no region has no names.
  const namesOf = (tab) => [...(attachedNames.get(tab) ?? [])];

  return {
    attached(tab, name) {
      let names = attachedNames.get(tab);
      if (!names) attachedNames.set(tab, names = new Set());
      names.add(name);
    },
    detached(tab, name) {
      attachedNames.get(tab)?.delete(name);
    },
    /** Forgets the regions of a released surface, which the host closed with it. */
    released(tab) {
      attachedNames.delete(tab);
    },
    /**
     * The reasons of the regions of the tab: media for audible media, capture, form; a failed query gives media-unknown and
     * is logged.
     */
    async reasons(tab) {
      const reasons = new Set();
      await Promise.all(namesOf(tab).map(async (name) => {
        try {
          const reply = await documents.query(tab, name);
          if (reply.media) reasons.add("media");
          if (reply.capture) reasons.add("capture");
          if (reply.form) reasons.add("form");
        } catch (error) {
          reasons.add("media-unknown");
          report(`memory saver: tab ${tab}: ${error.message}`);
        }
      }));
      return ["media", "media-unknown", "capture", "form"].filter((reason) => reasons.has(reason));
    },
    /** The interactionState of each region of the tab that yields one, or undefined when none does. */
    async interaction(tab) {
      const history = {};
      for (const name of namesOf(tab)) {
        const state = await documents.interactionState(tab, name);
        if (state) history[name] = state;
      }
      return Object.keys(history).length ? history : undefined;
    },
    /** Keeps the history of a restored tab for the regions that its new surface attaches. */
    restore(tab, history) {
      if (history) pending.set(tab, { ...history });
      else pending.delete(tab);
    },
    /** The documentAttach request of the region name of the tab, with the interactionState that it restores once. */
    attachRequest(tab, name) {
      const states = pending.get(tab);
      const state = states?.[name];
      if (state === undefined) return { document: name };
      delete states[name];
      if (!Object.keys(states).length) pending.delete(tab);
      return { document: name, interactionState: state };
    },
  };
}

/** The region record of this page. */
export const documentRegions = createDocumentRegions();
