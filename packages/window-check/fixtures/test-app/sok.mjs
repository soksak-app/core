#!/usr/bin/env node
// The `sok` of the registry tests: appends its arguments as one JSON line to the file beside it with the suffix .log, `registry build`
// writes an index and answers it, `registry use` answers the file URL of its index.
import { appendFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const args = process.argv.slice(2);
appendFileSync(`${fileURLToPath(import.meta.url)}.log`, `${JSON.stringify(args)}\n`);
if (args[0] === "registry" && args[1] === "build") {
  writeFileSync(`${args[2]}/index.json`, "{}");
  process.stdout.write(JSON.stringify({ index: `${args[2]}/index.json`, args }));
} else if (args[0] === "registry" && args[1] === "use") {
  process.stdout.write(JSON.stringify({ index: pathToFileURL(args[2]).href }));
} else {
  process.stdout.write("{}");
}
