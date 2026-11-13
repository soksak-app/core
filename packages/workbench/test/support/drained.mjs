// The end of the microtask queue. The event loop runs every queued microtask, and every microtask that those queue in turn, before
// it runs the next task, so a task queued now runs after all of them. A negative check of work that a module runs in microtasks
// waits for this end: while the work under check waits for the step that the check holds, the end of the microtask queue is the
// only event that follows what a missing wait would have caused, so no event of the module can replace it. Work that waits for a
// timer or for input and output is not covered, and a check of such work waits for its own event.
//
// The function is the setImmediate of Node, read when this module loads: a check that mocks setImmediate through mock.timers
// runs a mocked immediate inside its tick, before the microtasks that the work queued, so drained fails in such a check instead
// of ending too early.
const immediate = globalThis.setImmediate;

export const drained = () => {
  if (globalThis.setImmediate !== immediate) {
    return Promise.reject(new Error("drained: setImmediate is mocked, so its end comes before the microtasks of the work"));
  }
  return new Promise((resolve) => immediate(resolve));
};
