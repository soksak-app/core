import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { registerPlugin } from "../registry.js";
import { recordOrigin } from "../tab-reports.js";
import { setSurfaceTextSize } from "../text-size.js";

setSurfaceTextSize(() => 1);

// Every core command waits for the composition declaration of the visible native surfaces before it replies. A surface whose mount failed does not declare one,
// so that wait must end with the mount error.