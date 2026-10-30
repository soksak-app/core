// Reads the process table of the system for the checks that find the processes of a configuration among every process.
import { execFileSync } from "node:child_process";

/**
 * The output of `ps -ax -o <columns>` for every process of the system, one row per line. The output has no bound, because the commands
 * of other processes can exceed any fixed buffer, and a check reads every row to find the processes of its configuration.
 */
export function processTable(columns) {
  return execFileSync("ps", ["-ax", "-o", columns], { encoding: "utf8", maxBuffer: Infinity });
}
