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
import { subscribe } from "@parcel/watcher";

/**
 * Resolves with the first value other than undefined that `read()` returns. `read` runs once after the watch of `folder`
 * (recursive) is active and again at each change; an error that `read` throws or that the watch reports rejects the
 * wait. At the deadline `timeout` (ms) the wait rejects with the error that `expired()` returns. The watch ends before
 * the wait settles, and an error of its end rejects the wait.
 */
export function untilFolderState(folder, read, timeout, expired) {
  return new Promise((resolve, reject) => {
    let active = false;
    let finished = false;
    // `settle` resolves or rejects the wait after the watch ended; a watch that did not start rejects it with its own
    // error, and an error of the end of the watch rejects it.
    const finish = (settle) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      subscribed.then((subscription) => subscription.unsubscribe().then(settle), reject).catch(reject);
    };
    const check = () => {
      if (finished || !active) return;
      let value;
      try {
        value = read();
      } catch (error) {
        finish(() => reject(error));
        return;
      }
      if (value !== undefined) finish(() => resolve(value));
    };
    // The deadline bounds the wait; the result is judged by the state that `read` returns.
    const timer = setTimeout(() => finish(() => reject(expired())), timeout);
    const subscribed = subscribe(folder, (error) => (error ? finish(() => reject(error)) : check()));
    subscribed.then(() => {
      active = true;
      check();
    }, (error) => finish(() => reject(error)));
  });
}
