// Reads the process table with which a window check counts the processes of a persistent sidecar service of its configuration
// (rasterServiceSnapshot of raster-probe.mjs). Sessions of other running apps are not touched.
import { processes } from "@soksak/window-check/platform/platform.mjs";

/** The processes of the system as {pid, parent, state, command} (docs/spec/verification.md#process-table). */
export function processRows() {
  return processes({ command: true }).map(({ pid, ppid, state, command }) => ({ pid, parent: ppid, state, command }));
}

/**
 * The rows of processRows whose executable lies inside one of the folders `roots`, the command starting with the folder and a
 * slash; an exited process that its parent has not reaped (a zombie) runs no executable and is not counted.
 */
export function rowsRunningFrom(rows, roots) {
  return rows.filter((row) => row.state !== "zombie" && roots.some((root) => row.command.startsWith(`${root}/`)));
}
