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
 * throws or any other error that the watch reports rejects the wait. At the deadline `timeout` (ms) `read` runs once more,
 * and the wait rejects with the error that `expired()` returns when it returns undefined. An abort of `signal` rejects the
 * wait with its reason, as a process whose state the wait awaits that ends first. The deadline bounds the wait also when
 * the watch does not start or does not end: at a high load of the file system events service the start and the end of a
 * watch can take minutes. The wait settles first and the watch ends after it; endWatches reports a watch end that has not
 * finished and an error of a watch end.
 */
export function untilFolderState(folder, read, timeout, expired, signal) {
  return new Promise((resolve, reject) => {
    let active = false;
    let finished = false;
    // `outcome` (resolve or reject) settles the wait with `value` at once, and the watch ends after it. A watch that did not
    // start ends when its start settles; an error of its end goes to endWatches.
    const finish = (outcome, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      outcome(value);
      const end = { folder, reported: false };
      // default: a watch whose start failed has nothing to end, and the error of its start rejected the wait.
      ending.set(end, subscribed.then((subscription) => subscription.unsubscribe(), () => undefined).then(
        () => { ending.delete(end); },
        (error) => { ending.delete(end); endErrors.push(new Error(`the watch of ${folder} failed to end: ${error.message}`, { cause: error })); }));
    };
    const check = (atDeadline = false) => {
      if (finished || (!active && !atDeadline)) return;
      let value;
      try {
        value = read();
      } catch (error) {
        finish(reject, error);
        return;
      }
      if (value !== undefined) finish(resolve, value);
      else if (atDeadline) finish(reject, expired());
    };
    // The deadline bounds the wait, and the result is judged by the state that `read` returns at it: at a high load the
    // watch can become active or deliver a change after the deadline, so the state is read once more there.
    const timer = setTimeout(() => check(true), timeout);
    signal?.addEventListener("abort", () => finish(reject, signal.reason), { once: true });
    const subscribed = subscribe(folder, (error) => (error && !RESCAN_REPORT.test(error.message) ? finish(reject, error) : check()));
    subscribed.then(() => {
      active = true;
      check();
    }, (error) => finish(reject, error));
  });
}

// The watch ends that have not finished, each with the promise of its end, and the errors of the watch ends since the last report.
const ending = new Map();
const endErrors = [];

/**
 * Waits until every watch end has finished or `limit` (ms) has passed, and returns the failures of the watch ends: an
 * error for each watch that has not ended by then, reported once per watch, and each error of a watch end. A check calls
 * it when it ends, because a watch that a wait of the check started ends with that check.
 */
export async function endWatches(limit) {
  let expired = null;
  if (ending.size) {
    let timer;
    const bound = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`the watch ends did not finish within ${limit} ms`)), limit);
    });
    expired = await Promise.race([Promise.all(ending.values()), bound]).then(() => null, (error) => error);
    clearTimeout(timer);
  }
  const failures = endErrors.splice(0);
  for (const end of ending.keys()) {
    if (end.reported) continue;
    end.reported = true;
    failures.push(new Error(`the watch of ${end.folder} did not end within ${limit} ms after its wait`, { cause: expired }));
  }
  return failures;
}
