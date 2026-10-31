// The document regions of each tab for the memory saver (docs/spec/plugins.md#memory-saver): the regions that the surface
// of a tab attached, the reasons that their query gives at a decision, the interactionState read before a write of the
// tab session, and the restore of the stored session into the region of the same name, on the first attach of a tab after
// the start and on the attach that follows a restore.

import { documents, report } from "./host.js";

/** Creates the region record of the page over the declared host calls of the document regions. */
export function createDocumentRegions() {
  // tab id -> name -> the attachment of each region that its surface attached and has not detached; each attach gives a new
  // attachment, so a read can tell whether the region it started with still holds.
  const attachedNames = new Map();
  // tab id -> the promise of {name: interactionState} that the next attach of each name restores once
  const pending = new Map();
  // The tabs whose stored session is read: a tab outside the set reads it at its next attach.
  const seeded = new Set();
  // tab id -> the promise of whether the stored session that the last read of the tab gave holds a session history.
  const stored = new Map();
  // The reader of the stored sessions, given once the tab sessions are open (useSessions).
  let resolveSessions;
  const sessions = new Promise((resolve) => { resolveSessions = resolve; });
  // The listeners of a region that refused its restored interactionState, a restore failure.
  const refusals = new Set();
  // tab id -> the outcome of the running place that leaves the surface of the tab out; a query of its regions waits for it,
  // because the host closes those regions before the reply of the place.
  const leaving = new Map();

  // default: a tab whose surface attached no region has no names.
  const namesOf = (tab) => [...(attachedNames.get(tab)?.keys() ?? [])];
  // default: a region that is not attached has no attachment.
  const attachmentOf = (tab, name) => attachedNames.get(tab)?.get(name);

  // Reads the stored session of tab for its next attaches; a failed read is logged and the regions attach without it.
  function seed(tab) {
    seeded.add(tab);
    const states = sessions
      .then((read) => (read ? read(tab) : undefined))
      .then((states) => ({ ...states }))
      .catch((error) => {
        report(`memory saver: tab ${tab}: session read failed: ${error.message}`);
        return {};
      });
    stored.set(tab, states.then((value) => Object.keys(value).length > 0));
    pending.set(tab, states);
  }

  return {
    attached(tab, name) {
      let names = attachedNames.get(tab);
      if (!names) attachedNames.set(tab, names = new Map());
      names.set(name, {});
    },
    detached(tab, name) {
      attachedNames.get(tab)?.delete(name);
    },
    /** Forgets the regions of a released surface, which the host closed with it. */
    released(tab) {
      attachedNames.delete(tab);
    },
    /**
     * Holds the queries of the regions of tab while a place that leaves its surface out runs. The returned function takes
     * whether the place released the surface: a release forgets the regions, and a failed place keeps them for the queries.
     */
    leave(tab) {
      let settle;
      const outcome = new Promise((resolve) => { settle = resolve; });
      leaving.set(tab, outcome);
      return (released) => {
        if (released) attachedNames.delete(tab);
        if (leaving.get(tab) === outcome) leaving.delete(tab);
        settle();
      };
    },
    /**
     * The reasons of the regions of the tab: media for audible media, capture, form; a failed query gives media-unknown and
     * is logged.
     */
    async reasons(tab) {
      await leaving.get(tab);
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
      await leaving.get(tab);
      const history = {};
      for (const name of namesOf(tab)) {
        const attachment = attachmentOf(tab, name);
        let state;
        try {
          state = await documents.interactionState(tab, name);
        } catch (error) {
          // A region whose attachment ended or was replaced during the read was closed by the host, so it has no state to store.
          if (attachmentOf(tab, name) !== attachment) continue;
          throw error;
        }
        if (state) history[name] = state;
      }
      return Object.keys(history).length ? history : undefined;
    },
    /**
     * Gives the reader read(tab) of the stored sessions, or null when the tab sessions did not open; attaches wait for
     * it.
     */
    useSessions(read) {
      resolveSessions(read);
    },
    /** Reads the stored session of a restored tab for the regions that its new surface attaches. */
    restore(tab) {
      seed(tab);
    },
    /** The tabs that have attached regions. */
    tabs: () => [...attachedNames].filter(([, names]) => names.size).map(([tab]) => tab),
    /**
     * Resolves to whether the stored session that the last restore of the tab read holds a session history. A view attaches
     * its regions after its mount ends, so the end of the restore reads the stored session and not the attaches.
     */
    restoredHistory: (tab) => {
      const history = stored.get(tab);
      // A restore reads the stored session of its tab first (restore), so a tab without a read has no restore to end.
      if (history === undefined) return Promise.reject(new Error(`tab ${tab} has no read of its stored session`));
      return history;
    },
    /**
     * Attaches the region name of the tab of plugin through attach(request) with the interactionState that it restores
     * once. A refused interactionState is reported to the refusal listeners and the region attaches again without it, because a
     * lost session history is a smaller loss than a tab without its document (docs/spec/plugins.md#memory-saver). It
     * resolves to {history}, true when the region restored a session history.
     */
    async attach(tab, plugin, name, attach) {
      const request = await this.attachRequest(tab, name);
      let history = request.interactionState !== undefined;
      try {
        await attach(request);
      } catch (error) {
        if (!history) throw error;
        for (const listener of refusals) listener(tab, plugin, name, error);
        history = false;
        await attach({ document: name });
      }
      this.attached(tab, name);
      return { history };
    },
    /** Adds a listener (tab, plugin, name, error) of a refused interactionState; returns its removal. */
    onRefused(listener) {
      refusals.add(listener);
      return () => refusals.delete(listener);
    },
    /** The documentAttach request of the region name of the tab, with the interactionState that it restores once. */
    async attachRequest(tab, name) {
      if (!seeded.has(tab)) seed(tab);
      const states = await pending.get(tab);
      const state = states?.[name];
      if (state === undefined) return { document: name };
      delete states[name];
      return { document: name, interactionState: state };
    },
  };
}

/** The region record of this page. */
export const documentRegions = createDocumentRegions();
