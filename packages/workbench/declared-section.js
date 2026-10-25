// The source and the state of one declared section (docs/spec/declared-ui.md, status mapping and transitions). The section takes its
// value from the chosen source only. The snapshot channel and the pull of a source are given by the caller; the production
// connection of a view source is createDeclaredSource() of declared-source.js.
import { changeSource, receive } from "./declared-ui.js";
import { hideError } from "./shown-errors.js";

/**
 * The chosen source of a declared status: the view of the active tab of the card when that view registered the status, otherwise the
 * plugin host when the plugin has one, otherwise null. A state module registration is not passed here, so it never serves.
 * The source is {id, surface, generation}; the host has no surface.
 */
export function chooseSource({ active = null, activeGeneration = null, registrants, host = null, hostGeneration = null }) {
  const requireGeneration = (generation, id) => {
    if (!Number.isSafeInteger(generation) || generation < 1) {
      throw new TypeError(`declared UI source ${id} has no current native generation`);
    }
    return generation;
  };
  if (active !== null && registrants.includes(active)) {
    return { id: active, surface: active, generation: requireGeneration(activeGeneration, active) };
  }
  if (host !== null) return { id: host, surface: null, generation: requireGeneration(hostGeneration, host) };
  return null;
}

const sameSource = (a, b) => (a === null ? b === null : b !== null && a.id === b.id && a.surface === b.surface && a.generation === b.generation);

/**
 * Creates the state of the declared section of statusId (`<plugin>.<name>`) in body.
 *
 *     body          the section element that draws the accepted value
 *     options       the options of receive (declared, hasIcon, bind)
 *     choose()      the chosen source {id, surface, generation}, or null (chooseSource)
 *     channel(source) {onMessage} of the already acknowledged snapshot stream, or null when the source has no channel
 *     pull(source)  a promise of the pull reply {seq, value}
 *     skipped(count) receives the count of the values that a snapshot of the source overwrote while it was in transit
 *     failed(error) receives the error of a pull that failed
 *
 * reconcile() applies the choice of the source: a change of source clears the section, withdraws the error, subscribes to the new
 * channel, and pulls the value of the new source once. Expansion values belong to that source. An orientation change does not reach
 * the section: its accepted value stays valid in every orientation. A snapshot or a pull reply of a source that is no longer chosen
 * is discarded, as is a pull reply whose seq is lower than the last accepted value. state() reports the section state of core.sidebars:
 * mounted while the section draws an accepted value, and the text of the current rejection while the last value is rejected.
 */
export function createDeclaredSection({ statusId, body, options, choose, channel, pull, expanded, skipped, failed, changed }) {
  const owner = statusId.slice(0, statusId.indexOf("."));
  const status = statusId.slice(statusId.indexOf(".") + 1);
  const receiveOptions = { ...options, owner, status };
  let current = null;
  let stop = null;
  let generation = 0;
  let lastSeq = 0;
  let accepted = null;
  let rejected = null;
  let subscription = "none";
  let pullState = { phase: "idle", seq: null, valueNull: null };
  let acceptedSeq = null;

  const notify = () => changed?.(); // default: standalone section consumers may omit the optional redraw callback.

  function accept(seq, value, source = current) {
    const ok = receive(body, value, {
      ...receiveOptions,
      expanded: (request) => {
        if (typeof expanded !== "function") throw new Error(`${statusId}: the expansion source is not configured`);
        return expanded(source, { ...request, status });
      },
    });
    if (ok) {
      lastSeq = seq;
      acceptedSeq = seq;
      accepted = value;
      rejected = null;
    } else {
      accepted = null;
      // The section shows the text that the display path wrote (docs/spec/declared-ui.md, rejection).
      rejected = body.textContent;
    }
    notify();
  }

  /** Calls the pull of the current source; its reply is accepted only while that source is still chosen. */
  function pullCurrent() {
    if (pull === null || current === null) return;
    const pulled = current;
    const mine = generation;
    pullState = { phase: "pending", seq: null, valueNull: null };
    notify();
    pull(pulled).then((reply) => {
      // A reply with value null means that the source has no value yet (docs/spec/declared-ui.md): the section stays cleared.
      if (mine !== generation) return;
      if (reply?.cancelled === true) {
        pullState = { phase: "cancelled", seq: null, valueNull: null };
        notify();
        return;
      }
      pullState = { phase: "resolved", seq: reply.seq, valueNull: reply.value === null };
      notify();
      if (reply.value === null) return;
      if (reply.seq < lastSeq) return;
      accept(reply.seq, reply.value, pulled);
    }, (error) => {
      if (mine === generation) {
        pullState = { phase: "failed", seq: null, valueNull: null };
        notify();
        failed(error);
      }
    });
  }

  /** Ends the chosen source: its channel is released, the section is cleared, and the error is withdrawn. The next source supplies expansion values. */
  function leave() {
    if (current === null) return;
    const cancelledPull = pullState.phase === "pending";
    if (stop !== null) stop();
    stop = null;
    current = null;
    generation += 1;
    lastSeq = 0;
    accepted = null;
    rejected = null;
    subscription = "none";
    pullState = { phase: cancelledPull ? "cancelled" : "idle", seq: null, valueNull: null };
    acceptedSeq = null;
    changeSource(statusId);
    body.replaceChildren();
    hideError(body, `declared UI ${statusId}`);
    notify();
  }

  function reconcile() {
    const next = choose();
    if (sameSource(next, current)) return;
    leave();
    if (next === null) return;
    current = next;
    generation += 1;
    pullState = { phase: "idle", seq: null, valueNull: null };
    acceptedSeq = null;
    const mine = generation;
    const link = channel(next);
    if (link !== null) {
      subscription = "pending";
      notify();
      const ready = link.onMessage((message) => {
        // The window ingress validates and acknowledges snapshots before routing them to sections. A source can have several
        // section recipients, so a section only accepts its own status and never acknowledges the shared push.
        if (message.status !== status || mine !== generation || !sameSource(current, next)) return;
        if (message.skipped > 0) skipped?.(message.skipped); // default: skipped-count tracing is optional for section consumers.
        accept(message.seq, message.value, next);
      });
      Promise.resolve(ready).then((unsubscribe) => {
        if (mine !== generation || !sameSource(current, next)) {
          unsubscribe();
          return;
        }
        stop = unsubscribe;
        subscription = "ready";
        notify();
        pullCurrent();
      }, (error) => {
        if (mine === generation) {
          subscription = "failed";
          notify();
          failed(error);
        }
      });
      return;
    }
    notify();
    pullCurrent();
  }

  /** The state that core.sidebars reports (docs/spec/declared-ui.md, sidebar section form). */
  const state = () => ({
    mounted: accepted !== null, error: rejected,
    source: current === null ? null : { id: current.id, surface: current.surface, generation: current.generation },
    subscription, pull: { ...pullState }, acceptedSeq,
  });
  return { reconcile, close: leave, state };
}
