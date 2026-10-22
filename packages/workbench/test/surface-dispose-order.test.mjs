import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { registerPlugin } from "../registry.js";
import { recordOrigin } from "../tab-reports.js";
import { setSurfaceTextSize } from "../text-size.js";

setSurfaceTextSize(() => 1);

// When a surface is removed, the workbench detaches the region of that surface before the dispose of the module. The dispose of the module ends the sidecar session,
// and the provider releases the transport image when it ends the session. If the session ends while the region is attached, the host tries to present an already sent frame
// as the released image and fails with notFound (F60). If the region is detached first, that frame is answered as stale.