// The call layer of a plugin process boundary (docs/plans/plugin-processes.md, rule 3). It runs over the send function and
// the onMessage subscription of a transport, so the same code serves a view, a plugin host and a sidecar.
//
// Messages of the call envelope: a request is {id, command, params}; a reply is {id, result} or {id, error: {code, message}};
// a cancel is {id, cancel: true}. The transport delivers each message to the subscription. send throws when the message
// cannot be sent.
//
// report(event) receives each count and each change of the open calls:
//   {kind: "timeout", plugin, command, timeout}      a call whose declared time limit passed
//   {kind: "peer-lost", plugin, command, reason}     a call ended by its peer; reason is one of PEER_LOST_REASONS
//   {kind: "late-reply", plugin, command, delay}     a reply to a call that had ended; delay is in milliseconds
//   {kind: "open-calls", plugin, count, oldestStartedAt}  after each change of the open calls
// The reports are the only output: the caller decides which of them are counted and which are written as events.

/** The time limit of a command that declares none, in milliseconds (docs/spec/exposure.md, command timeout). */
export const DEFAULT_CALL_TIMEOUT = 10000;
/** The largest declared time limit of a command, in milliseconds. */
export const MAX_CALL_TIMEOUT = 600000;
/**
 * The number of ended calls whose replies are still recognized as late replies. An older ended call is forgotten, and a reply to
 * it is refused as a reply to no request. The bound keeps memory fixed for a peer that never replies.
 */
export const ENDED_CALLS_KEPT = 256;
/** The reasons that end a call when its peer is lost. */
export const PEER_LOST_REASONS = ["process-ended", "surface-closed", "sidecar-ended"];

function callError(message, fields) {
  return Object.assign(new Error(message), fields);
}

/**
 * Creates the call layer of one peer.
 *
 *     plugin      the plugin id that every report names
 *     send        send(message): sends one message to the peer synchronously; throws when it cannot
 *     onMessage   onMessage(listener): delivers each message from the peer to listener; returns the unsubscribe function
 *     report      report(event): receives the counts and the changes of the open calls
 *
 * Returns {request, peerLost, openCalls, close}.
 */
export function createCalls({ plugin, send, onMessage, report }) {
  if (typeof plugin !== "string" || plugin === "") throw new TypeError("createCalls requires the plugin id");
  if (typeof send !== "function" || typeof onMessage !== "function" || typeof report !== "function") {
    throw new TypeError("createCalls requires the send, onMessage and report functions");
  }
  // Open calls by id, in the order of their start. Map keeps insertion order, so the first entry is the oldest call.
  const open = new Map();
  // Ended calls by id, for the late replies, bounded by ENDED_CALLS_KEPT.
  const ended = new Map();
  let lastId = 0;

  const changed = () => {
    const { count, oldestStartedAt } = openCalls();
    report({ kind: "open-calls", plugin, count, oldestStartedAt });
  };

  /** Removes a call from the open calls and clears its timer and its abort listener. The caller settles the promise. */
  function end(id) {
    const call = open.get(id);
    open.delete(id);
    clearTimeout(call.timer);
    call.detach();
    ended.set(id, { command: call.command, sent: call.sent });
    if (ended.size > ENDED_CALLS_KEPT) ended.delete(ended.keys().next().value);
    return call;
  }

  function expire(id) {
    const call = end(id);
    report({ kind: "timeout", plugin, command: call.command, timeout: call.timeout });
    changed();
    call.reject(callError(`command ${call.command} did not reply within ${call.timeout}ms`, { code: -32000 }));
  }

  function cancel(id) {
    const call = end(id);
    changed();
    try {
      send({ id, cancel: true });
      call.reject(callError("cancelled", { reason: "cancelled" }));
    } catch (error) {
      call.reject(callError(`cancelled; the cancel message was not sent: ${error.message}`, { reason: "cancelled", cause: error }));
    }
  }

  function receive(message) {
    if (!message || typeof message !== "object" || !Number.isInteger(message.id)) {
      throw new TypeError("call message is not a reply with an integer id");
    }
    if (!("result" in message) && !("error" in message)) {
      throw new TypeError(`call reply ${message.id} has neither a result nor an error`);
    }
    if (!open.has(message.id)) {
      const late = ended.get(message.id);
      if (!late) throw new Error(`call reply ${message.id} has no matching request`);
      report({ kind: "late-reply", plugin, command: late.command, delay: Date.now() - late.sent });
      return;
    }
    const call = end(message.id);
    changed();
    if ("error" in message) {
      call.reject(callError(message.error?.message ?? String(message.error), { code: message.error?.code }));
    } else {
      call.resolve(message.result);
    }
  }

  const stopReceiving = onMessage(receive);

  /**
   * Sends a command and returns a promise of its reply.
   *
   *     timeout   the time limit of the command from its declaration, an integer from 1 to MAX_CALL_TIMEOUT. Default DEFAULT_CALL_TIMEOUT.
   *     signal    an AbortSignal. When it aborts, the cancel message is sent and the promise rejects with reason cancelled.
   */
  function request(command, params, { timeout = DEFAULT_CALL_TIMEOUT, signal } = {}) {
    if (typeof command !== "string" || command === "") throw new TypeError("request requires a command name");
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_CALL_TIMEOUT) {
      throw new RangeError(`timeout must be an integer from 1 to ${MAX_CALL_TIMEOUT} ms, got ${timeout}`);
    }
    if (signal?.aborted) return Promise.reject(callError("cancelled", { reason: "cancelled" }));
    const id = ++lastId;
    const now = Date.now();
    return new Promise((resolve, reject) => {
      const call = { command, timeout, resolve, reject, sent: now, started: now, timer: null, detach: () => {} };
      open.set(id, call);
      // The timer is the only time limit in the layer. A live peer that does not reply sends no event, so the declared
      // time limit is the only signal of that state (docs/plans/plugin-processes.md, rule 3).
      call.timer = setTimeout(() => expire(id), timeout);
      if (signal) {
        const onAbort = () => cancel(id);
        signal.addEventListener("abort", onAbort, { once: true });
        call.detach = () => signal.removeEventListener("abort", onAbort);
      }
      try {
        send({ id, command, params });
      } catch (error) {
        end(id);
        changed();
        reject(error);
        return;
      }
      changed();
    });
  }

  /** Ends every open call because its peer is gone. The reason is one of PEER_LOST_REASONS. */
  function peerLost(reason) {
    if (!PEER_LOST_REASONS.includes(reason)) {
      throw new RangeError(`peer lost reason must be one of ${PEER_LOST_REASONS.join(", ")}, got ${reason}`);
    }
    const calls = [...open.keys()].map((id) => end(id));
    for (const call of calls) {
      report({ kind: "peer-lost", plugin, command: call.command, reason });
      call.reject(callError(`command ${call.command} ended: ${reason}`, { reason }));
    }
    changed();
  }

  /** The open calls: the count and the start time of the oldest one, or null when there is none. */
  function openCalls() {
    const oldest = open.values().next().value;
    return { count: open.size, oldestStartedAt: oldest ? oldest.started : null };
  }

  /** Stops receiving messages from the peer. The caller ends the open calls with peerLost first. */
  function close() {
    stopReceiving();
  }

  return { request, peerLost, openCalls, close };
}
