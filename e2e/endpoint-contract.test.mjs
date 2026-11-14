// Replays the endpoint contract cases of docs/spec/cases/endpoint (docs/spec/endpoint.md#checks) against each running application. A case
// with replay true is sent through the endpoint of the application named by <config-dir>/endpoint.json: its frames of the client are
// sent in order, and each frame of the host must equal the frame of the case, with each variable bound to the value that the
// application chose and checked against its declared type. A case with replay false is reported as skipped with its reason.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { listCases, readCase } from "@soksak/client/testing";
import { declaredNames, replay } from "./endpoint-replay.mjs";

// The methods whose params.name names an entry of the exposure of the application.
const NAMED_METHODS = new Set(["status.get", "status.watch", "status.unwatch", "command.run", "element.rect", "element.act"]);

// The names that a case sends to a named method, with whether the case expects an error for that request.
function namedRequests(kase) {
  const replies = new Map();
  for (const step of kase.steps) if (step.reply) replies.set(step.reply.id, step.reply);
  const named = [];
  for (const step of kase.steps) {
    const frame = step.send;
    if (!frame || "raw_hex" in frame || !NAMED_METHODS.has(frame.method)) continue;
    const reply = replies.get(frame.id);
    named.push({ name: frame.params?.name, failed: reply === undefined || "error" in reply });
  }
  return named;
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: the application answers every replayable endpoint contract case`, { timeout: 600000 }, async (t) => {
    const s = await open(t, app);
    const { address } = JSON.parse(readFileSync(join(app.configDir, "endpoint.json"), "utf8"));
    const declared = await declaredNames(address);
    for (const name of listCases()) {
      const kase = await readCase(name);
      await t.test(name, { timeout: 30000, skip: kase.replay ? false : kase.reason }, async () => {
        const undeclared = namedRequests(kase)
          .filter((request) => !request.failed && !declared.has(request.name))
          .map((request) => request.name);
        assert.deepEqual(undeclared, [], "the case names entries that the application does not declare");
        const { problems } = await replay(s, kase, address);
        assert.deepEqual(problems, [], problems.join("\n"));
      });
    }
  });
}
