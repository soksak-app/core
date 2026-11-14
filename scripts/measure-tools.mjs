// The real tools and the clock of the measurements (scripts/measure-app-usage.mjs, scripts/footprints.mjs): the run of a tool and the
// waits. A wait is a function of instants (`remainingMs`): production reads the clock, waits the milliseconds that the function decides and
// reads the clock again, and a test judges the decision with the instants that it gives.
import { execFile } from "node:child_process";

/** Waits ms milliseconds on the timer of the process. */
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The instant of the clock of the measurements, in milliseconds. The instants that `remainingMs` takes are values of this clock. */
export const instant = () => performance.now();

/**
 * The milliseconds that are left of a wait of `ms` that began at the instant `since`, at the instant `now`: 0 when the wait is over.
 * Both instants are values of one clock in milliseconds.
 */
export function remainingMs({ since, now, ms }) {
  for (const [name, value] of [["since", since], ["now", now], ["ms", ms]]) {
    if (!Number.isFinite(value)) throw new TypeError(`remainingMs needs a number of milliseconds for ${name}, not ${JSON.stringify(value)}`);
  }
  if (ms < 0) throw new RangeError(`remainingMs needs a wait of at least 0 ms, not ${ms}`);
  if (now < since) throw new RangeError(`the instant ${now} ms is before the instant ${since} ms that the wait began`);
  return Math.max(0, ms - (now - since));
}

/** Runs a command and resolves to the process result {status, stdout, stderr, error}: error is set only for a command that does not run. */
export function execute(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ status: error ? error.code : 0, stdout, stderr, error: error && typeof error.code !== "number" ? error : undefined });
    });
  });
}
