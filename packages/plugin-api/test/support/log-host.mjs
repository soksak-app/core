// The log calls of a view as the host answers them (docs/spec/logging.md#view-record-delivery): every view writes records from its
// start (page.start and page.theme.applied), so a test host answers runtime.log as the real host does, a clock request with a clock
// reading and a batch with null, and keeps those calls apart from the other calls whose order a test checks.

/**
 * Returns {answer, calls, events, until}. answer(message, reply) answers message when it is a runtime.log call of the view, through
 * reply(data), the way the host posts a reply to the view, and returns whether it did; calls holds the answered log calls, events the
 * events of the answered batches, and until(done) resolves with events once done(events) holds.
 */
export function createLogHost() {
  const calls = [];
  const events = [];
  const waits = [];
  let reading = 0;
  const settle = () => {
    for (const wait of waits.splice(0)) {
      if (wait.done(events)) wait.resolve(events);
      else waits.push(wait);
    }
  };
  return {
    calls,
    events,
    until: (done) => (done(events) ? Promise.resolve(events) : new Promise((resolve) => waits.push({ done, resolve }))),
    answer(message, reply) {
      if (message?.command !== "runtime.log") return false;
      calls.push(message);
      const action = message.params?.action;
      if (action === "clock") {
        reading += 1;
        queueMicrotask(() => reply({ sok: 1, id: message.id, result: { ts_us: 1_791_000_000_000_000 + reading, mono_ns: 5_000_000_000 + reading } }));
      } else if (action === "batch") {
        events.push(...message.params.events);
        queueMicrotask(() => {
          reply({ sok: 1, id: message.id, result: null });
          settle();
        });
      } else {
        throw new Error(`runtime.log requires the action clock or batch, found ${JSON.stringify(message.params)}`);
      }
      return true;
    },
  };
}
