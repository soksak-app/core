// The declared UI snapshots of a plugin process boundary (docs/spec/plugin-processes.md, rule 2 and messages and events). The
// module runs over the send function and the onMessage subscription of a transport, so the same code serves a view, a plugin
// host and the workbench. The caller routes the messages of this channel to the module; the call envelope goes to createCalls.
//
// Messages of the channel: a snapshot is {event: "declared-ui.snapshot", plugin, status, seq, value, skipped}, pushed by the plugin.
// skipped is the number of values of the status that were overwritten while a snapshot was in transit, since the previous snapshot of
// the status was sent;
// an acknowledgement is {event: "declared-ui.snapshot.ack", plugin, status, seq}, sent by the workbench. The pull of load time
// is a call with the command "declared-ui.snapshot.request" and the reply {seq, value}.
//
// seq is a counter per status in one plugin process. Each push of a value takes the next seq, so the seq names the value.
// A restarted process starts its counters again; the workbench takes each first snapshot of a process as its full value.
//
// report(event) receives each loss, and no other output:
//   {kind: "skipped", plugin, status, count: 1}                 a value overwritten while a snapshot was in transit
//   {kind: "stalled", plugin, status, reason, count: 1}         a snapshot in transit or a dirty value lost to a peer loss;
//                                                               reason is one of PEER_LOST_REASONS
// The caller decides which of them are counted and which are written as events.

import { PEER_LOST_REASONS } from "./calls.js";

export const SNAPSHOT_EVENT = "declared-ui.snapshot";
export const SNAPSHOT_ACK_EVENT = "declared-ui.snapshot.ack";
export const SNAPSHOT_REQUEST_COMMAND = "declared-ui.snapshot.request";

function checkPlugin(plugin) {
  if (typeof plugin !== "string" || plugin === "") throw new TypeError("the snapshot channel requires the plugin id");
}

function checkTransport(send, onMessage) {
  if (typeof send !== "function" || typeof onMessage !== "function") {
    throw new TypeError("the snapshot channel requires the send and onMessage functions");
  }
}

function checkStatus(status) {
  if (typeof status !== "string" || status === "") throw new TypeError("a snapshot requires a status name");
}

function checkSeq(seq, context) {
  if (!Number.isInteger(seq) || seq < 1) throw new TypeError(`${context} seq must be an integer from 1, got ${seq}`);
}

/**
 * Creates the plugin side of the channel: it pushes the declared UI snapshots of the plugin and answers the pull.
 *
 *     plugin      the plugin id that every message and report names
 *     send        send(message): sends one message to the workbench synchronously; throws when it cannot
 *     onMessage   onMessage(listener): delivers each acknowledgement to listener; returns the unsubscribe function
 *     report      report(event): receives the skipped and stalled values
 *
 * Returns {push, pull, peerLost, close}.
 *
 * A status has at most one snapshot in transit. push sends the value when no snapshot of the status is in transit; otherwise
 * it marks the status dirty, and a dirty value that a newer value overwrites is reported as skipped. The acknowledgement of
 * the snapshot in transit sends the dirty value, if any, with its seq.
 *
 * peerLost(reason) ends the snapshots in transit. Each status with a snapshot in transit is reported as stalled. When the
 * reason is surface-closed, a dirty value is discarded and reported as stalled too. A process that starts again creates a new
 * sender, so its first push of each status is sent at once. No timer is used: the peer loss is the only end of a pending
 * acknowledgement that the module observes.
 */
export function createSnapshotSender({ plugin, send, onMessage, report }) {
  checkPlugin(plugin);
  checkTransport(send, onMessage);
  if (typeof report !== "function") throw new TypeError("the snapshot sender requires the report function");
  // Per status: the seq of the latest value, the latest value, the seq in transit (or null), the dirty mark and the count of the
  // values skipped since the last snapshot was sent.
  const states = new Map();

  const stateOf = (status) => {
    if (!states.has(status)) states.set(status, { seq: 0, value: undefined, inTransit: null, dirty: false, skipped: 0 });
    return states.get(status);
  };

  /** Sends the snapshot of a status with the seq of its latest value and the count of values it skipped. The slot is released again
   * when the send throws, and the count is kept for the next snapshot. */
  function transmit(status, state) {
    const skipped = state.skipped;
    state.inTransit = state.seq;
    state.dirty = false;
    state.skipped = 0;
    try {
      send({ event: SNAPSHOT_EVENT, plugin, status, seq: state.seq, value: state.value, skipped });
    } catch (error) {
      state.inTransit = null;
      state.skipped += skipped;
      throw error;
    }
  }

  function receive(message) {
    if (!message || typeof message !== "object" || message.event !== SNAPSHOT_ACK_EVENT) {
      throw new TypeError("snapshot channel message is not an acknowledgement");
    }
    if (message.plugin !== plugin) throw new TypeError(`acknowledgement names plugin ${message.plugin}, expected ${plugin}`);
    checkStatus(message.status);
    checkSeq(message.seq, `acknowledgement of ${message.status}`);
    const state = states.get(message.status);
    if (!state || state.inTransit !== message.seq) {
      throw new Error(`declared UI snapshot ack ${message.status} ${message.seq} has no snapshot in transit`);
    }
    state.inTransit = null;
    if (state.dirty) transmit(message.status, state);
  }

  const stopReceiving = onMessage(receive);

  /** Pushes the value of a status. The value is the whole value of the status, not a change of it. */
  function push(status, value) {
    checkStatus(status);
    if (value === undefined) throw new TypeError(`snapshot of ${status} requires a value`);
    const state = stateOf(status);
    state.seq += 1;
    state.value = value;
    if (state.inTransit !== null) {
      if (state.dirty) {
        state.skipped += 1;
        report({ kind: "skipped", plugin, status, count: 1 });
      }
      state.dirty = true;
      return;
    }
    transmit(status, state);
  }

  /** Whether the status has a pushed value. A status that was never pushed has none, so its pull has no value to return. */
  function has(status) {
    checkStatus(status);
    const state = states.get(status);
    return state !== undefined && state.value !== undefined;
  }

  /** Returns the latest value of a status and its seq, for the pull of load time. A status with no value is refused. */
  function pull(status) {
    checkStatus(status);
    const state = states.get(status);
    if (!state) throw new Error(`declared UI snapshot ${status} has no value`);
    return { seq: state.seq, value: state.value };
  }

  /** Ends the snapshots in transit because the peer is gone. The reason is one of PEER_LOST_REASONS. */
  function peerLost(reason) {
    if (!PEER_LOST_REASONS.includes(reason)) {
      throw new RangeError(`peer lost reason must be one of ${PEER_LOST_REASONS.join(", ")}, got ${reason}`);
    }
    for (const [status, state] of states) {
      if (state.inTransit !== null) {
        state.inTransit = null;
        report({ kind: "stalled", plugin, status, reason, count: 1 });
      }
      if (state.dirty) {
        state.dirty = false;
        if (reason === "surface-closed") report({ kind: "stalled", plugin, status, reason, count: 1 });
      }
    }
  }

  /** Stops receiving acknowledgements. The caller ends the snapshots in transit with peerLost first. */
  function close() {
    stopReceiving();
  }

  return { push, pull, has, peerLost, close };
}

/**
 * Creates the workbench side of the push: it acknowledges each snapshot and passes its value on.
 *
 *     plugin      the plugin id of the snapshots that it accepts
 *     send        send(message): sends one message to the plugin synchronously; throws when it cannot
 *     onMessage   onMessage(listener): delivers each message from the plugin to listener; returns the unsubscribe function
 *     onSnapshot  onSnapshot(status, seq, value, skipped): receives each snapshot and the count of values it skipped
 *
 * The acknowledgement is sent before onSnapshot runs, so the plugin releases its slot when the snapshot arrives. An error of
 * onSnapshot is thrown to the transport after the acknowledgement.
 */
export function createSnapshotReceiver({ plugin, send, onMessage, onSnapshot }) {
  checkPlugin(plugin);
  checkTransport(send, onMessage);
  if (typeof onSnapshot !== "function") throw new TypeError("the snapshot receiver requires the onSnapshot function");

  function receive(message) {
    if (!message || typeof message !== "object" || message.event !== SNAPSHOT_EVENT) {
      throw new TypeError("snapshot channel message is not a snapshot");
    }
    if (message.plugin !== plugin) throw new TypeError(`snapshot names plugin ${message.plugin}, expected ${plugin}`);
    checkStatus(message.status);
    checkSeq(message.seq, `snapshot of ${message.status}`);
    if (!("value" in message)) throw new TypeError(`snapshot of ${message.status} has no value`);
    if (!Number.isInteger(message.skipped) || message.skipped < 0) {
      throw new TypeError(`snapshot of ${message.status} skipped must be a count of 0 or more, got ${message.skipped}`);
    }
    send({ event: SNAPSHOT_ACK_EVENT, plugin, status: message.status, seq: message.seq });
    onSnapshot(message.status, message.seq, message.value, message.skipped);
  }

  return onMessage(receive);
}

/**
 * Pulls the snapshot of each status once, on a main page load. request is the request function of the call layer:
 * request(command, params) returns a promise of the reply {seq, value}. onSnapshot(status, seq, value) receives each reply.
 *
 * The returned promise rejects with an AggregateError that lists each failed status, after every request has settled.
 */
export async function pullSnapshots({ statuses, request, onSnapshot }) {
  if (!Array.isArray(statuses)) throw new TypeError("pullSnapshots requires the list of statuses");
  if (typeof request !== "function" || typeof onSnapshot !== "function") {
    throw new TypeError("pullSnapshots requires the request and onSnapshot functions");
  }
  const seen = new Set();
  for (const status of statuses) {
    checkStatus(status);
    if (seen.has(status)) throw new TypeError(`pullSnapshots lists ${status} twice`);
    seen.add(status);
  }
  const settled = await Promise.allSettled(
    statuses.map(async (status) => {
      const reply = await request(SNAPSHOT_REQUEST_COMMAND, { status });
      if (!reply || typeof reply !== "object") throw new TypeError(`snapshot reply of ${status} is not an object`);
      checkSeq(reply.seq, `snapshot reply of ${status}`);
      if (!("value" in reply)) throw new TypeError(`snapshot reply of ${status} has no value`);
      onSnapshot(status, reply.seq, reply.value);
    }),
  );
  const failures = settled.filter((result) => result.status === "rejected").map((result) => result.reason);
  if (failures.length > 0) {
    throw new AggregateError(failures, `snapshot pull failed for ${failures.length} of ${statuses.length} status(es)`);
  }
}
