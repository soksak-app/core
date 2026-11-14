// A process that starts ignores-term.mjs with the file of its first argument and then waits.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

spawn(process.execPath, [fileURLToPath(new URL("ignores-term.mjs", import.meta.url)), process.argv[2]], { stdio: "ignore" });
setTimeout(() => {}, 2147483647);
