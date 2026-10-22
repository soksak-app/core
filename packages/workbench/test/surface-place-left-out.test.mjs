import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { registerPlugin } from "../registry.js";
import { recordOrigin } from "../tab-reports.js";
import { setSurfaceTextSize } from "../text-size.js";

setSurfaceTextSize(() => 1);

// A place that leaves a surface out removes the composition of that surface in the host (docs/spec/native-surfaces.md), and
// the page releases the surface only after the place replies. A geometry change in between, such as the layout change that
// the place itself makes, must not send a composition place of that surface, which the host refuses with
// `surface "<id>" has no composition declaration`. A failed place resumes the composition, which places its geometry again.