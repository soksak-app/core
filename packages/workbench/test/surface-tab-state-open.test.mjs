import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { JSDOM } from "jsdom";
import { registerPlugin } from "../registry.js";
import { recordOrigin } from "../tab-reports.js";
import { openTabStates } from "../tab-state.js";

// The page draws the first plane before projects.initialise opens the tab state store; the test holds the open until the
// surface has started to mount.
const UNLOAD = { format: 1, maxBytes: 64 };
let store = null;
let opened;
const tried = new Promise((resolve) => { opened = resolve; });
mock.module("../projects.js", { namedExports: { active: () => null, tabStateStore: () => store, tabStatesReady: () => tried } });
mock.module("../environment.js", { namedExports: { pluginDiagnostics: async () => null } });
const reported = [];
globalThis.dispatchEvent = (event) => { reported.push(event.message); return true; };
registerPlugin({ id: "fixture-early", surface: () => null });
const { setSurfaceTextSize } = await import("../text-size.js");
setSurfaceTextSize(() => 1);
