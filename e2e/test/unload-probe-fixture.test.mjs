import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { openView, turn } from "@soksak/plugin-api/testing";
import { startUnloadProbe } from "../fixtures/memory-saver/unload-probe/ui/unload-probe.js";

const CASES = new URL("../../docs/spec/cases/view-wire/", import.meta.url);

const manifestPath = fileURLToPath(new URL("../fixtures/memory-saver/unload-probe/plugin.json", import.meta.url));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

// The main page forwards a status request of the probe surface to the view (docs/spec/native-surfaces.md#view-surfaces, view
// exposure), so the view serves the declared status probeunload.location through its exposure. The probe is a tab view, so the
// case of its wire (docs/spec/cases/view-wire/unload-probe-fixture-location.json) records no section channel.
test("the unload probe serves its declared status through its exposure and follows the region state", { timeout: 5000 }, async () => {
  const declared = manifest.exposes.status.map((status) => status.name);
  const view = await openView("unload-probe-fixture-location", { cases: CASES, declarations: manifest.exposes,
    html: '<!doctype html><body><div id="document"></div></body>',
    layout: { width: 640, height: 400, rect: () => ({ left: 0, top: 0, right: 640, bottom: 400, width: 640, height: 400 }) },
    start: { surface: "tab-3", params: null, origin: { directory: null }, project: null, section: null } });
  await startUnloadProbe({ bridge: view.bridge, expose: view.expose, document: view.window.document });

  assert.deepEqual(view.registered("status"), declared);
  assert.deepEqual(await view.status("probeunload.location"), { url: "", loading: false, history: { entries: [], index: -1 }, restored: { url: "https://example.test/" } });
  await view.exposed("status.watch", { name: "probeunload.location" });
  const history = { entries: [{ url: "https://example.test/next", title: "" }], index: 0 };
  const state = (value) => view.deliverNotice("document-state", { document: "page", state: value });
  state({ url: "https://example.test/next", loading: false, history });
  await turn();
  await view.exposed("status.unwatch", { name: "probeunload.location" });
  state({ url: "https://example.test/later", loading: true, history });
  await turn();
  assert.deepEqual(view.changes("probeunload.location").at(-1), { url: "https://example.test/next", loading: false, history, restored: { url: "https://example.test/" } });
  assert.equal((await view.status("probeunload.location")).url, "https://example.test/later");
  assert.deepEqual(view.calls.filter(({ command }) => command === "tab.state.write").map(({ params }) => params),
    [{ url: "https://example.test/next" }, { url: "https://example.test/later" }]);
  await view.close();
});

// The document region of the probe is the element #document at the height of its view. Its percentage height resolves only against
// html and body of a definite height; at an auto height the region is placed with no height, and the view restart check that waits
// for a visibly placed region never ends.
test("the document region of the unload probe page fills the height of its view", () => {
  const page = readFileSync(new URL("../fixtures/memory-saver/unload-probe/ui/page.html", import.meta.url), "utf8");
  const rules = [...page.matchAll(/([^{}<>]+)\{([^}]*)\}/g)].map(([, selector, body]) => ({
    selectors: selector.split(",").map((item) => item.trim()), body: body.replace(/\s+/g, ""),
  }));
  for (const element of ["html", "body"]) {
    assert.ok(rules.some((rule) => rule.selectors.includes(element) && rule.body.includes("height:100%")),
      `${element} of the unload probe page has no definite height`);
  }
  assert.match(page, /<div id="document" style="height:100%">/);
});
