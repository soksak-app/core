/** Run a command in its own process group and report why it ended. */
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { named, terminateGroup } from "@soksak/window-check/process-group.mjs";

export function runBounded(command, args, { timeout, cwd, stdout = "inherit", stderr = "inherit", signal, onSpawn } = {}) {
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("The command deadline must be positive");
  const started = performance.now();
  return new Promise((done) => {
    const parent = process.ppid;
    const env = { ...process.env };
    // A new test command must not inherit the outer Node runner's IPC context.
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", stdout, stderr], detached: true });
    let reason = "exit", error = null, kill = null, ending = null, ended = null;
    const record = (failure) => { error = `${failure.code}: ${failure.message}`; };
    // The group gets SIGTERM at the first stop, and SIGKILL when it still runs after the grace of terminateGroup or when the command
    // exits, for the processes it left. A member that ended but is not yet reaped stays in the group, and macOS refuses the signal to a
    // group that holds only such members; signalGroup judges that group from the process table as ended, so the end of the command does
    // not depend on when its members are reaped.
    const exited = new Promise((resolve) => child.once("exit", resolve));
    const end = () => {
      if (!child.pid || ending) return;
      try {
        ending = terminateGroup(child.pid, { exited, report: (killed) => { kill ??= killed; } });
        ended = ending.ended.catch(record);
      } catch (failure) { record(failure); }
    };
    // A second cancellation is the event that the first stop did not end the command, so it sends SIGKILL without the grace. The
    // deadline and the end of the parent stop the command only once.
    const stop = (cause, again) => {
      if (reason === "exit") {
        reason = cause;
        end();
        return;
      }
      if (!again) return;
      end();
      try { ending?.kill("second-cancellation"); } catch (failure) { record(failure); }
    };
    const cancel = () => stop("cancelled", true);
    const handlers = ["SIGINT", "SIGTERM", "SIGHUP"].map((name) => {
      const handler = () => stop(`signal:${name}`, true);
      // End the command group before a caller's signal handler exits.
      process.prependListener(name, handler);
      return [name, handler];
    });
    const deadline = setTimeout(() => stop("deadline", false), timeout);
    // Node has no event for the end of the parent process, and a harness that is killed outright closes no stream that this process
    // reads, so the parent identity is read every 500 ms: it changes when the parent ends and the process is given to another parent.
    const orphaned = setInterval(() => { if (process.ppid !== parent) stop("orphaned", false); }, 500);
    signal?.addEventListener("abort", cancel, { once: true });
    child.once("error", (failure) => { reason = "spawn-error"; error = `${failure.code}: ${failure.message}`; });
    child.once("exit", end);
    // The result returns after the last signal of terminateGroup at the exit of the command.
    child.once("close", async (code, exitSignal) => {
      clearTimeout(deadline);
      clearInterval(orphaned);
      await ended;
      for (const [name, handler] of handlers) process.removeListener(name, handler);
      signal?.removeEventListener("abort", cancel);
      done({ code, signal: exitSignal, reason, error, kill, elapsed: Math.round(performance.now() - started) });
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
    if (result.kill) console.error(`SIGKILL (${result.kill.reason}): ${named(result.kill.running)}`);
    process.exitCode = result.reason === "deadline" ? 124 : result.reason !== "exit" || result.error ? 125 : result.signal ? 128 : result.code;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 125;
  }
}
