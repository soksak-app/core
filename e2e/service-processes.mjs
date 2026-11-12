// Reads the process table with which a window check counts the processes of a persistent sidecar service of its configuration
// (rasterServiceSnapshot of raster-probe.mjs). Sessions of other running apps are not touched.
import assert from "node:assert/strict";

/** The rows of a `ps -o pid=,ppid=,stat=,command=` table as {pid, parent, state, command}; a row of another form fails. */
export function processRows(text) {
  return text.trim().split("\n").filter(Boolean).map((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    assert.ok(match, `invalid process row: ${line}`);
    return { pid: Number(match[1]), parent: Number(match[2]), state: match[3], command: match[4] };
  });
}

/**
 * The rows of processRows whose executable lies inside one of the folders `roots`, the command starting with the folder and a
 * slash; an exited process that its parent has not reaped (state Z) runs no executable and is not counted.
 */
export function rowsRunningFrom(rows, roots) {
  return rows.filter((row) => !row.state.includes("Z") && roots.some((root) => row.command.startsWith(`${root}/`)));
}
