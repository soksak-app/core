import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { registerPlugin } from "../registry.js";
import { recordOrigin } from "../tab-reports.js";
import { setSurfaceTextSize } from "../text-size.js";

setSurfaceTextSize(() => 1);

// Closing a tab removes its surface at once, also while its module has not finished mounting; a mount that ends later
// disposes its module (docs/spec/plugins.md#surface-module-ownership).