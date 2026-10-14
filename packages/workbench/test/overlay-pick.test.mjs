// The replies of modal documents that the host relays (docs/spec/native-host.md): a reply of a modal that the page does not
// show, or that has no receiver, is dropped and recorded as `page.overlay.dropped`, never dropped without a record.
import assert from "node:assert/strict";
import { mock, test } from "node:test";

const listeners = {};
const recorded = [];
mock.module("@soksak/runtime", { namedExports: { host: {
  on: (name, listener) => { listeners[name] = listener; return Promise.resolve(() => {}); },
  page: (path) => path,
  call: async () => {},
} } });
const real = await import("../page-log.js?real");
mock.module("../page-log.js", { namedExports: {
  ...real,
  emitEvent: (level, event, fields) => { recorded.push({ level, event, fields }); return true; },
} });
await import("../host.js");

test("a reply of a modal that the page does not show is recorded as page.overlay.dropped", () => {
  recorded.length = 0;
  listeners["overlay-pick"]({ id: "debug", key: "save-all", value: "" });
  assert.deepEqual(recorded, [{ level: "info", event: "page.overlay.dropped", fields: { id: "debug", shown: "", key: "save-all" } }]);
});
