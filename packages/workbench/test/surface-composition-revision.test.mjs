import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { registerPlugin } from "../registry.js";
import { recordOrigin } from "../tab-reports.js";
import { setSurfaceTextSize } from "../text-size.js";

setSurfaceTextSize(() => 1);

// When a surface released in the same document is mounted again with the same id, the layout of the new composition must send a revision larger than the earlier layout of that
// surface. The host requires the revision to grow for each surface, and clears that value only when the surface is destroyed or the document changes.