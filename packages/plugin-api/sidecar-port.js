// The sidecar port of a page. The port of the runtime passes each call to the host as a separate request, so if two transports
// overlap, the arrival order can change. A sidecar handles messages in the order received (for example, an interruption after a run), so the next
// transport is sent after the earlier transport finishes.

/**
 * port is page.sidecar(name) of the runtime. The returned send is delivered in the order called and returns the
 * result of each transport (including a failure) to the caller. A failed transport does not block the next one, and its error is reported to failed.
 */
export function orderedSidecar(port, failed) {
  // Without a handler, a failed transport would leave the chain rejected and block every later transport, so the rejection is handled at the boundary.
  if (typeof failed !== "function") throw new TypeError("orderedSidecar requires a failure handler");
  let chain = Promise.resolve();
  return {
    // cids are the correlation identifiers of the inputs that the request continues (docs/spec/sidecars.md#protocol); a request
    // that continues no input sends none.
    send(surface, body, cids = []) {
      const sent = chain.then(() => port.send(surface, body, cids));
      // The error is reported only from the internal chain. The caller receives sent, so a failure is delivered as a rejection.
      chain = sent.catch(failed);
      return sent;
    },
    on: (surface, fn) => port.on(surface, fn),
    onFailure: (surface, fn) => port.onFailure(surface, fn),
  };
}
