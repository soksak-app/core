// The probe views of the window checks build their exposure port from the view bridge, and createExpose of @soksak/plugin-api takes
// that port: a status watch that the main page forwards sends the current value of the status as the view call changed (F353).
import assert from "node:assert/strict";
import test from "node:test";
import { createExpose } from "@soksak/plugin-api";

import { providerExposurePort } from "../fixtures/extension-probe/provider/ui/port.js";
import { probeExposurePort } from "../fixtures/memory-saver/unload-probe/ui/unload-probe.js";

for (const [name, port] of [["probeprovider", providerExposurePort], ["probeunload", probeExposurePort]]) {
  test(`the ${name} exposure port sends a watched status value through the changed call of the view bridge`, { timeout: 1000 }, async () => {
    const sent = [];
    let answer;
    let replied;
    const reply = new Promise((resolve) => { replied = resolve; });
    const bridge = {
      exposure: {
        register: async () => {},
        reply: async (id, payload) => { sent.push(["reply", id, payload]); replied(); },
        changed: async (status, value, version) => sent.push(["changed", status, value, version]),
      },
      runtime: { error: (where, text) => sent.push(["error", where, text]), native: { on: async (event, fn) => { answer = fn; return () => {}; } } },
    };
    const expose = createExpose(port(bridge), () => ({ status: [{ name: `${name}.state`, description: "probe state" }] }));
    await expose.status(`${name}.state`, () => 7, () => () => {});
    answer({ id: 1, method: "status.watch", params: { name: `${name}.state` } });
    await reply;
    assert.deepEqual(sent.filter(([kind]) => kind === "changed"), [["changed", `${name}.state`, 7, 1]]);
  });
}
