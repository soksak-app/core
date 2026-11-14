// Holds the pack of a fixture plugin for 30 seconds: the prepack script of pnpm pack runs it, so the step limit of the registry build ends the pack.
// It names itself in the file `held` of the plugin folder, which appears whole, so a test that waits for the file knows the pack is held.
import { renameSync, writeFileSync } from "node:fs";

writeFileSync("held.part", String(process.pid));
renameSync("held.part", "held");
await new Promise((done) => setTimeout(done, 30000));
