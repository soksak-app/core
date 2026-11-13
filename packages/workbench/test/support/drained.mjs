// The end of the microtask queue. The event loop runs every queued microtask, and every microtask that those queue in turn, before
// it runs the next task, so a task queued now runs after all of them. A negative check of work that a module runs in microtasks
// waits for this end: after it, that work can no longer cause what the check rejects. Work that waits for a timer or for input
// and output is not covered, and a check of such work waits for its own event.
export const drained = () => new Promise((resolve) => setImmediate(resolve));
