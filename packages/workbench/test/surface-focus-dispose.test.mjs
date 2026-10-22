import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { registerPlugin } from "../registry.js";
import { recordOrigin } from "../tab-reports.js";
import { setSurfaceTextSize } from "../text-size.js";

setSurfaceTextSize(() => 1);

// After a render, the surface focus waits for the module preparation and the host presentation. If the tab closes in between and the surface is released, the test does not call the
// focus of the released module and answers that focus was not given. The drawing region of a released module refuses focus (F91).