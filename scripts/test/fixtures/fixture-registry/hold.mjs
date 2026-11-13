// Holds the pack of a fixture plugin for 30 seconds: the prepack script of pnpm pack runs it, so the step limit of the registry build ends the pack.
await new Promise((done) => setTimeout(done, 30000));
