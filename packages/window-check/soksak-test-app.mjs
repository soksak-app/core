#!/usr/bin/env node
// The bin `soksak-test-app` of @soksak/window-check: the window-check run of a plugin repository against the published core
// application (test-app.mjs, docs/spec/plugins.md#window-checks-of-a-plugin). It runs in the root of the plugin repository.
import { testAppCommand } from "./test-app.mjs";

testAppCommand(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
  process.stderr.write(`soksak-test-app: ${error.message}\n`);
  process.exitCode = 1;
});
