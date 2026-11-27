// The reader of a page-wire case. It answers the calls of the workbench page with the replies that a case records, in the order
// of the case, and delivers the notices of the case to the listeners of the page (docs/spec/cases/page-wire/README.md). The runtime
// module of the workbench tests selects it (test/runtime/index.js). The check of the case and the matching of the calls are those of
// @soksak/plugin-api/wire-case, which the view-wire reader shares.
import { createWire, readCase } from "@soksak/plugin-api/wire-case";

/** The directory of the page-wire cases. This module lives in packages/workbench/test/runtime, four levels below the repository root. */
const CASE_DIRECTORY = new URL("../../../../docs/spec/cases/page-wire/", import.meta.url);

// The members that each state of a change step names besides its value (docs/spec/cases/page-wire/README.md).
const CHANGE_MEMBERS = {
  settings: [],
  textSize: [],
  logLevels: [],
  run: [],
  leftOut: [],
  data: ["key"],
  status: ["name"],
  frame: ["view"],
};

const SHAPE = {
  subject: "page",
  identity: "name",
  params: "payload",
  noticeData: "payload",
  callLabel: "a host call",
  logName: "log",
  kinds: ["call", "reply", "notice", "listen", "change", "close"],
  header: () => {},
  others: {
    change(change, where, fail, only) {
      if (!Object.hasOwn(CHANGE_MEMBERS, change.state)) fail(`${where} change must name a state of ${Object.keys(CHANGE_MEMBERS).join(", ")}`);
      only(["state", "value", "name", "surface", "key", "view", "plugin"]);
      if (!("value" in change)) fail(`${where} change must have a value`);
      for (const member of CHANGE_MEMBERS[change.state]) {
        if (typeof change[member] !== "string" || change[member] === "") fail(`${where} change ${change.state} must name its ${member}`);
      }
    },
    close(close, where, fail, only) {
      only([]);
    },
    listen(listen, where, fail, only) {
      if (typeof listen.event !== "string" || listen.event === "") fail(`${where} listen must name an event`);
      only(["event", "error", "held", "unsubscribeError"]);
      if ("unsubscribeError" in listen && (typeof listen.unsubscribeError !== "string" || listen.unsubscribeError === "")) fail(`${where} unsubscribeError must be a non-empty string`);
      if ("unsubscribeError" in listen && "error" in listen) fail(`${where} a refused registration has no unsubscribe function`);
      if ("error" in listen && (typeof listen.error !== "string" || listen.error === "")) fail(`${where} error must be a non-empty string`);
      if ("held" in listen && listen.held !== true) fail(`${where} held must be true when it is present`);
    },
  },
};

/**
 * Opens the case of the name for the page. The returned host answers each call of the page with the reply of the next step of the case.
 *
 * The calls of the host method log are matched in their own order among the log steps of the case, and every other call in its order
 * among the other steps; a call of either stream that deviates fails.
 *
 * calls holds each call that the page sent, in order, as {name, payload} and as {name, payload, cids} when the call carried identifiers; a
 * test compares it with the calls it expects. A call that differs from the next step of the case rejects with the difference and is kept
 * in the failures. A value of a call that names a page variable matches any value of the type of the variable; the first value binds the
 * variable, and each later use must equal it. A held reply settles when the test calls release(key). deliverNotice plays the next step, which
 * must be a notice, and calls each listener that the page registered for its event with its payload. A case without a listen step
 * answers each registration of the page at once; a case with a listen step answers each registration with the next step, which must be
 * the listen step of the event: it resolves with the unsubscribe, or it rejects with the error of the step, and a held step settles when
 * the test calls release(key). unsubscribed lists the events whose listener the page removed. finish throws when a failure
 * happened, when a step of the case was not played or when a held reply was not released.
 */
// The replies of the host calls that a case may filter (the member filter of the case, docs/spec/cases/page-wire/README.md). The reply of
// notificationState is the one recorded by docs/spec/cases/page-wire/plane-placeholder-error.json (steps 2 and 3), and the reply of
// setTheme is the one recorded by docs/spec/cases/page-wire/background-sessions-context.json (steps 14 and 15), and the reply of
// setMenuLanguage is the one recorded by docs/spec/cases/page-wire/home-folders-once.json (steps 4 and 5).
const FILTERED_REPLIES = {
  notificationState: { authorization: "notDetermined", error: null },
  setTheme: null,
  setMenuLanguage: null,
};

export function openPageWire(name) {
  const kase = readCase(CASE_DIRECTORY, name, SHAPE);
  if (kase.filter !== undefined && !Array.isArray(kase.filter)) throw new Error(`${name}: filter must be a list of call names`);
  for (const callName of kase.filter ?? []) {
    if (!Object.hasOwn(FILTERED_REPLIES, callName)) throw new Error(`${name}: filter names ${callName}, which the reader does not answer`);
  }
  // A filtered call is answered with its reply and is neither matched with a step nor counted in calls.
  const filtered = new Set(kase.filter ?? []);
  const wire = createWire(name, kase, SHAPE);
  const calls = [];
  // The listeners of the page, by event.
  const listeners = new Map();

  const call = (callName, payload, options) => {
    if (filtered.has(callName)) return Promise.resolve(FILTERED_REPLIES[callName]);
    const sent = wire.onTheWire({ name: callName, payload, cids: options?.cids });
    calls.push(sent);
    const outcome = wire.match(sent);
    if (outcome.error) return Promise.reject(outcome.error);
    const { reply, index } = outcome;
    const settle = (resolve, reject) => ("error" in reply ? reject(new Error(reply.error)) : resolve(wire.substitute(reply.result)));
    if (reply.held) return new Promise((resolve, reject) => wire.hold(index, callName, () => settle(resolve, reject)));
    return new Promise(settle);
  };

  // A case that records a registration of a listener records every registration of the page.
  const recordsListeners = kase.steps.some((step) => "listen" in step);

  // The events whose listener the page removed, in the order of the removals.
  const unsubscribed = [];

  const on = (event, listener) => {
    wire.trace(`step ${wire.cursor}: listen ${JSON.stringify(event)}`);
    // unsubscribeError is the text of the error that the unsubscribe function of the registration throws after it removed the listener.
    const register = (unsubscribeError) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(listener);
      return () => {
        listeners.get(event).delete(listener);
        unsubscribed.push(event);
        if (unsubscribeError !== undefined) throw new Error(unsubscribeError);
      };
    };
    if (!recordsListeners) return Promise.resolve(register());
    const index = wire.cursor;
    const step = wire.peek();
    if (!step) return Promise.reject(wire.fail(`the page registered a listener of ${JSON.stringify(event)} after the last step of the case`));
    if (!("listen" in step)) return Promise.reject(wire.fail(`the page registered a listener of ${JSON.stringify(event)} where the case has ${JSON.stringify(step)}`));
    if (step.listen.event !== event) return Promise.reject(wire.fail(`step ${index}: the case expects a listener of ${JSON.stringify(step.listen.event)}, the page registered ${JSON.stringify(event)}`));
    wire.advance();
    const { listen } = step;
    const settle = (resolve, reject) => ("error" in listen ? reject(new Error(listen.error)) : resolve(register(listen.unsubscribeError)));
    if (listen.held) return new Promise((resolve, reject) => wire.hold(index, event, () => settle(resolve, reject)));
    return new Promise(settle);
  };

  return {
    call,
    on,
    calls,
    unsubscribed,
    /** Settles the held reply or held registration that the key names (the oldest one without a key). */
    release: wire.release,
    /** Plays the next step, which must be a change, and returns a copy of its object for the test to apply to the state of the window. */
    change() {
      const step = wire.peek();
      if (!step || !("change" in step)) throw wire.fail(`change found ${step ? JSON.stringify(step) : "no further step"} at step ${wire.cursor}`);
      wire.advance();
      return structuredClone(step.change);
    },
    /** Plays the next step, which must be a close step, at the point where the test closes the view. The page sends no call for it. */
    close() {
      const step = wire.peek();
      if (!step || !("close" in step)) throw wire.fail(`close found ${step ? JSON.stringify(step) : "no further step"} at step ${wire.cursor}`);
      wire.advance();
    },
    /** Plays the next step, which must be a notice, by calling each listener of its event with its payload. */
    deliverNotice() {
      const step = wire.peek();
      if (!step || !("notice" in step)) throw wire.fail(`deliverNotice found ${step ? JSON.stringify(step) : "no further step"} at step ${wire.cursor}`);
      const { event } = step.notice;
      const registered = [...(listeners.get(event) ?? [])];
      if (registered.length === 0) throw wire.fail(`step ${wire.cursor}: the page has no listener of the notice ${event}`);
      wire.advance();
      for (const listener of registered) listener(wire.substitute(step.notice.payload));
    },
    finish: wire.finish,
  };
}
