// The first import of the start document: it installs the start error handler before any other module loads
// (docs/spec/native-host.md#page-start). A page without the application host writes to its console.
import { captureConsole, reportRecord } from "./page-log.js";
import { installPageStartErrors } from "./page-start-errors.js";

// What the page writes to its console is recorded from the first import on (docs/spec/diagnostics.md#forms).
captureConsole(console);

export const pageStart = installPageStartErrors({
  target: globalThis,
  report: (line) => reportRecord("error", line),
});
