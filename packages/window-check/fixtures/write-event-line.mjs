// The writer of an application as another process: `append <file> <text>` appends the text to the file, and `create <file> <text>`
// writes it to a file that does not exist yet.
import { appendFileSync, writeFileSync } from "node:fs";

const [mode, file, text] = process.argv.slice(2);
if (mode === "append") appendFileSync(file, text);
else if (mode === "create") writeFileSync(file, text);
else throw new Error(`write-event-line: the mode is append or create, not ${mode}`);
