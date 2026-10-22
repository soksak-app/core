import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { registerPlugin } from "../registry.js";
import { recordOrigin } from "../tab-reports.js";
import { setSurfaceTextSize } from "../text-size.js";

setSurfaceTextSize(() => 1);

// A dom composition is declared by plugin.json and has no native region, so its module has no reason to create a
// composition. A core command waits for the declared composition of each surface it names; for a dom surface that
// wait ends when the module has mounted (docs/spec/surface-composition.md#declaration).