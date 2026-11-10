// Waits for a state of the files of a folder: the state is read once after the change watch of the folder is active and
// again at each change, so no change after the wait starts is missed.
//
// The watch is @parcel/watcher and not node:fs watch. node:fs watch returns before the watch is active: on macOS libuv
// starts the FSEvents stream of a folder on its own thread after uv_fs_event_start returned (uv__fsevents_init signals
// the run loop thread, which calls FSEventStreamStart with kFSEventStreamEventIdSinceNow), and registers the kqueue
// filter of a file at the next poll of the loop; node:fs watch gives no signal when either is active, so a change between
// the call and that moment has no notification and a read made before it does not see the change. The promise of
// @parcel/watcher `subscribe` resolves after FSEventStreamStart returned, so a read after it sees every earlier change and
// every later change notifies; its file events also report content appended to a file of the folder.
//
// The workspace builds @parcel/watcher 2.6.0 from its source with patches/@parcel__watcher@2.6.0.patch instead of using
// its prebuilt binaries. The FSEvents backend of 2.6.0 assigns the tree of a new watch only after FSEventStreamStart
// returned, while the run loop thread already runs the callback of the started stream, so a change that arrives during
// the start ends the process with SIGSEGV in DirTree::remove or DirTree::add; the patch assigns the tree before the stream
// is scheduled (test/folder-wait-stream-start.test.mjs). Watcher::notify of 2.6.0 wakes the callbacks only for a list that
// holds events, so a report of lost events in a batch that adds no event stays unseen until a later event; the patch wakes
// them for the report too (test/folder-wait-drop.test.mjs).
import { subscribe } from "@parcel/watcher";

// FSEvents marks a batch after events were lost, and the FSEvents backend of @parcel/watcher passes that to the callback as
// an error whose message ends with this text, in the forms for the client, the kernel and too many events, while its
// stream keeps running. The mark asks the client to scan, and a wait uses no event: the read at the report is that scan and
// sees the changes of the lost events, so the report is a change and nothing is lost. The message is the only
// distinction, because the binding gives the callback an Error with no other field; @parcel/watcher is pinned, and
// test/folder-wait-drop.test.mjs fails when the text changes. Every other error ends the watch.
const RESCAN_REPORT = / File system must be re-scanned\.$/;

/**
 * Resolves with the first value other than undefined that `read()` returns. `read` runs once after the watch of `folder`
 * (recursive) is active and again at each change and at each report of lost events (RESCAN_REPORT); an error that `read`
 * throws or any other error that the watch reports rejects the wait. An abort of `signal`, a process or a connection whose
 * state the wait awaits that ends first, reads the state once more and rejects the wait with its reason when it is absent. The wait has no time limit: its state, an error,
 * or the abort ends it, and the limit of the test runner bounds a wait that none of them ends. The wait settles first and the
 * watch ends after it; endWatches reports an error of a watch end.
 */
export function untilFolderState(folder, read, options = {}, ...rest) {
  if (typeof options !== "object" || options === null || rest.length > 0 || Object.hasOwn(options, "timeout")) {
    return Promise.reject(new TypeError("untilFolderState takes no timeout: a wait ends by its state, an error of its watch or an abort of its signal"));
  }
  const { signal } = options;
  return new Promise((resolve, reject) => {
    let active = false;
    let finished = false;
    // `outcome` (resolve or reject) settles the wait with `value` at once, and the watch ends after it. A watch that did not
    // start ends when its start settles; an error of its end goes to endWatches.
    const finish = (outcome, value) => {
      if (finished) return;
      finished = true;
      outcome(value);
      const end = { folder };
      // default: a watch whose start failed has nothing to end, and the error of its start rejected the wait.
      ending.set(end, subscribed.then((subscription) => subscription.unsubscribe(), () => undefined).then(
        () => { ending.delete(end); },
        (error) => { ending.delete(end); endErrors.push(new Error(`the watch of ${folder} failed to end: ${error.message}`, { cause: error })); }));
    };
    const check = () => {
      if (finished || !active) return;
      let value;
      try {
        value = read();
      } catch (error) {
        finish(reject, error);
        return;
      }
      if (value !== undefined) finish(resolve, value);
    };
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    // The abort reads the state once more, also before the watch is active, and judges it: a watch that becomes active or
    // reports a change only later at a high load leaves the state in the folder unseen until then.
    signal?.addEventListener("abort", () => {
      if (finished) return;
      let value;
      try {
        value = read();
      } catch (error) {
        finish(reject, error);
        return;
      }
      finish(value !== undefined ? resolve : reject, value !== undefined ? value : signal.reason);
    }, { once: true });
    // A new watch of a folder starts after the ends of the earlier watches of that folder answered: @parcel/watcher ends a
    // watch on its worker thread after the call returned (UnsubscribeRunner::execute), and a watch of the same folder that
    // starts while that end runs can receive no change of the folder.
    const earlier = [...ending].filter(([end]) => end.folder === folder).map(([, ended]) => ended);
    const start = () => subscribe(folder, (error) => (error && !RESCAN_REPORT.test(error.message) ? finish(reject, error) : check()));
    const subscribed = earlier.length > 0 ? Promise.all(earlier).then(start) : start();
    subscribed.then(() => {
      active = true;
      check();
    }, (error) => finish(reject, error));
  });
}

/** An AbortSignal that aborts with the value or the reason of `ended` when it settles, such as `client.ended` of a connection. */
export function endSignal(ended) {
  const controller = new AbortController();
  ended.then((cause) => controller.abort(cause), (cause) => controller.abort(cause));
  return controller.signal;
}

// The watch ends that have not finished, each with the promise of its end, and the errors of the watch ends since the last report.
const ending = new Map();
const endErrors = [];

/**
 * Waits until every watch end has finished, including a watch end that starts while it waits, and returns the errors of the watch
 * ends. A check calls it when it ends, because a watch that a wait of the check started ends with that check. It has no time limit:
 * each watch end ends by the answer of its unsubscription.
 */
export async function endWatches(...rest) {
  if (rest.length > 0) throw new TypeError("endWatches takes no limit: each watch end ends by the answer of its unsubscription");
  while (ending.size) await Promise.all(ending.values());
  return endErrors.splice(0);
}
