// A process that ignores SIGTERM, writes its process id to the file of its first argument and then waits.
import { writeFileSync } from "node:fs";

process.on("SIGTERM", () => {});
writeFileSync(process.argv[2], String(process.pid));
setTimeout(() => {}, 2147483647);
