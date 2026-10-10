/**
 * The diagnostic hold of surface exposure replies (diagnostics.surface.hold in docs/spec/endpoint.md).
 *
 * A reply that a held surface sends is not sent until the host reports that it removed the surface. When the host removes a surface, it ends the
 * requests sent to that surface with 1003, so a reply sent after that is a reply that arrives after the request ended. A window check uses this to produce that
 * reply without relying on timing.
 *
 * log(line) sends one observation line to the application log and returns its completion as a promise.
 */
export function createSurfaceReplyHold(log) {
  /* { sends, waiters } for each held surface. sends is the transmissions of replies not yet sent, and waiters is the waiters of held. */
  const holds = new Map();

  const required = (method, surface) => {
    if (typeof surface !== "string" || !surface) throw new Error(`${method} requires surface`);
  };

  return {
    /** Starts holding the replies of surface. */
    hold(surface) {
      required("diagnostics.surface.hold", surface);
      if (holds.has(surface)) throw new Error(`exposure replies of surface "${surface}" are already held`);
      holds.set(surface, { sends: [], waiters: [] });
    },

    /** A promise that ends when surface holds one reply. */
    held(surface) {
      required("diagnostics.surface.held", surface);
      const hold = holds.get(surface);
      if (!hold) throw new Error(`exposure replies of surface "${surface}" are not held`);
      if (hold.sends.length > 0) return Promise.resolve();
      return new Promise((resolve, reject) => hold.waiters.push({ resolve, reject }));
    },

    /** Sends one reply of surface. send() sends the reply and returns the host response as a promise. */
    gate(surface, send) {
      const hold = holds.get(surface);
      if (!hold) return send();
      return new Promise((resolve, reject) => {
        hold.sends.push(() => send().then(resolve, reject));
        for (const waiter of hold.waiters.splice(0)) waiter.resolve();
      });
    },

    /**
     * The host removed surface. It sends the held replies in the order they were held and ends the hold. It writes the observation line after the host
     * responded to every reply. A failure of a response goes to the side that sent that reply.
     */
    closed(surface) {
      const hold = holds.get(surface);
      if (!hold) return Promise.resolve();
      holds.delete(surface);
      for (const waiter of hold.waiters.splice(0)) {
        waiter.reject(new Error(`surface "${surface}" closed before it held an exposure reply`));
      }
      const sent = hold.sends.map((send) => send());
      return Promise.allSettled(sent).then(() =>
        log(`held exposure replies of surface "${surface}" were sent after the surface closed (${sent.length})`));
    },
  };
}
