/** Run a command in its own process group and report why it ended. */
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { killGroup } from "../../window-check/process-group.mjs";

export function runBounded(command, args, { timeout, cwd, stdout = "inherit", stderr = "inherit", signal, onSpawn } = {}) {
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("The command deadline must be positive");
  const started = performance.now();
  return new Promise((done) => {
    const parent = process.ppid;
    const env = { ...process.env };
    // A new test command must not inherit the outer Node runner's IPC context.
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", stdout, stderr], detached: true });
    let reason = "exit", error = null;
    // The group is ended again when the command exits, for the processes it left. A member that ended but is not yet reaped
    // stays in the group, and macOS refuses the signal to a group that holds only such members; killGroup judges that group
    // from the process table as ended, so the end of the command does not depend on when its members are reaped.
    const kill = () => {
      if (!child.pid) return;
      try { killGroup(child.pid); }
      catch (failure) { error = `${failure.code}: ${failure.message}`; }
    };
    const stop = (cause) => {
      if (reason !== "exit") return;
      reason = cause;
      kill();
    };
    const cancel = () => stop("cancelled");
    const handlers = ["SIGINT", "SIGTERM", "SIGHUP"].map((name) => {
      const handler = () => stop(`signal:${name}`);
      // Kill the command group before a caller's signal handler exits.
      process.prependListener(name, handler);
      return [name, handler];
    });
    const deadline = setTimeout(() => stop("deadline"), timeout);
    // There is no parent-exit event when the harness is killed outright.
    const orphaned = setInterval(() => { if (process.ppid !== parent) stop("orphaned"); }, 500);
    signal?.addEventListener("abort", cancel, { once: true });
    child.once("error", (failure) => { reason = "spawn-error"; error = `${failure.code}: ${failure.message}`; });
    child.once("exit", kill);
    child.once("close", (code, exitSignal) => {
      clearTimeout(deadline);
      clearInterval(orphaned);
      for (const [name, handler] of handlers) process.removeListener(name, handler);
      signal?.removeEventListener("abort", cancel);
      done({ code, signal: exitSignal, reason, error, elapsed: Math.round(performance.now() - started) });
    });
    if (signal?.aborted) cancel();
    onSpawn?.(child);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [ms, command, ...args] = process.argv.slice(2);
  try {
    const result = await runBounded(command, args, { timeout: Number(ms) });
    if (result.reason !== "exit" || result.error) console.error(`${result.reason}: ${result.error ?? result.signal ?? "command stopped"}`);
    process.exitCode = result.reason === "deadline" ? 124 : result.reason !== "exit" || result.error ? 125 : result.signal ? 128 : result.code;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 125;
  }
}
