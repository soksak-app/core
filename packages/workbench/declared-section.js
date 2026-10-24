// The source and the state of one declared section (docs/spec/declared-ui.md, status mapping and transitions). The section takes its
// value from the chosen source only. The snapshot channel and the pull of a source are given by the caller; the production
// connection of a view source is createDeclaredSource() of declared-source.js.
import { createSnapshotReceiver } from "@soksak/plugin-api";
import { changeSource, receive } from "./declared-ui.js";
import { hideError } from "./shown-errors.js";

/**
 * The chosen source of a declared status: the view of the active tab of the card when that view registered the status, otherwise the
 * plugin host when the plugin has one, otherwise null. A state module registration is not passed here, so it never serves.
 * The source is {id, surface}; the host has no surface.
 */
export function chooseSource({ active = null, registrants, host = null }) {
  if (active !== null && registrants.includes(active)) return { id: active, surface: active };
  if (host !== null) return { id: host, surface: null };
  return null;
}

const sameSource = (a, b) => (a === null ? b === null : b !== null && a.id === b.id);

/**
 * Creates the state of the declared section of statusId (`<plugin>.<name>`) in body.
 *
 *     body          the section element that draws the accepted value
 *     options       the options of receive (declared, hasIcon, bind)
 *     choose()      the chosen source {id, surface}, or null (chooseSource)
 *     channel(source) {send, onMessage} of the snapshot channel of a source, or null when the source has no channel
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
export function createDeclaredSection({ statusId, body, options, choose, channel, pull, expanded, skipped, failed }) {
  const owner = statusId.slice(0, statusId.indexOf("."));
  const status = statusId.slice(statusId.indexOf(".") + 1);
  const receiveOptions = { ...options, owner, status };
  let current = null;
  let stop = null;
  let generation = 0;
  let lastSeq = 0;
  let accepted = null;
  let rejected = null;

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
      accepted = value;
      rejected = null;
    } else {
      accepted = null;
      // The section shows the text that the display path wrote (docs/spec/declared-ui.md, rejection).
      rejected = body.textContent;
    }
  }

  /** Calls the pull of the current source; its reply is accepted only while that source is still chosen. */
  function pullCurrent() {
    if (pull === null || current === null) return;
    const pulled = current;
    const mine = generation;
    pull(pulled).then((reply) => {
      // A reply with value null means that the source has no value yet (docs/spec/declared-ui.md): the section stays cleared.
      if (mine !== generation || reply.value === null) return;
      if (reply.seq < lastSeq) return;
      accept(reply.seq, reply.value, pulled);
    }, (error) => {
      if (mine === generation) failed(error);
    });
  }

  /** Ends the chosen source: its channel is released, the section is cleared, and the error is withdrawn. The next source supplies expansion values. */
  function leave() {
    if (current === null) return;
    if (stop !== null) stop();
    stop = null;
    current = null;
    generation += 1;
    lastSeq = 0;
    accepted = null;
    rejected = null;
    changeSource(statusId);
    body.replaceChildren();
    hideError(body, `declared UI ${statusId}`);
  }

  function reconcile() {
    const next = choose();
    if (sameSource(next, current)) return;
    leave();
    if (next === null) return;
    current = next;
    generation += 1;
    const mine = generation;
    const link = channel(next);
    if (link !== null) {
      const ready = createSnapshotReceiver({
        plugin: owner,
        send: link.send,
        onMessage: link.onMessage,
        onSnapshot: (received, seq, value, count) => {
          // The snapshot names the status inside the plugin; the channel is per plugin (docs/spec/declared-ui.md).
          if (received !== status || mine !== generation || current === null || current.id !== next.id) return;
          // The count of the overwritten values reaches the main page in each snapshot (docs/spec/plugin-processes.md, rule 2).
          // default: a section without a skipped receiver writes no trace event of the overwritten values.
          if (count > 0) skipped?.(count);
          accept(seq, value, next);
        },
      });
      Promise.resolve(ready).then((unsubscribe) => {
        if (mine !== generation || current === null || current.id !== next.id) {
          unsubscribe();
          return;
        }
        stop = unsubscribe;
        pullCurrent();
      }, (error) => {
        if (mine === generation) failed(error);
      });
      return;
    }
    pullCurrent();
  }

  /** The state that core.sidebars reports (docs/spec/declared-ui.md, sidebar section form). */
  const state = () => ({ mounted: accepted !== null, error: rejected });
  return { reconcile, close: leave, state };
}
