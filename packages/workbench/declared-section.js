// The source and the state of one declared section (docs/spec/declared-ui.md, status mapping and transitions). The section takes its
// value from the chosen source only. The snapshot channel and the pull request of a source are given by the caller, because the
// main page has no production connection to a view or a plugin host for them yet.
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
 *     orientation() the current orientation of the section
 *     choose()      the chosen source {id, surface}, or null (chooseSource)
 *     channel(source) {send, onMessage} of the snapshot channel of a source, or null when the source has no channel
 *     pull(source)  a promise of the pull reply {seq, value}, or null when the source has no value; null when there is no pull path
 *     failed(error) receives the error of a pull that failed
 *
 * reconcile() applies the choice of the source: a change of source clears the section, removes the baseline and withdraws the error,
 * subscribes to the new channel, and pulls the value of the new source once. orientationChanged() checks the accepted value for the
 * new orientation and pulls once again. A snapshot or a pull reply of a source that is no longer chosen is discarded, and so is a
 * pull reply whose seq is lower than the seq of the last accepted value.
 */
export function createDeclaredSection({ statusId, body, options, orientation, choose, channel, pull, failed }) {
  const owner = statusId.slice(0, statusId.indexOf("."));
  const status = statusId.slice(statusId.indexOf(".") + 1);
  const receiveOptions = { ...options, owner, status };
  let current = null;
  let stop = null;
  let generation = 0;
  let lastSeq = 0;
  let accepted = null;

  function accept(seq, value) {
    const ok = receive(body, value, { ...receiveOptions, orientation: orientation() });
    accepted = ok ? value : null;
    if (ok) lastSeq = seq;
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
      accept(reply.seq, reply.value);
    }, (error) => {
      if (mine === generation) failed(error);
    });
  }

  /** Ends the chosen source: its channel is released, the section is cleared, and the error is withdrawn. The kept state stays. */
  function leave() {
    if (current === null) return;
    if (stop !== null) stop();
    stop = null;
    current = null;
    generation += 1;
    lastSeq = 0;
    accepted = null;
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
    const link = channel(next);
    if (link !== null) {
      stop = createSnapshotReceiver({
        plugin: owner,
        send: link.send,
        onMessage: link.onMessage,
        onSnapshot: (received, seq, value) => {
          if (received !== statusId || current === null || current.id !== next.id) return;
          accept(seq, value);
        },
      });
    }
    pullCurrent();
  }

  function orientationChanged() {
    if (current === null) return;
    if (accepted !== null) accept(lastSeq, accepted);
    pullCurrent();
  }

  return { reconcile, orientationChanged, close: leave };
}
