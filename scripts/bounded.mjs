/**
 * Run one command with a deadline, outliving neither it nor this script's parent.
 *
 *   node scripts/bounded.mjs <ms> <command> [args...]
 *
 * `node --test` spawns a process per file. A mutant that turns a loop in the
 * library into one that never ends leaves those spinning, and killing the
 * harness does not reach them: they are reparented and keep a core each. The run
 * goes in its own process group, and the group is killed when the deadline
 * passes, when a signal arrives, or when the harness that asked for the run is
 * gone.
 *
 * Exits with the command's code, or 124 when something above ended the run.
 */
import { spawn } from "node:child_process";

const [ms, command, ...args] = process.argv.slice(2);
const parent = process.ppid;
const child = spawn(command, args, { stdio: "ignore", detached: true });

const stop = () => {
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // The group is already gone.
  }
  process.exit(124);
};

const deadline = setTimeout(stop, Number(ms));
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, stop);
// A harness can be killed outright, with no signal it can act on. Nothing else
// would then end the run.
const orphaned = setInterval(() => {
  if (process.ppid !== parent) stop();
}, 500);

child.on("exit", (code, signal) => {
  clearTimeout(deadline);
  clearInterval(orphaned);
  process.exit(signal ? 124 : (code ?? 1));
});
