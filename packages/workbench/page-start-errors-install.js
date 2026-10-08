// The first import of the start document: it installs the start error handler before any other module loads
// (docs/spec/native-host.md#page-start). A page without the application host writes to its console.
import { host } from "@soksak/runtime";
import { installPageStartErrors } from "./page-start-errors.js";

export const pageStart = installPageStartErrors({
  target: globalThis,
  report: (line) => (host ? host.call("report", line) : console.error(line)),
});
