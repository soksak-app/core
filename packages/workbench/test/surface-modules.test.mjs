import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { JSDOM } from "jsdom";
import { registerPlugin } from "../registry.js";
import { recordOrigin } from "../tab-reports.js";

// The diagnostics module is started by environment at registration and handed out as pluginDiagnostics. The consumer test replaces that boundary.
const diagnostics = { attach() {} };
mock.module("../environment.js", { namedExports: {
  pluginDiagnostics: async (id) => (id === "fixture-diagnostics" ? diagnostics : null),
} });

// The plugin below has no diagnostics module, like a release build.
for (const id of ["fixture", "fixture-integration"]) registerPlugin({ id, surface: () => null });
// In the app, the plane starts before the surfaces and sets the function that computes the text scale of a surface. Here every surface has scale 1.
const { setSurfaceTextSize } = await import("../text-size.js");
setSurfaceTextSize(() => 1);

let tracedInstances = 0;
async function tracedSurfaceModules(t, clock) {
  const records = [];
  t.mock.method(performance, "now", () => clock.now);
  t.mock.module("../performance.js", { exports: {
    timed: async (_name, answer) => answer(),
    trace: (event, fields) => { records.push({ event, ...fields }); },
    traceEnabled: () => true,
    setTraceEnabled: async () => {},
    reportTraceAtStart: async () => {},
  } });
  const { mountSurface } = await import(`../surface-modules.js?mount-trace-${tracedInstances++}`);
  return { records, mountSurface };
}
