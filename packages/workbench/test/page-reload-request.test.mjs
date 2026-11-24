// A page reloads only through the host (docs/spec/native-host.md#page-reload): a page that applies a plugin change asks the host with
// pageReload and the operation of the change, and the page-reload event of the host names the cause that the page records.
import assert from "node:assert/strict";
import { test } from "node:test";
import { selectPageWire } from "@soksak/runtime";

test("a page that applies a plugin change asks the host to reload it with the operation of the change", async () => {
  // The case selects the host of the page before the host module is imported, because the page reads the host when it is imported.
  const wire = selectPageWire("page-reload-request");
  const { requestPageReload } = await import("../host.js");
  assert.equal(await requestPageReload("plugins-changed"), null);
  wire.finish();
});

test("the page-reload event of the host names the cause of the reload, and an event without a cause is refused", async () => {
  const { pageReloadCause } = await import("../host.js");
  assert.equal(pageReloadCause({ cause: "host.window.reload" }), "host.window.reload");
  assert.throws(() => pageReloadCause({}), /the page-reload event names no cause: \{\}/);
  assert.throws(() => pageReloadCause(undefined), /the page-reload event names no cause: undefined/);
});

test("the apply of a plugin change asks the host for the reload and never reloads the page by itself", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../core-exposure.js", import.meta.url), "utf8");
  assert.match(source, /reload: \(cause\) => whenRepliesSent\(\)\.then\(\(\) => requestPageReload\(cause\)\)/);
  const host = await readFile(new URL("../host.js", import.meta.url), "utf8");
  assert.doesNotMatch(host, /export function reloadPage/, "only the page-reload event of the host reloads the page");
});
