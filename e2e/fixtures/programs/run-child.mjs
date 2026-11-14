// A child test of the runner of the window checks (e2e/run.mjs): it writes the run metadata that it received to the file that
// SOKSAK_CHILD_MARKER names, which shows that the runner started it and what it forwarded.
import { writeFileSync } from "node:fs";

writeFileSync(process.env.SOKSAK_CHILD_MARKER, JSON.stringify({ id: process.env.SOKSAK_RUN_ID ?? null, folder: process.env.SOKSAK_RUN_FOLDER ?? null }));
