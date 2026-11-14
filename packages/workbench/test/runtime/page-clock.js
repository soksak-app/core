// The clock of the page for workbench tests: its instants are the data that a test gives. `now()` is the reading, which stays where
// it is until `advance(ms)` moves it, and `after(callback, ms)` runs the callback when the readings reach the instant `ms` later. A
// test that judges a report that depends on elapsed time moves the reading; the run time of the test does not move it.
export function createPageClock() {
  let reading = 0;
  let waiting = [];
  return {
    now: () => reading,
    after(callback, ms) {
      waiting.push({ at: reading + ms, callback });
    },
    /** Moves the reading by `ms` and runs the callbacks whose instant has been reached, in the order of their instants. */
    advance(ms) {
      reading += ms;
      const due = waiting.filter(({ at }) => at <= reading).sort((a, b) => a.at - b.at);
      waiting = waiting.filter(({ at }) => at > reading);
      for (const { callback } of due) callback();
    },
  };
}
